import { stat } from "node:fs/promises";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { SessionSummary } from "../../shared/contracts.js";

export async function listSessionSummaries(projectPath: string | null | undefined): Promise<SessionSummary[]> {
  if (!projectPath) return [];
  const sessions = await SessionManager.list(projectPath);
  return Promise.all(sessions.map(async (session) => ({
    path: session.path,
    id: session.id,
    title: session.name || session.firstMessage || "New conversation",
    modifiedAt: session.modified.getTime(),
    messageCount: session.messageCount,
    byteSize: await stat(session.path).then((details) => details.size, () => null),
  })));
}
