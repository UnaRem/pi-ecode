import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ToolInfo } from "@earendil-works/pi-coding-agent";
import { ToolStatisticsStore } from "./tool-statistics.js";
import { recommendTools } from "./tool-advisor.js";

describe("local tool statistics", () => {
  it("persists concurrent results, separates nested calls and excludes cancellations from latency", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-ecode-tool-stats-"));
    try {
      const path = join(root, "machine.json");
      const store = new ToolStatisticsStore(path);
      await store.initialize();
      await Promise.all([
        store.record({ name: "read", capability: "file-read", nested: false, outcome: "successes", durationMs: 10 }),
        store.record({ name: "read", capability: "file-read", nested: false, outcome: "failures", durationMs: 30 }),
        store.record({ name: "read", capability: "file-read", nested: false, outcome: "cancelled", durationMs: 999 }),
        store.record({ name: "read", capability: "file-read", nested: true, outcome: "blocked" }),
      ]);
      const restored = new ToolStatisticsStore(path);
      await restored.initialize();
      expect(restored.current).toEqual(store.current);
      expect(restored.current[0]).toMatchObject({ successes: 1, failures: 1, cancelled: 1, medianMs: 20, p95Ms: 30 });
      expect(restored.current[1]).toMatchObject({ nested: true, blocked: 1, medianMs: null });
      expect(JSON.parse(await readFile(path, "utf8")).records).toHaveLength(2);
      const freshMachine = new ToolStatisticsStore(join(root, "other-machine.json"));
      await freshMachine.initialize();
      expect(freshMachine.current).toEqual([]);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("retains an unreadable statistics document without overwriting it", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-ecode-tool-stats-corrupt-"));
    try {
      const path = join(root, "machine.json");
      await writeFile(path, "incomplete document");
      await expect(new ToolStatisticsStore(path).initialize()).rejects.toThrow();
      expect(await readFile(path, "utf8")).toBe("incomplete document");
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("preserves execution counts after a failed write and persists them on the next result", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-ecode-tool-stats-write-"));
    try {
      const parent = join(root, "state");
      await writeFile(parent, "blocked directory");
      const path = join(parent, "machine.json");
      const store = new ToolStatisticsStore(path);
      const result = { name: "read", capability: "file-read" as const, nested: false, outcome: "successes" as const, durationMs: 10 };
      await expect(store.record(result)).rejects.toThrow();
      await rm(parent);
      await store.record(result);
      const restored = new ToolStatisticsStore(path);
      await restored.initialize();
      expect(restored.current[0]).toMatchObject({ successes: 2, medianMs: 10 });
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("uses qualified nested samples without letting browser tools displace file candidates", () => {
    const tools = [
      { name: "read", description: "Read a file", exposure: "direct" },
      { name: "mcp__fastctx__read_file", description: "Read a file", exposure: "codemode" },
      ...Array.from({ length: 20 }, (_, index) => ({ name: `mcp__playwright__browser_${index}`, description: "Browser", exposure: "deferred" })),
    ] as ToolInfo[];
    const entry = { capability: "file-read" as const, blocked: 0, cancelled: 0, p95Ms: 10, adjustment: "compare-latency" as const };
    const metrics = [{ ...entry, name: "read", nested: false, successes: 9, failures: 1, medianMs: 10 },
      { ...entry, name: "mcp__fastctx__read_file", nested: true, successes: 20, failures: 0, medianMs: 1 }];
    const candidates = recommendTools(tools, metrics, "在浏览器检查界面，并读取源码文件");
    expect(candidates.filter((tool) => tool.name.includes("read")).map((tool) => tool.name)).toEqual(["mcp__fastctx__read_file", "read"]);
    expect(candidates.filter((tool) => tool.name.includes("playwright"))).toHaveLength(2);
  });

  it("filters unavailable and unrelated tools before ranking by reliable samples", () => {
    const tools = [
      { name: "read", description: "Read a file", exposure: "direct" },
      { name: "mcp__fastctx__read_file", description: "Read a file", exposure: "deferred" },
      { name: "web_search", description: "Web search", exposure: "direct" },
      { name: "mcp__hidden__read_file", description: "Read file", exposure: "hidden" },
    ] as ToolInfo[];
    const statistics = [{ name: "read", capability: "file-read" as const, nested: false, successes: 1, failures: 9,
      blocked: 0, cancelled: 0, medianMs: 1, p95Ms: 1, adjustment: "inspect-input" as const }];
    expect(recommendTools(tools, statistics, "读取源码文件").map((tool) => tool.name)).toEqual(["mcp__fastctx__read_file", "read"]);
  });
});
