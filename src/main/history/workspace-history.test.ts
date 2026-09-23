import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { AgentSession, ExtensionAPI, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import { WorkspaceHistory } from "./workspace-history.js";

const temporaryPaths: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

interface CapturedCheckpoint {
  commit: string;
}

type ExtensionHandler = (event: { message?: { role: string }; prompt?: string }, context: ExtensionContext) => Promise<void> | void;

function historyExtensionHarness(history: WorkspaceHistory, entries: SessionEntry[], cwd: string) {
  const handlers = new Map<string, ExtensionHandler>();
  const turnRecords: unknown[] = [];
  const pi = {
    on: (name: string, handler: ExtensionHandler) => handlers.set(name, handler),
    appendEntry: (customType: string, record: unknown) => {
      if (customType === "pi-ecode.workspace-turn") turnRecords.push(record);
      return "turn-entry";
    },
  } as unknown as ExtensionAPI;
  const extension = history.asExtension();
  void (typeof extension === "function" ? extension(pi) : extension.factory(pi));
  const context = {
    cwd,
    sessionManager: {
      getSessionId: () => "test-session",
      getBranch: () => entries,
    },
  } as unknown as ExtensionContext;
  return { handlers, turnRecords, context };
}

function fakeSession(cwd: string, entries: SessionEntry[], captured: CapturedCheckpoint[], leafId = "current-leaf"): AgentSession {
  const session = {
    sessionId: "test-session",
    waitForIdle: async () => undefined,
    navigateTree: async () => ({ cancelled: false }),
    sessionManager: {
      getCwd: () => cwd,
      getSessionId: () => "test-session",
      getBranch: () => entries,
      getLeafId: () => leafId,
      getEntry: () => undefined,
      appendCustomEntry: (type: string, data: unknown) => {
        if (typeof data === "object" && data !== null && "commit" in data && typeof data.commit === "string") {
          captured.push({ commit: data.commit });
        }
        if (type === "pi-ecode.workspace-turn") {
          entries.push({
            type: "custom",
            id: `turn-${entries.length}`,
            parentId: entries.at(-1)?.id ?? null,
            timestamp: new Date().toISOString(),
            customType: type,
            data,
          } as SessionEntry);
        }
        return "checkpoint-entry";
      },
    },
  };
  return session as unknown as AgentSession;
}

const execFileAsync = promisify(execFile);

// 升级前影子仓库的 ignore 列表：没有 .codegraph/，索引会被 git add 进历史。
const LEGACY_EXCLUDES = [".git/", ".pi/workspace-history/", "node_modules/", "out/"];

async function git(cwd: string, args: string[]): Promise<string> {
  const result = await execFileAsync("git", args, { cwd, windowsHide: true });
  return result.stdout;
}

/**
 * 影子仓库布局（<storage>/<workspaceId>/<sessionId>/repo/.git）由 WorkspaceHistory 私有推导，
 * 测试通过列目录取得，避免在这里复制哈希算法。
 */
async function shadowRepository(storage: string, workspace: string): Promise<{ gitDir: string; args: string[] }> {
  const [workspaceId] = await readdir(storage);
  const gitDir = join(storage, workspaceId ?? "", "test-session", "repo", ".git");
  return { gitDir, args: [`--git-dir=${gitDir}`, `--work-tree=${workspace}`] };
}

/** 把已经建立的影子仓库改回升级前的状态：ignore 不含 .codegraph/，索引已被提交进历史。 */
async function commitLegacyCodegraphIndex(storage: string, workspace: string): Promise<string> {
  const { gitDir, args } = await shadowRepository(storage, workspace);
  await writeFile(join(gitDir, "info", "exclude"), `${LEGACY_EXCLUDES.join("\n")}\n`, "utf8");
  await git(workspace, [...args, "add", "-A", "--", "."]);
  await git(workspace, [...args, "commit", "--no-gpg-sign", "-m", "legacy tracked codegraph index"]);
  return (await git(workspace, [...args, "rev-parse", "HEAD"])).trim();
}

/**
 * 构造升级前的旧会话现场：影子仓库里索引已被提交进历史，并且已经存在一条 turn 记录。
 * 此时用户没有做任何真实修改，也没有建过 checkpoint。
 */
async function seedLegacyTurn(
  history: WorkspaceHistory,
  storage: string,
  workspace: string,
  turnPrompt: string,
): Promise<{ session: AgentSession; beforeCommit: string; afterCommit: string }> {
  await writeFile(join(workspace, "app.txt"), "before\n", "utf8");
  await mkdir(join(workspace, ".codegraph"), { recursive: true });
  await writeFile(join(workspace, ".codegraph", "codegraph.db"), "old-index\n", "utf8");
  await history.captureSourceRevision(fakeSession(workspace, [], []));
  const beforeCommit = await commitLegacyCodegraphIndex(storage, workspace);
  await writeFile(join(workspace, "app.txt"), "after\n", "utf8");
  const afterCommit = await commitLegacyCodegraphIndex(storage, workspace);
  const turnEntry = {
    type: "custom",
    id: "turn-entry",
    parentId: null,
    timestamp: new Date().toISOString(),
    customType: "pi-ecode.workspace-turn",
    data: {
      version: 1,
      beforeCommit,
      afterCommit,
      userEntryId: "user-entry",
      assistantEntryId: "assistant-entry",
      prompt: turnPrompt,
      createdAt: new Date().toISOString(),
    },
  } satisfies SessionEntry;
  return { session: fakeSession(workspace, [turnEntry], []), beforeCommit, afterCommit };
}

/**
 * 构造“用户显式取消忽略 CodeGraph 索引”的工作区现场。
 * 影子仓库的 info/exclude 忽略整个 `.codegraph/` 目录，而 Git 不会下降扫描被忽略的父目录：
 * 必须先 `!.codegraph/` 把父目录重新纳入扫描，再取消忽略文件本身，索引才真正处于未忽略状态。
 */
async function writeNegatedCodegraphFixture(workspace: string): Promise<void> {
  await writeFile(join(workspace, "app.txt"), "one\n", "utf8");
  await writeFile(join(workspace, ".gitignore"), "!.codegraph/\n!.codegraph/codegraph.db\n", "utf8");
  await mkdir(join(workspace, ".codegraph"), { recursive: true });
  await writeFile(join(workspace, ".codegraph", "codegraph.db"), "index-a\n", "utf8");
}

describe("WorkspaceHistory", () => {
  it("coalesces repeated checkpoint requests for the same session", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "pi-ecode-coalesced-workspace-"));
    const storage = await mkdtemp(join(tmpdir(), "pi-ecode-coalesced-history-"));
    temporaryPaths.push(workspace, storage);
    const history = new WorkspaceHistory(storage);
    const captured: CapturedCheckpoint[] = [];
    await writeFile(join(workspace, "app.txt"), "content\n", "utf8");
    const session = fakeSession(workspace, [], captured);

    const operations = Array.from({ length: 5 }, () => history.checkpoint(session, "rapid click"));
    expect(new Set(operations).size).toBe(1);
    const results = await Promise.all(operations);

    expect(results.every((result) => result.message === "Checkpoint saved: rapid click")).toBe(true);
    expect(captured).toHaveLength(1);
    expect((await history.getState(session)).isBusy).toBe(false);
  });

  it("captures a stable source tree revision while ignoring build output", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "pi-ecode-revision-workspace-"));
    const storage = await mkdtemp(join(tmpdir(), "pi-ecode-revision-history-"));
    temporaryPaths.push(workspace, storage);
    const history = new WorkspaceHistory(storage);
    const session = fakeSession(workspace, [], []);
    await writeFile(join(workspace, "app.txt"), "one\n", "utf8");

    const first = await history.captureSourceRevision(session);
    await writeFile(join(workspace, "app.txt"), "two\n", "utf8");
    const changed = await history.captureSourceRevision(session);
    await mkdir(join(workspace, "out"), { recursive: true });
    await writeFile(join(workspace, "out", "bundle.js"), "generated\n", "utf8");
    const ignored = await history.captureSourceRevision(session);

    expect(changed).not.toBe(first);
    expect(ignored).toBe(changed);
  });

  it("binds history after the current user message reaches the session branch", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "pi-ecode-turn-boundary-"));
    const storage = await mkdtemp(join(tmpdir(), "pi-ecode-history-boundary-"));
    temporaryPaths.push(workspace, storage);
    await writeFile(join(workspace, "app.txt"), "before\n", "utf8");
    const history = new WorkspaceHistory(storage);
    const entries = [{
      type: "message",
      id: "previous-user",
      parentId: null,
      timestamp: new Date().toISOString(),
      message: { role: "user", content: [{ type: "image", data: "old-image", mimeType: "image/png" }], timestamp: 1 },
    }] as SessionEntry[];
    const harness = historyExtensionHarness(history, entries, workspace);

    await harness.handlers.get("before_agent_start")?.({ prompt: "current prompt" }, harness.context);
    // Pi invokes extension message_end handlers before persisting that message to the session branch.
    await harness.handlers.get("message_end")?.({ message: { role: "user" } }, harness.context);
    entries.push({
      type: "message",
      id: "current-user",
      parentId: "previous-user",
      timestamp: new Date().toISOString(),
      message: { role: "user", content: "current prompt", timestamp: 2 },
    } as SessionEntry);
    entries.push({
      type: "message",
      id: "assistant-result",
      parentId: "current-user",
      timestamp: new Date().toISOString(),
      message: { role: "assistant", content: [], stopReason: "stop", timestamp: 3 },
    } as unknown as SessionEntry);

    await harness.handlers.get("agent_settled")?.({}, harness.context);
    await harness.handlers.get("agent_settled")?.({}, harness.context);

    expect(harness.turnRecords).toHaveLength(1);
    expect(harness.turnRecords[0]).toMatchObject({ userEntryId: "current-user", assistantEntryId: "assistant-result" });
  });

  it("settles the current stopped task without borrowing an earlier assistant message", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "pi-ecode-stopped-turn-"));
    const storage = await mkdtemp(join(tmpdir(), "pi-ecode-stopped-history-"));
    temporaryPaths.push(workspace, storage);
    await writeFile(join(workspace, "app.txt"), "before\n", "utf8");
    const history = new WorkspaceHistory(storage);
    const entries = [{
      type: "message",
      id: "previous-assistant",
      parentId: null,
      timestamp: new Date().toISOString(),
      message: { role: "assistant", content: [{ type: "text", text: "Earlier answer" }], stopReason: "stop", timestamp: 1 },
    }] as unknown as SessionEntry[];
    const harness = historyExtensionHarness(history, entries, workspace);

    await harness.handlers.get("before_agent_start")?.({ prompt: "question stopped immediately" }, harness.context);
    entries.push({
      type: "message",
      id: "current-user",
      parentId: "previous-assistant",
      timestamp: new Date().toISOString(),
      message: { role: "user", content: "question stopped immediately", timestamp: 2 },
    } as SessionEntry);
    await harness.handlers.get("message_end")?.({ message: { role: "user" } }, harness.context);
    const session = fakeSession(workspace, entries, []);

    await history.settlePending(session);
    await harness.handlers.get("agent_settled")?.({}, harness.context);

    const records = entries.filter((entry) => entry.type === "custom" && entry.customType === "pi-ecode.workspace-turn");
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      data: { userEntryId: "current-user", prompt: "question stopped immediately" },
    });
    expect((records[0] as { data: { assistantEntryId?: string } }).data.assistantEntryId).toBeUndefined();
    expect((await history.getState(session)).canUndo).toBe(true);
  });

  it("restores modified and newly-created files with undo", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "pi-ecode-workspace-"));
    const storage = await mkdtemp(join(tmpdir(), "pi-ecode-history-"));
    temporaryPaths.push(workspace, storage);
    const history = new WorkspaceHistory(storage);
    const captured: CapturedCheckpoint[] = [];
    await writeFile(join(workspace, "app.txt"), "before\n", "utf8");

    const initialSession = fakeSession(workspace, [], captured);
    await history.checkpoint(initialSession, "before");
    const beforeCommit = captured.at(-1)?.commit;
    expect(beforeCommit).toBeTruthy();

    await writeFile(join(workspace, "app.txt"), "after\n", "utf8");
    await writeFile(join(workspace, "new.txt"), "created\n", "utf8");
    await history.checkpoint(initialSession, "after");
    const afterCommit = captured.at(-1)?.commit;
    expect(afterCommit).toBeTruthy();

    const turnEntry = {
      type: "custom",
      id: "turn-entry",
      parentId: "assistant-entry",
      timestamp: new Date().toISOString(),
      customType: "pi-ecode.workspace-turn",
      data: {
        version: 1,
        beforeCommit,
        afterCommit,
        userEntryId: "user-entry",
        assistantEntryId: "assistant-entry",
        prompt: "change the files",
        createdAt: new Date().toISOString(),
      },
    } satisfies SessionEntry;
    const session = fakeSession(workspace, [turnEntry], captured);
    const review = await history.getReview(session);
    expect(review.files).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: "app.txt", status: "modified", additions: 1, deletions: 1 }),
      expect.objectContaining({ path: "new.txt", status: "added", additions: 1, deletions: 0 }),
    ]));
    expect(review.patch).toContain("diff --git a/app.txt b/app.txt");

    const result = await history.undo(session);

    expect(result.editorText).toBe("change the files");
    expect(await readFile(join(workspace, "app.txt"), "utf8")).toBe("before\n");
    await expect(readFile(join(workspace, "new.txt"), "utf8")).rejects.toThrow();

    await history.redo(session);
    expect(await readFile(join(workspace, "app.txt"), "utf8")).toBe("after\n");
    expect(await readFile(join(workspace, "new.txt"), "utf8")).toBe("created\n");
  });

  it("rejects only a reviewed file and refuses arbitrary paths", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "pi-ecode-reject-workspace-"));
    const storage = await mkdtemp(join(tmpdir(), "pi-ecode-reject-history-"));
    temporaryPaths.push(workspace, storage);
    const history = new WorkspaceHistory(storage);
    const captured: CapturedCheckpoint[] = [];
    await writeFile(join(workspace, "keep.txt"), "before\n", "utf8");
    const initialSession = fakeSession(workspace, [], captured);
    await history.checkpoint(initialSession, "before");
    const beforeCommit = captured.at(-1)?.commit;
    await writeFile(join(workspace, "keep.txt"), "after\n", "utf8");
    await writeFile(join(workspace, "reject.txt"), "new\n", "utf8");
    await history.checkpoint(initialSession, "after");
    const afterCommit = captured.at(-1)?.commit;
    const turnEntry = {
      type: "custom",
      id: "turn-entry",
      parentId: null,
      timestamp: new Date().toISOString(),
      customType: "pi-ecode.workspace-turn",
      data: {
        version: 1,
        beforeCommit,
        afterCommit,
        userEntryId: "user-entry",
        assistantEntryId: "assistant-entry",
        prompt: "change files",
        createdAt: new Date().toISOString(),
      },
    } satisfies SessionEntry;
    const session = fakeSession(workspace, [turnEntry], captured);

    const review = await history.rejectFile(session, "reject.txt");
    expect(review.files.map((file) => file.path)).toEqual(["keep.txt"]);
    expect(await readFile(join(workspace, "keep.txt"), "utf8")).toBe("after\n");
    await expect(readFile(join(workspace, "reject.txt"), "utf8")).rejects.toThrow();
    await expect(history.rejectFile(session, "../outside.txt")).rejects.toThrow("not part");
  });

  it("preserves external file changes when undoing a conversation-only task", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "pi-ecode-conversation-undo-workspace-"));
    const storage = await mkdtemp(join(tmpdir(), "pi-ecode-conversation-undo-history-"));
    temporaryPaths.push(workspace, storage);
    const history = new WorkspaceHistory(storage);
    const captured: CapturedCheckpoint[] = [];
    await writeFile(join(workspace, "app.txt"), "saved\n", "utf8");
    const initialSession = fakeSession(workspace, [], captured);
    await history.checkpoint(initialSession, "saved");
    const commit = captured.at(-1)?.commit;

    const turnEntry = {
      type: "custom",
      id: "turn-entry",
      parentId: null,
      timestamp: new Date().toISOString(),
      customType: "pi-ecode.workspace-turn",
      data: {
        version: 1,
        beforeCommit: commit,
        afterCommit: commit,
        userEntryId: "user-entry",
        assistantEntryId: "assistant-entry",
        prompt: "hi",
        createdAt: new Date().toISOString(),
      },
    } satisfies SessionEntry;
    await writeFile(join(workspace, "app.txt"), "external change\n", "utf8");
    const session = fakeSession(workspace, [turnEntry], captured);

    await expect(history.undo(session)).resolves.toMatchObject({
      editorText: "hi",
      message: "Conversation restored; workspace preserved.",
    });
    expect(await readFile(join(workspace, "app.txt"), "utf8")).toBe("external change\n");
  });

  it("blocks undo of a file-changing task when files changed after its snapshot", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "pi-ecode-dirty-workspace-"));
    const storage = await mkdtemp(join(tmpdir(), "pi-ecode-dirty-history-"));
    temporaryPaths.push(workspace, storage);
    const history = new WorkspaceHistory(storage);
    const captured: CapturedCheckpoint[] = [];
    await writeFile(join(workspace, "app.txt"), "before task\n", "utf8");
    const initialSession = fakeSession(workspace, [], captured);
    await history.checkpoint(initialSession, "before task");
    const beforeCommit = captured.at(-1)?.commit;
    await writeFile(join(workspace, "app.txt"), "after task\n", "utf8");
    await history.checkpoint(initialSession, "after task");
    const afterCommit = captured.at(-1)?.commit;

    const turnEntry = {
      type: "custom",
      id: "turn-entry",
      parentId: null,
      timestamp: new Date().toISOString(),
      customType: "pi-ecode.workspace-turn",
      data: {
        version: 1,
        beforeCommit,
        afterCommit,
        userEntryId: "user-entry",
        assistantEntryId: "assistant-entry",
        prompt: "change the file",
        createdAt: new Date().toISOString(),
      },
    } satisfies SessionEntry;
    await writeFile(join(workspace, "app.txt"), "external change\n", "utf8");
    const session = fakeSession(workspace, [turnEntry], captured);

    await expect(history.undo(session)).rejects.toThrow("Create a checkpoint");
    expect(await readFile(join(workspace, "app.txt"), "utf8")).toBe("external change\n");
  });

  it("keeps a CodeGraph index out of the captured source revision", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "pi-ecode-codegraph-revision-"));
    const storage = await mkdtemp(join(tmpdir(), "pi-ecode-codegraph-revision-history-"));
    temporaryPaths.push(workspace, storage);
    const history = new WorkspaceHistory(storage);
    const session = fakeSession(workspace, [], []);
    await writeFile(join(workspace, "app.txt"), "one\n", "utf8");
    await mkdir(join(workspace, ".codegraph"), { recursive: true });
    await writeFile(join(workspace, ".codegraph", "codegraph.db"), "index-a\n", "utf8");

    const initial = await history.captureSourceRevision(session);
    await writeFile(join(workspace, ".codegraph", "codegraph.db"), "index-b\n", "utf8");
    const afterIndexSync = await history.captureSourceRevision(session);
    await writeFile(join(workspace, "app.txt"), "two\n", "utf8");
    const afterSourceEdit = await history.captureSourceRevision(session);

    expect(afterIndexSync).toBe(initial);
    expect(afterSourceEdit).not.toBe(afterIndexSync);
    expect(await readFile(join(workspace, ".codegraph", "codegraph.db"), "utf8")).toBe("index-b\n");
  });

  it("drops a legacy tracked CodeGraph index from an existing shadow repository", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "pi-ecode-codegraph-migration-"));
    const storage = await mkdtemp(join(tmpdir(), "pi-ecode-codegraph-migration-history-"));
    temporaryPaths.push(workspace, storage);
    const history = new WorkspaceHistory(storage);
    const session = fakeSession(workspace, [], []);
    await writeFile(join(workspace, "app.txt"), "one\n", "utf8");
    await mkdir(join(workspace, ".codegraph"), { recursive: true });
    await writeFile(join(workspace, ".codegraph", "codegraph.db"), "index-a\n", "utf8");
    await history.captureSourceRevision(session);
    await commitLegacyCodegraphIndex(storage, workspace);
    const { gitDir, args } = await shadowRepository(storage, workspace);
    expect((await git(workspace, [...args, "ls-files", "--", ".codegraph"])).trim()).toBe(".codegraph/codegraph.db");

    await writeFile(join(workspace, ".codegraph", "codegraph.db"), "index-b\n", "utf8");
    const migrated = await history.captureSourceRevision(session);

    expect((await git(workspace, [...args, "ls-files", "--", ".codegraph"])).trim()).toBe("");
    expect(await readFile(join(gitDir, "info", "exclude"), "utf8")).toContain(".codegraph/");
    expect(await readFile(join(workspace, ".codegraph", "codegraph.db"), "utf8")).toBe("index-b\n");

    await writeFile(join(workspace, ".codegraph", "codegraph.db"), "index-c\n", "utf8");
    expect(await history.captureSourceRevision(session)).toBe(migrated);
    await writeFile(join(workspace, "app.txt"), "two\n", "utf8");
    expect(await history.captureSourceRevision(session)).not.toBe(migrated);
  });

  it("keeps the real CodeGraph index when restoring a turn that was recorded with it", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "pi-ecode-codegraph-restore-"));
    const storage = await mkdtemp(join(tmpdir(), "pi-ecode-codegraph-restore-history-"));
    temporaryPaths.push(workspace, storage);
    const history = new WorkspaceHistory(storage);
    const captured: CapturedCheckpoint[] = [];
    await writeFile(join(workspace, "app.txt"), "before\n", "utf8");
    await mkdir(join(workspace, ".codegraph"), { recursive: true });
    await writeFile(join(workspace, ".codegraph", "codegraph.db"), "old-index\n", "utf8");
    const session = fakeSession(workspace, [], captured);
    await history.captureSourceRevision(session);
    const beforeCommit = await commitLegacyCodegraphIndex(storage, workspace);

    await writeFile(join(workspace, "app.txt"), "after\n", "utf8");
    await writeFile(join(workspace, ".codegraph", "codegraph.db"), "new-index\n", "utf8");
    await history.checkpoint(session, "after task");
    const afterCommit = captured.at(-1)?.commit;
    const turnEntry = {
      type: "custom",
      id: "turn-entry",
      parentId: null,
      timestamp: new Date().toISOString(),
      customType: "pi-ecode.workspace-turn",
      data: {
        version: 1,
        beforeCommit,
        afterCommit,
        userEntryId: "user-entry",
        assistantEntryId: "assistant-entry",
        prompt: "restore the earlier source",
        createdAt: new Date().toISOString(),
      },
    } satisfies SessionEntry;
    const turnSession = fakeSession(workspace, [turnEntry], captured);

    await expect(history.undo(turnSession)).resolves.toMatchObject({ editorText: "restore the earlier source" });

    expect(await readFile(join(workspace, "app.txt"), "utf8")).toBe("before\n");
    expect(await readFile(join(workspace, ".codegraph", "codegraph.db"), "utf8")).toBe("new-index\n");
  });

  it("keeps a legacy CodeGraph index out of the change review and the reject path", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "pi-ecode-codegraph-review-"));
    const storage = await mkdtemp(join(tmpdir(), "pi-ecode-codegraph-review-history-"));
    temporaryPaths.push(workspace, storage);
    const history = new WorkspaceHistory(storage);
    const captured: CapturedCheckpoint[] = [];
    await writeFile(join(workspace, "app.txt"), "before\n", "utf8");
    await mkdir(join(workspace, ".codegraph"), { recursive: true });
    await writeFile(join(workspace, ".codegraph", "codegraph.db"), "old-index\n", "utf8");
    const session = fakeSession(workspace, [], captured);
    await history.captureSourceRevision(session);
    const beforeCommit = await commitLegacyCodegraphIndex(storage, workspace);

    await writeFile(join(workspace, "app.txt"), "after\n", "utf8");
    await writeFile(join(workspace, ".codegraph", "codegraph.db"), "new-index\n", "utf8");
    const afterCommit = await commitLegacyCodegraphIndex(storage, workspace);
    const turnEntry = {
      type: "custom",
      id: "turn-entry",
      parentId: null,
      timestamp: new Date().toISOString(),
      customType: "pi-ecode.workspace-turn",
      data: {
        version: 1,
        beforeCommit,
        afterCommit,
        userEntryId: "user-entry",
        assistantEntryId: "assistant-entry",
        prompt: "change the file",
        createdAt: new Date().toISOString(),
      },
    } satisfies SessionEntry;
    const turnSession = fakeSession(workspace, [turnEntry], captured);

    const review = await history.getReview(turnSession);

    expect(review.files.map((file) => file.path)).toEqual(["app.txt"]);
    expect(review.patch).not.toContain(".codegraph");
    await expect(history.rejectFile(turnSession, ".codegraph/codegraph.db")).rejects.toThrow("not part");
    expect(await readFile(join(workspace, ".codegraph", "codegraph.db"), "utf8")).toBe("new-index\n");
  });

  it("undoes a legacy turn on first use without a checkpoint after migration", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "pi-ecode-legacy-undo-"));
    const storage = await mkdtemp(join(tmpdir(), "pi-ecode-legacy-undo-history-"));
    temporaryPaths.push(workspace, storage);
    const history = new WorkspaceHistory(storage);
    const { session } = await seedLegacyTurn(history, storage, workspace, "legacy task");
    // 迁移后用户已重新跑过 codegraph sync，工作区里的索引是真索引。
    await writeFile(join(workspace, ".codegraph", "codegraph.db"), "new-index\n", "utf8");

    // 迁移自己的 rm --cached 会留下暂存删除；它不是用户的工作区改动，不能把首次 undo 当成脏工作区。
    await expect(history.undo(session)).resolves.toMatchObject({ editorText: "legacy task" });

    expect(await readFile(join(workspace, "app.txt"), "utf8")).toBe("before\n");
    expect(await readFile(join(workspace, ".codegraph", "codegraph.db"), "utf8")).toBe("new-index\n");
  });

  it("still blocks undo after migration when a real source file changed", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "pi-ecode-legacy-dirty-"));
    const storage = await mkdtemp(join(tmpdir(), "pi-ecode-legacy-dirty-history-"));
    temporaryPaths.push(workspace, storage);
    const history = new WorkspaceHistory(storage);
    const { session } = await seedLegacyTurn(history, storage, workspace, "legacy task");
    await writeFile(join(workspace, "app.txt"), "external change\n", "utf8");

    await expect(history.undo(session)).rejects.toThrow("Create a checkpoint");
    expect(await readFile(join(workspace, "app.txt"), "utf8")).toBe("external change\n");
  });

  it("keeps a negated CodeGraph index out of the captured source revision", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "pi-ecode-codegraph-negation-"));
    const storage = await mkdtemp(join(tmpdir(), "pi-ecode-codegraph-negation-history-"));
    temporaryPaths.push(workspace, storage);
    const history = new WorkspaceHistory(storage);
    const session = fakeSession(workspace, [], []);
    // 工作区 .gitignore 优先级高于影子仓库的 info/exclude；这里让索引真正处于未忽略状态。
    await writeNegatedCodegraphFixture(workspace);

    const initial = await history.captureSourceRevision(session);
    await writeFile(join(workspace, ".codegraph", "codegraph.db"), "index-b\n", "utf8");
    const afterIndexSync = await history.captureSourceRevision(session);

    expect(afterIndexSync).toBe(initial);
    // 前提校验（只读）：对 git 而言这个文件确实没被忽略，排除只能来自暂存后的撤出索引。
    const { args } = await shadowRepository(storage, workspace);
    expect(await git(workspace, [...args, "status", "--porcelain=v1", "--untracked-files=all"])).toContain(".codegraph/codegraph.db");

    await writeFile(join(workspace, "app.txt"), "two\n", "utf8");
    expect(await history.captureSourceRevision(session)).not.toBe(initial);

    // 索引目录不在影子索引里（撤出与 ignore 优先级无关），真实源码仍被暂存。
    expect((await git(workspace, [...args, "ls-files", "--", ".codegraph"])).trim()).toBe("");
    expect((await git(workspace, [...args, "ls-files", "--", "app.txt"])).trim()).toBe("app.txt");
  });

  it("does not commit when only a negated CodeGraph index changed", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "pi-ecode-negation-snapshot-"));
    const storage = await mkdtemp(join(tmpdir(), "pi-ecode-negation-snapshot-history-"));
    temporaryPaths.push(workspace, storage);
    const history = new WorkspaceHistory(storage);
    const session = fakeSession(workspace, [], []);
    await writeNegatedCodegraphFixture(workspace);

    await history.checkpoint(session, "before index sync");
    const { args } = await shadowRepository(storage, workspace);
    const headBefore = (await git(workspace, [...args, "rev-parse", "HEAD"])).trim();

    await writeFile(join(workspace, ".codegraph", "codegraph.db"), "index-b\n", "utf8");
    await history.checkpoint(session, "after index sync");

    // 只有被取反的索引变化时不应产生新提交，且工作区索引未被改写。
    expect((await git(workspace, [...args, "rev-parse", "HEAD"])).trim()).toBe(headBefore);
    expect(await readFile(join(workspace, ".codegraph", "codegraph.db"), "utf8")).toBe("index-b\n");

    await writeFile(join(workspace, "app.txt"), "two\n", "utf8");
    await history.checkpoint(session, "after source edit");
    expect((await git(workspace, [...args, "rev-parse", "HEAD"])).trim()).not.toBe(headBefore);
  });

  it("preserves existing shadow exclude entries when migrating", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "pi-ecode-exclude-preserve-"));
    const storage = await mkdtemp(join(tmpdir(), "pi-ecode-exclude-preserve-history-"));
    temporaryPaths.push(workspace, storage);
    const history = new WorkspaceHistory(storage);
    const session = fakeSession(workspace, [], []);
    await writeFile(join(workspace, "app.txt"), "one\n", "utf8");
    await history.captureSourceRevision(session);
    const { gitDir } = await shadowRepository(storage, workspace);
    // 模拟已有 exclude 内容（旧版影子仓库或用户手工追加）且不含 .codegraph/。
    await writeFile(join(gitDir, "info", "exclude"), "user-custom-entry.txt\n", "utf8");

    await history.captureSourceRevision(session);

    const exclude = await readFile(join(gitDir, "info", "exclude"), "utf8");
    expect(exclude).toContain("user-custom-entry.txt");
    expect(exclude).toContain(".codegraph/");
    await history.captureSourceRevision(session);
    const excludeLines = (await readFile(join(gitDir, "info", "exclude"), "utf8")).split("\n");
    expect(excludeLines.filter((line) => line.trim() === ".codegraph/")).toHaveLength(1);
  });
});
