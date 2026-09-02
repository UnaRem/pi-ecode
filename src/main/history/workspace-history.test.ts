import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
      appendCustomEntry: (_type: string, data: unknown) => {
        if (typeof data === "object" && data !== null && "commit" in data && typeof data.commit === "string") {
          captured.push({ commit: data.commit });
        }
        return "checkpoint-entry";
      },
    },
  };
  return session as unknown as AgentSession;
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

  it("binds history to the current user message and records one settled task", async () => {
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
    entries.push({
      type: "message",
      id: "current-user",
      parentId: "previous-user",
      timestamp: new Date().toISOString(),
      message: { role: "user", content: "current prompt", timestamp: 2 },
    } as SessionEntry);
    await harness.handlers.get("message_end")?.({ message: { role: "user" } }, harness.context);
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

  it("blocks undo when files changed after the latest snapshot", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "pi-ecode-dirty-workspace-"));
    const storage = await mkdtemp(join(tmpdir(), "pi-ecode-dirty-history-"));
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
        prompt: "test",
        createdAt: new Date().toISOString(),
      },
    } satisfies SessionEntry;
    await writeFile(join(workspace, "app.txt"), "unsaved\n", "utf8");
    const session = fakeSession(workspace, [turnEntry], captured);

    await expect(history.undo(session)).rejects.toThrow("Create a checkpoint");
    expect(await readFile(join(workspace, "app.txt"), "utf8")).toBe("unsaved\n");
  });
});
