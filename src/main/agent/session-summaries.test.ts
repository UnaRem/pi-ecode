import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { listSessionSummaries } from "./session-summaries.js";
import { formatSessionSize, LARGE_SESSION_BYTES } from "../../shared/session-size.js";

afterEach(() => vi.restoreAllMocks());

describe("session file sizes", () => {
  it("returns actual UTF-8 file sizes and unknown for an unavailable file", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-ecode-session-size-"));
    try {
      const path = join(cwd, "session.jsonl");
      const content = '{"message":"中文消息"}\n';
      await writeFile(path, content);
      const summary = { path, id: "session", cwd, created: new Date(1), modified: new Date(2),
        messageCount: 1, firstMessage: "中文消息", allMessagesText: "中文消息" };
      vi.spyOn(SessionManager, "list").mockResolvedValue([summary, { ...summary, path: join(cwd, "missing.jsonl") }]);
      const sessions = await listSessionSummaries(cwd, cwd);
      expect(sessions[0]).toMatchObject({ title: "中文消息", byteSize: Buffer.byteLength(content) });
      expect(sessions[1]?.byteSize).toBeNull();
    } finally { await rm(cwd, { recursive: true, force: true }); }
  });

  it("shares unchanged scans and invalidates metadata after writes and removal", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-ecode-session-cache-"));
    const path = join(cwd, "session.jsonl");
    const summary = { path, id: "session", cwd, created: new Date(1), modified: new Date(2),
      messageCount: 1, firstMessage: "first", allMessagesText: "first" };
    const scan = vi.spyOn(SessionManager, "list").mockResolvedValue([summary]);
    try {
      await writeFile(path, "first");
      const results = await Promise.all([listSessionSummaries(cwd, cwd), listSessionSummaries(cwd, cwd)]);
      expect(results[0]).toEqual(results[1]);
      await listSessionSummaries(cwd, cwd);
      expect(scan).toHaveBeenCalledOnce();
      await writeFile(path, "updated content");
      scan.mockResolvedValue([{ ...summary, name: "updated" }]);
      expect((await listSessionSummaries(cwd, cwd))[0]).toMatchObject({ title: "updated", byteSize: 15 });
      expect(scan).toHaveBeenCalledTimes(2);
      await rm(path);
      scan.mockResolvedValue([]);
      expect(await listSessionSummaries(cwd, cwd)).toEqual([]);
      expect(scan).toHaveBeenCalledTimes(3);
    } finally { await rm(cwd, { recursive: true, force: true }); }
  });

  it("formats sizes around the reminder boundary", () => {
    expect(formatSessionSize(0)).toBe("0 B");
    expect(formatSessionSize(1024)).toBe("1.0 KiB");
    expect(LARGE_SESSION_BYTES).toBe(10_485_760);
    expect(formatSessionSize(LARGE_SESSION_BYTES)).toBe("10.0 MiB");
  });
});
