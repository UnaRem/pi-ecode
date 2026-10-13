import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ToolInfo } from "@earendil-works/pi-coding-agent";
import { ToolStatisticsStore } from "./tool-statistics.js";
import { toolCapability, toolSelectionAdvice } from "./tool-advisor.js";

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

  it("reports direct and nested observations separately without ranking tools", () => {
    const tools = [{ name: "read", description: "Read a file", exposure: "direct" }] as ToolInfo[];
    const entry = { capability: "file-read" as const, blocked: 0, cancelled: 0, p95Ms: 10, adjustment: "compare-latency" as const };
    const statistics = [{ ...entry, name: "read", nested: false, successes: 9, failures: 1, medianMs: 10 },
      { ...entry, name: "read", nested: true, successes: 20, failures: 0, medianMs: 1 }];
    const advice = toolSelectionAdvice(tools, ["read"], statistics);
    expect(advice).toContain("currently declared tools (unranked)");
    expect(advice.split("\n").filter((line) => line.startsWith("read:"))).toEqual([
      "read: samples=10, sampleMode=direct, execution successes=9, failures=1, cancelled=0, blocked=0, medianMs=10",
      "read: samples=20, sampleMode=nested, execution successes=20, failures=0, cancelled=0, blocked=0, medianMs=1",
    ]);
  });

  it("excludes inactive, hidden and withdrawn tools from execution observations", () => {
    const tools = [
      { name: "read", description: "Read a file", exposure: "direct" },
      { name: "mcp__fastctx__read_file", description: "Read a file", exposure: "deferred" },
      { name: "mcp__hidden__read_file", description: "Read file", exposure: "hidden" },
    ] as ToolInfo[];
    const statistics = ["read", "mcp__fastctx__read_file", "mcp__hidden__read_file", "withdrawn_tool"].map((name) => ({
      name, capability: "file-read" as const, nested: false, successes: 0, failures: 0,
      blocked: 1, cancelled: 2, medianMs: null, p95Ms: null, adjustment: "collect" as const,
    }));
    const advice = toolSelectionAdvice(tools, ["read", "mcp__hidden__read_file", "withdrawn_tool"], statistics);
    expect(advice).toContain("read: samples=0, sampleMode=direct, execution successes=0, failures=0, cancelled=2, blocked=1, medianMs=unknown");
    expect(advice).not.toContain("mcp__fastctx__read_file");
    expect(advice).not.toContain("mcp__hidden__read_file");
    expect(advice).not.toContain("withdrawn_tool");
  });

  it.each([
    ["mcp__deepwiki__read_wiki_contents", "Read repository documentation", "web-search"],
    ["mcp__context7__query_docs", "Read library documentation", "web-search"],
    ["mcp__exa__get_contents", "Read web pages", "web-search"],
    ["ask_user_question", "Ask questions. Examples include library choices.", "other"],
    ["mcp__fastctx__read_file", "Read a local file", "file-read"],
    ["mcp__git__git_status", "Shows the working tree status", "git"],
  ])("classifies %s without confusing providers with generic verbs", (name, description, capability) => {
    expect(toolCapability({ name, description })).toBe(capability);
  });
});
