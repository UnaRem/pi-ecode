import { appendFile, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanupSubagentHistory } from "./subagent-history-cleanup.js";

vi.mock("node:fs/promises", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs/promises")>();
  return { ...original, rename: vi.fn(original.rename), utimes: vi.fn(original.utimes) };
});

const header = { type: "session", version: 3, id: "main-session", timestamp: "2026-01-01T00:00:00.000Z", cwd: "C:/workspace" };
function entry(id: string, parentId: string | null, type = "message", fields: Record<string, unknown> = {}) {
  return { type, id, parentId, timestamp: header.timestamp,
    ...(type === "message" ? { message: { role: "user", content: id, timestamp: 1 } } : {}), ...fields };
}
function retired(id: string, parentId: string | null) {
  return entry(id, parentId, "custom", { customType: "pi-ecode.explorer-state", data: { tasks: [{ report: "retired" }] } });
}

let root: string;
let agentDir: string;
let catalogDirectory: string;
let projectDirectory: string;
let sessionPath: string;

async function writeSession(entries: Record<string, unknown>[]): Promise<string> {
  const contents = [header, ...entries].map((candidate) => JSON.stringify(candidate)).join("\n") + "\n";
  await writeFile(sessionPath, contents);
  return contents;
}
async function readEntries(): Promise<Record<string, unknown>[]> {
  return (await readFile(sessionPath, "utf8")).trim().split("\n").map((line: string) => JSON.parse(line) as Record<string, unknown>);
}
function cleanup(excludedSessionFiles: string[] = []) {
  return cleanupSubagentHistory({ agentDir, catalogDirectory, excludedSessionFiles });
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "pi-ecode-retired-history-"));
  agentDir = join(root, "agent");
  catalogDirectory = join(root, "userData", "agents");
  projectDirectory = join(agentDir, "sessions", "--workspace--");
  sessionPath = join(projectDirectory, "main.jsonl");
  await mkdir(projectDirectory, { recursive: true });
});
afterEach(async () => {
  vi.clearAllMocks();
  await rm(root, { recursive: true, force: true });
});

describe("retired subagent history cleanup", () => {
  it("preserves main messages, other extensions, branches and session metadata while reconnecting references", async () => {
    const tool = entry("tool", "other", "message", { message: { role: "toolResult", toolName: "agent_dispatch", toolCallId: "call", content: [{ type: "text", text: "historical call" }], timestamp: 1 } });
    const mainEntries = [
      retired("initial", null), entry("user", "initial"), retired("state", "user"),
      entry("notification", "state", "custom_message", { customType: "pi-ecode.explorer-completion", content: "finished" }),
      entry("other", "notification", "custom", { customType: "other-extension", data: { keep: true } }), tool,
      entry("branch", "notification"), entry("label", "branch", "label", { targetId: "state", label: "checkpoint" }),
      entry("summary", "label", "branch_summary", { fromId: "notification", summary: "Keep this summary" }),
      entry("name", "summary", "session_info", { name: "Main conversation" }),
    ];
    await writeSession(mainEntries);
    await utimes(sessionPath, 1_700_000_000, 1_700_000_000);
    const before = await lstat(sessionPath);

    const result = await cleanup();
    const after = await lstat(sessionPath);
    expect(after.mtimeMs).toBeCloseTo(before.mtimeMs, 3);
    expect(after.atimeMs).toBeCloseTo(before.atimeMs, 3);
    expect(after.mode).toBe(before.mode);
    const entries = await readEntries();
    expect(result).toMatchObject({ removedEntries: 3, rewrittenSessionFiles: [sessionPath], failures: [] });
    expect(result.removedBytes).toBeGreaterThan(0);
    expect(entries[0]).toEqual(header);
    expect(entries.slice(1).map((candidate) => candidate.id)).toEqual(["user", "other", "tool", "branch", "label", "summary", "name"]);
    expect(entries.find((candidate) => candidate.id === "user")?.parentId).toBeNull();
    expect(entries.find((candidate) => candidate.id === "other")).toEqual({ ...mainEntries[4], parentId: "user" });
    expect(entries.find((candidate) => candidate.id === "tool")).toEqual(tool);
    expect(entries.find((candidate) => candidate.id === "label")?.targetId).toBe("user");
    expect(entries.find((candidate) => candidate.id === "summary")?.fromId).toBe("user");
    const session = SessionManager.open(sessionPath);
    expect(session.getSessionId()).toBe(header.id);
    expect(session.getSessionName()).toBe("Main conversation");
    expect(session.getBranch().map((candidate) => candidate.id)).toEqual(["user", "branch", "label", "summary", "name"]);
  });

  it("advances a deleted compaction anchor along its own branch without restoring summarized messages", async () => {
    await writeSession([
      entry("summarized", null), retired("anchor", "summarized"), retired("state", "anchor"),
      entry("other-branch", "state"), entry("kept", "state"),
      entry("compact", "kept", "compaction", { firstKeptEntryId: "anchor", summary: "Earlier work", tokensBefore: 1000 }),
    ]);
    expect((await cleanup()).failures).toEqual([]);
    expect((await readEntries()).find((candidate) => candidate.id === "compact")?.firstKeptEntryId).toBe("kept");
    expect(SessionManager.open(sessionPath).buildContextEntries().map((candidate) => candidate.id)).toEqual(["compact", "kept"]);
  });

  it("keeps only the compaction summary when the retained range contains no surviving entries", async () => {
    await writeSession([
      entry("summarized", null), retired("anchor", "summarized"),
      entry("compact", "anchor", "compaction", { firstKeptEntryId: "anchor", summary: "Earlier work", tokensBefore: 1000 }),
    ]);
    expect((await cleanup()).failures).toEqual([]);
    expect(SessionManager.open(sessionPath).buildContextEntries().map((candidate) => candidate.id)).toEqual(["compact"]);
  });

  it("does not rewrite unaffected histories and is idempotent after cleanup", async () => {
    const untouched = join(projectDirectory, "unaffected.jsonl");
    const contents = JSON.stringify(header) + "\n  " + JSON.stringify(entry("main", null)) + "\n\n";
    await writeFile(untouched, contents);
    await utimes(untouched, 1000, 1000);
    const before = await lstat(untouched);
    await writeSession([entry("main", null), retired("state", "main")]);
    await cleanup();
    const cleaned = await readFile(sessionPath, "utf8");
    const second = await cleanup();
    expect(second).toMatchObject({ removedEntries: 0, removedFiles: 0, removedBytes: 0, rewrittenSessionFiles: [], failures: [] });
    expect(await readFile(sessionPath, "utf8")).toBe(cleaned);
    expect(await readFile(untouched, "utf8")).toBe(contents);
    expect((await lstat(untouched)).mtimeMs).toBe(before.mtimeMs);
  });

  it("excludes a running session and cleans it when the exclusion is lifted at startup", async () => {
    const contents = await writeSession([entry("main", null), retired("state", "main")]);
    const excludedPath = process.platform === "win32" ? sessionPath.toUpperCase() : sessionPath;
    expect((await cleanup([excludedPath])).rewrittenSessionFiles).toEqual([]);
    expect(await readFile(sessionPath, "utf8")).toBe(contents);
    expect((await cleanup()).removedEntries).toBe(1);
  });

  it("leaves malformed histories and unresolved references intact", async () => {
    const malformed = await writeSession([entry("main", null), retired("state", "main")]) + "{broken\n";
    await writeFile(sessionPath, malformed);
    expect((await cleanup()).failures).toHaveLength(1);
    expect(await readFile(sessionPath, "utf8")).toBe(malformed);
    const unresolved = await writeSession([
      entry("main", null), retired("state", "main"), entry("label", "state", "label", { targetId: "missing", label: "keep" }),
    ]);
    expect((await cleanup()).failures).toHaveLength(1);
    expect(await readFile(sessionPath, "utf8")).toBe(unresolved);
    expect(await readdir(projectDirectory)).toEqual(["main.jsonl"]);
  });

  it.each([
    ["missing parent", [entry("main", null), retired("state", "missing")]],
    ["duplicate ID", [entry("main", null), retired("main", "main")]],
    ["cycle", [retired("state", "later"), entry("later", "state")]],
    ["off-branch compaction", [entry("main", null), retired("state", "main"), entry("branch", "main"),
      entry("compact", "branch", "compaction", { firstKeptEntryId: "state", summary: "Keep", tokensBefore: 1 })]],
  ])("preserves a session with an invalid %s", async (_reason, entries) => {
    const contents = await writeSession(entries);
    expect((await cleanup()).failures).toHaveLength(1);
    expect(await readFile(sessionPath, "utf8")).toBe(contents);
    expect(await readdir(projectDirectory)).toEqual(["main.jsonl"]);
  });

  it("does not redirect a context edit to a different main message", async () => {
    const contents = await writeSession([
      entry("main", null), retired("state", "main"),
      entry("edit", "state", "context_edit", { targetId: "state", replacement: { content: "replacement" } }),
    ]);
    expect((await cleanup()).failures).toHaveLength(1);
    expect(await readFile(sessionPath, "utf8")).toBe(contents);
  });

  it("keeps the original history and removes its temporary file when replacement fails", async () => {
    const contents = await writeSession([entry("main", null), retired("state", "main")]);
    vi.mocked(rename).mockRejectedValueOnce(new Error("replacement blocked"));
    expect((await cleanup()).failures).toEqual([{ path: sessionPath, message: "replacement blocked" }]);
    expect(await readFile(sessionPath, "utf8")).toBe(contents);
    expect(await readdir(projectDirectory)).toEqual(["main.jsonl"]);
  });

  it("preserves concurrent appends instead of replacing a session changed during cleanup", async () => {
    const contents = await writeSession([entry("main", null), retired("state", "main")]);
    const appended = JSON.stringify(entry("new-message", "state")) + "\n";
    const original = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    vi.mocked(utimes).mockImplementationOnce(async (...args) => {
      await appendFile(sessionPath, appended);
      await original.utimes(...args);
    });
    expect((await cleanup()).failures).toEqual([{ path: sessionPath, message: "Session changed during history cleanup." }]);
    expect(await readFile(sessionPath, "utf8")).toBe(contents + appended);
    expect(await readdir(projectDirectory)).toEqual(["main.jsonl"]);
  });

  it("skips linked catalog, state and child-history roots", async () => {
    const outside = join(root, "outside");
    await mkdir(outside);
    await writeFile(join(outside, "keep.jsonl"), "outside");
    await mkdir(join(root, "userData"));
    const linkType = process.platform === "win32" ? "junction" : "dir";
    await symlink(outside, catalogDirectory, linkType);
    await symlink(outside, join(projectDirectory, ".explorers"), linkType);
    await symlink(outside, join(agentDir, "state"), linkType);
    const result = await cleanup();
    expect(result).toMatchObject({ removedFiles: 0, removedBytes: 0, failures: [] });
    expect(await readFile(join(outside, "keep.jsonl"), "utf8")).toBe("outside");
    expect((await lstat(catalogDirectory)).isSymbolicLink()).toBe(true);
    expect((await lstat(join(projectDirectory, ".explorers"))).isSymbolicLink()).toBe(true);
  });

  it("removes only owned catalogs and child histories without following directory links", async () => {
    const legacy = join(agentDir, "state", "pi-ecode-agents");
    const legacyExplorers = join(agentDir, "state", "pi-ecode-explorers");
    const children = join(projectDirectory, ".explorers");
    const unrelated = join(agentDir, "state", "other-extension");
    const outside = join(root, "outside");
    const directories = [catalogDirectory, legacy, legacyExplorers, children, unrelated, outside];
    for (const directory of directories) {
      await mkdir(directory, { recursive: true });
      await writeFile(join(directory, "keep-or-retire.jsonl"), "123");
    }
    const linkType = process.platform === "win32" ? "junction" : "dir";
    await symlink(outside, join(catalogDirectory, "linked"), linkType);
    await symlink(outside, join(agentDir, "sessions", "linked-project"), linkType);
    await mkdir(join(outside, ".explorers"));
    await writeFile(join(outside, ".explorers", "keep.jsonl"), "outside");
    const result = await cleanup();
    expect(result).toMatchObject({ removedFiles: 4, removedBytes: 12, failures: [] });
    for (const directory of directories.slice(0, 4)) await expect(lstat(directory)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(join(unrelated, "keep-or-retire.jsonl"), "utf8")).toBe("123");
    expect(await readFile(join(outside, "keep-or-retire.jsonl"), "utf8")).toBe("123");
    expect(await readFile(join(outside, ".explorers", "keep.jsonl"), "utf8")).toBe("outside");
  });
});
