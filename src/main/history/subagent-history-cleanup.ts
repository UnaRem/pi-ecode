import { randomUUID } from "node:crypto";
import { createReadStream, type Stats } from "node:fs";
import { lstat, open, readdir, rename, rm, utimes } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";

interface CleanupOptions {
  agentDir: string;
  catalogDirectory: string;
  excludedSessionFiles?: readonly string[];
}

export interface SubagentHistoryCleanupResult {
  removedFiles: number;
  removedEntries: number;
  removedBytes: number;
  rewrittenSessionFiles: string[];
  failures: { path: string; message: string }[];
}

interface SessionIndex {
  parents: Map<string, string | null>;
  removedIds: Set<string>;
}

type JsonEntry = Record<string, unknown>;

function parseEntry(line: string): JsonEntry {
  const entry: unknown = JSON.parse(line);
  if (!entry || typeof entry !== "object" || Array.isArray(entry) || typeof (entry as JsonEntry).type !== "string") {
    throw new Error("Invalid session entry.");
  }
  return entry as JsonEntry;
}

function isRetiredEntry(entry: JsonEntry): boolean {
  return (entry.type === "custom" || entry.type === "custom_message")
    && typeof entry.customType === "string" && entry.customType.startsWith("pi-ecode.explorer-");
}

async function* sessionLines(path: string): AsyncGenerator<string> {
  const input = createReadStream(path, { encoding: "utf8" });
  const lines = createInterface({ input, crlfDelay: Infinity });
  try {
    for await (const line of lines) yield line;
  } finally {
    lines.close();
    input.destroy();
  }
}

function validateSessionHeader(entry: JsonEntry): boolean {
  if (entry.type !== "session" || typeof entry.id !== "string" || typeof entry.cwd !== "string") {
    throw new Error("Invalid session header.");
  }
  return entry.version === 2 || entry.version === 3;
}

function indexTreeEntry(entry: JsonEntry, index: SessionIndex): void {
  if (entry.type === "session" || typeof entry.id !== "string" || !entry.id || index.parents.has(entry.id)) {
    throw new Error("Invalid or duplicate session entry ID.");
  }
  if (entry.parentId !== null && (typeof entry.parentId !== "string" || !index.parents.has(entry.parentId))) {
    // Parents must precede children: accepting a missing/forward parent could disconnect a main conversation.
    throw new Error(`Invalid parent of session entry ${entry.id}.`);
  }
  index.parents.set(entry.id, entry.parentId as string | null);
  if (isRetiredEntry(entry)) index.removedIds.add(entry.id);
}

async function indexSession(path: string): Promise<SessionIndex> {
  const index: SessionIndex = { parents: new Map(), removedIds: new Set() };
  let supportedVersion: boolean | undefined;
  for await (const line of sessionLines(path)) {
    if (!line.trim()) continue;
    const entry = parseEntry(line);
    if (supportedVersion === undefined) {
      supportedVersion = validateSessionHeader(entry);
      continue;
    }
    if (!supportedVersion) {
      if (isRetiredEntry(entry)) throw new Error("Cannot clean retired records in this session version.");
      continue;
    }
    indexTreeEntry(entry, index);
  }
  if (supportedVersion === undefined) throw new Error("Missing session header.");
  return index;
}

function retainedAncestor(reference: unknown, index: SessionIndex): string | null {
  if (reference !== null && (typeof reference !== "string" || !index.parents.has(reference))) {
    throw new Error("Unresolved session reference.");
  }
  let ancestor = reference as string | null;
  while (ancestor !== null && index.removedIds.has(ancestor)) ancestor = index.parents.get(ancestor)!;
  return ancestor;
}

function retainedCompactionAnchor(entry: JsonEntry, index: SessionIndex): string {
  let cursor = index.parents.get(entry.id as string)!;
  let firstKept = entry.id as string;
  // Walk only this compaction's branch. Moving the anchor to an ancestor would restore already summarized messages.
  while (cursor !== null) {
    if (cursor === entry.firstKeptEntryId) return firstKept;
    if (!index.removedIds.has(cursor)) firstKept = cursor;
    cursor = index.parents.get(cursor)!;
  }
  throw new Error("Compaction anchor is outside its branch.");
}

function repairReferences(entry: JsonEntry, index: SessionIndex): boolean {
  let changed = false;
  for (const field of ["parentId", "targetId", "fromId"] as const) {
    if (!(field in entry)) continue;
    const ancestor = retainedAncestor(entry[field], index);
    if (entry[field] === ancestor) continue;
    if (field !== "parentId" && (ancestor === null || entry.type === "context_edit")) {
      throw new Error(`Cannot preserve ${field} of session entry ${String(entry.id)}.`);
    }
    entry[field] = ancestor;
    changed = true;
  }
  return repairCompactionAnchor(entry, index) || changed;
}

function repairCompactionAnchor(entry: JsonEntry, index: SessionIndex): boolean {
  if (entry.type !== "compaction" || !("firstKeptEntryId" in entry)) return false;
  const anchor = entry.firstKeptEntryId;
  if (typeof anchor !== "string" || !index.parents.has(anchor)) throw new Error("Unresolved compaction anchor.");
  if (!index.removedIds.has(anchor)) return false;
  // The first-pass index retains the original parent chain even after repairing this entry's parentId.
  entry.firstKeptEntryId = retainedCompactionAnchor(entry, index);
  return true;
}

function unchangedSession(original: Stats, current: Stats): boolean {
  return current.isFile() && !current.isSymbolicLink() && original.dev === current.dev && original.ino === current.ino
    && original.size === current.size && original.mtimeMs === current.mtimeMs && original.ctimeMs === current.ctimeMs;
}

async function cleanSession(path: string): Promise<{ entries: number; bytes: number }> {
  const original = await lstat(path);
  if (!original.isFile() || original.isSymbolicLink()) return { entries: 0, bytes: 0 };
  const index = await indexSession(path);
  if (index.removedIds.size === 0) return { entries: 0, bytes: 0 };
  const temporaryPath = `${path}.${randomUUID()}.cleanup.tmp`;
  const output = await open(temporaryPath, "wx", original.mode);
  try {
    await output.chmod(original.mode);
    for await (const line of sessionLines(path)) {
      if (!line.trim()) continue;
      const entry = parseEntry(line);
      if (isRetiredEntry(entry)) continue;
      const repaired = entry.type !== "session" && repairReferences(entry, index);
      await output.writeFile(`${repaired ? JSON.stringify(entry) : line}\n`, "utf8");
    }
    await output.sync();
    const rewritten = await output.stat();
    await output.close();
    // continueRecent orders sessions by mtime; cleaning old history must not make it the most recent conversation.
    await utimes(temporaryPath, original.atimeMs / 1000, original.mtimeMs / 1000);
    if (!unchangedSession(original, await lstat(path))) throw new Error("Session changed during history cleanup.");
    await rename(temporaryPath, path);
    return { entries: index.removedIds.size, bytes: original.size - rewritten.size };
  } finally {
    await output.close();
    await rm(temporaryPath, { force: true });
  }
}

async function realDirectory(path: string): Promise<boolean> {
  try {
    const details = await lstat(path);
    return details.isDirectory() && !details.isSymbolicLink();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function ownedDirectorySize(path: string): Promise<{ files: number; bytes: number }> {
  let files = 0;
  let bytes = 0;
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const childPath = join(path, entry.name);
    if (entry.isDirectory()) {
      const child = await ownedDirectorySize(childPath);
      files += child.files;
      bytes += child.bytes;
    } else if (entry.isFile()) {
      files += 1;
      bytes += (await lstat(childPath)).size;
    }
  }
  return { files, bytes };
}

async function removeOwnedDirectory(path: string, result: SubagentHistoryCleanupResult): Promise<void> {
  if (!await realDirectory(dirname(path)) || !await realDirectory(path)) return;
  const removed = await ownedDirectorySize(path);
  // rm removes symlink entries themselves and never traverses their targets.
  await rm(path, { recursive: true });
  result.removedFiles += removed.files;
  result.removedBytes += removed.bytes;
}

function recordFailure(result: SubagentHistoryCleanupResult, path: string, error: unknown): void {
  result.failures.push({ path, message: error instanceof Error ? error.message : String(error) });
}

function sessionPathKey(path: string): string {
  const absolutePath = resolve(path);
  return process.platform === "win32" ? absolutePath.toLowerCase() : absolutePath;
}

async function cleanProjectSessions(path: string, excluded: Set<string>, result: SubagentHistoryCleanupResult): Promise<void> {
  if (!await realDirectory(path)) return;
  try {
    await removeOwnedDirectory(join(path, ".explorers"), result);
  } catch (error) {
    recordFailure(result, join(path, ".explorers"), error);
  }
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const sessionPath = join(path, entry.name);
    if (!entry.isFile() || !entry.name.endsWith(".jsonl") || excluded.has(sessionPathKey(sessionPath))) continue;
    try {
      const removed = await cleanSession(sessionPath);
      if (removed.entries === 0) continue;
      result.removedEntries += removed.entries;
      result.removedBytes += removed.bytes;
      result.rewrittenSessionFiles.push(sessionPath);
    } catch (error) {
      recordFailure(result, sessionPath, error);
    }
  }
}

async function cleanSessionsRoot(path: string, excluded: Set<string>, result: SubagentHistoryCleanupResult): Promise<void> {
  if (!await realDirectory(path)) return;
  for (const project of await readdir(path, { withFileTypes: true })) {
    if (!project.isDirectory()) continue;
    const projectPath = join(path, project.name);
    try {
      await cleanProjectSessions(projectPath, excluded, result);
    } catch (error) {
      recordFailure(result, projectPath, error);
    }
  }
}

export async function cleanupSubagentHistory(options: CleanupOptions): Promise<SubagentHistoryCleanupResult> {
  const result: SubagentHistoryCleanupResult = { removedFiles: 0, removedEntries: 0, removedBytes: 0, rewrittenSessionFiles: [], failures: [] };
  const excluded = new Set((options.excludedSessionFiles ?? []).map(sessionPathKey));
  const retiredRoots = [options.catalogDirectory];
  try {
    if (await realDirectory(options.agentDir)) {
      retiredRoots.push(join(options.agentDir, "state", "pi-ecode-agents"), join(options.agentDir, "state", "pi-ecode-explorers"));
      await cleanSessionsRoot(join(options.agentDir, "sessions"), excluded, result);
    }
  } catch (error) {
    recordFailure(result, options.agentDir, error);
  }
  for (const root of retiredRoots) {
    try {
      await removeOwnedDirectory(root, result);
    } catch (error) {
      recordFailure(result, root, error);
    }
  }
  return result;
}
