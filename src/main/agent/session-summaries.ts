import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { SessionSummary } from "../../shared/contracts.js";

interface SummaryCache {
  signature: string;
  summaries: Promise<SessionSummary[]>;
}
const summaryCaches = new Map<string, SummaryCache>();
const MAX_CACHED_DIRECTORIES = 16;

async function directorySignature(directory: string): Promise<string> {
  const names = (await readdir(directory)).filter((name) => name.endsWith(".jsonl")).sort();
  const stamps = await Promise.all(names.map(async (name) => {
    const details = await stat(join(directory, name)).catch(() => null);
    return [name, details?.size, details?.mtimeMs, details?.ctimeMs];
  }));
  return JSON.stringify(stamps);
}

async function scanSessionSummaries(projectPath: string, directory?: string): Promise<SessionSummary[]> {
  const sessions = await SessionManager.list(projectPath, directory);
  return Promise.all(sessions.map(async (session) => ({
    path: session.path,
    id: session.id,
    title: session.name || session.firstMessage || "New conversation",
    modifiedAt: session.modified.getTime(),
    messageCount: session.messageCount,
    byteSize: await stat(session.path).then((details) => details.size, () => null),
  })));
}

export async function listSessionSummaries(projectPath: string | null | undefined, directory?: string): Promise<SessionSummary[]> {
  if (!projectPath) return [];
  if (!directory) return scanSessionSummaries(projectPath);
  const cacheKey = JSON.stringify([projectPath, directory]);
  const signature = await directorySignature(directory).catch(() => null);
  if (signature === null) return scanSessionSummaries(projectPath, directory);
  const cached = summaryCaches.get(cacheKey);
  if (cached?.signature === signature) return cached.summaries;
  // Metadata invalidates the shared scan, including renames and external writes; concurrent callers share it.
  const entry: SummaryCache = { signature, summaries: scanSessionSummaries(projectPath, directory) };
  summaryCaches.delete(cacheKey);
  summaryCaches.set(cacheKey, entry);
  if (summaryCaches.size > MAX_CACHED_DIRECTORIES) summaryCaches.delete(summaryCaches.keys().next().value!);
  try { return await entry.summaries; }
  catch (error) {
    if (summaryCaches.get(cacheKey) === entry) summaryCaches.delete(cacheKey);
    throw error;
  }
}
