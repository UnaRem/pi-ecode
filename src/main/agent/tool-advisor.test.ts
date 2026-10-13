import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { Type } from "typebox";
import { createAgentSession, createToolSearchExtension, DefaultResourceLoader, SessionManager, SettingsManager, type ToolInfo } from "@earendil-works/pi-coding-agent";
import { toolAdvisorExtension } from "./tool-advisor.js";
import { ToolStatisticsStore } from "./tool-statistics.js";

function sessionWithParentCall(cwd: string): SessionManager {
  const manager = SessionManager.inMemory(cwd);
  manager.appendMessage({ role: "assistant", content: [{ type: "toolCall", id: "parent", name: "parent_tool", arguments: {} }],
    api: "openai-completions", provider: "fixture", model: "fixture", stopReason: "toolUse", timestamp: 1,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });
  return manager;
}

describe("tool advisor SDK hooks", () => {
  it("guides every request and records actual nested execution, failure and blocking", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-ecode-advisor-"));
    const store = new ToolStatisticsStore(join(cwd, "statistics.json"));
    await store.initialize();
    const onError = vi.fn();
    const settingsManager = SettingsManager.inMemory();
    const loader = new DefaultResourceLoader({ cwd, agentDir: join(cwd, "agent"), settingsManager,
      extensionFactories: [toolAdvisorExtension(store, onError), (pi) => {
        for (const name of ["read_fixture", "read_failure", "read_blocked", "codegraph_explore"]) pi.registerTool({ name, label: name, description: "Read a file",
          parameters: Type.Object({}), async execute() {
            if (name === "read_failure") throw new Error("permission denied");
            return { content: [{ type: "text", text: "read complete" }], details: undefined };
          } });
        pi.on("tool_call", (event) => event.toolName === "read_blocked" ? { block: true, reason: "fixture policy" } : undefined);
      }],
    });
    await loader.reload();
    const manager = sessionWithParentCall(cwd);
    const { session } = await createAgentSession({ cwd, agentDir: join(cwd, "agent"), resourceLoader: loader, settingsManager, sessionManager: manager });
    try {
      await session.bindExtensions({});
      const branchBefore = session.sessionManager.getBranch();
      const messages = await session.extensionRunner!.emitContext([{ role: "user", content: "读取源码文件", timestamp: 1 }]);
      expect(JSON.stringify(messages)).toContain("Tool selection guidance");
      expect(JSON.stringify(messages)).not.toContain("Local tool candidates");
      const coldStart = await session.extensionRunner!.emitContext([]);
      expect(coldStart).toEqual([expect.objectContaining({ role: "custom", customType: "pi-ecode.tool-advice", display: false })]);
      expect(JSON.stringify(coldStart)).toContain("tool_search");
      expect(session.sessionManager.getBranch()).toEqual(branchBefore);
      const context = session.extensionRunner!.createToolContext("parent", undefined);
      await context.executeTool("read_fixture", {});
      await context.executeTool("read_failure", {});
      await context.executeTool("read_blocked", {});
      const unavailable = await context.executeTool("codegraph_explore", {});
      expect(JSON.stringify(unavailable)).toContain("codegraph.db");
      await store.flush();
      expect(store.current.find((entry) => entry.name === "read_fixture")).toMatchObject({ nested: true, successes: 1 });
      expect(store.current.find((entry) => entry.name === "read_failure")).toMatchObject({ nested: true, failures: 1 });
      expect(store.current.find((entry) => entry.name === "read_blocked")).toMatchObject({ nested: true, blocked: 1, medianMs: null });
      expect(store.current.find((entry) => entry.name === "codegraph_explore")).toMatchObject({ nested: true, blocked: 1, successes: 0 });
      const feedback = JSON.stringify(await session.extensionRunner!.emitContext([]));
      expect(feedback).toContain("read_fixture: samples=1, sampleMode=nested");
      expect(feedback).not.toContain("codegraph_explore: samples");
      expect(session.sessionManager.getBranch()).toEqual(branchBefore);
      expect(onError).not.toHaveBeenCalled();
    } finally {
      session.dispose();
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("discovers concrete operations across capabilities without promoting unrelated execution history", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-ecode-discovery-"));
    const store = new ToolStatisticsStore(join(cwd, "statistics.json"));
    await store.initialize();
    await Promise.all(Array.from({ length: 5 }, () => store.record({ name: "mcp__git__git_add", capability: "git", nested: false,
      outcome: "successes", durationMs: 1 })));
    const onError = vi.fn();
    const settingsManager = SettingsManager.inMemory({ defaultTools: ["+tool_search"] });
    const execute = vi.fn(async () => ({ content: [{ type: "text" as const, text: "fixture complete" }], details: undefined }));
    const definitions: Pick<ToolInfo, "name" | "description" | "parameters">[] = [
      { name: "mcp__git__git_add", description: "Adds files to the staging area", parameters: Type.Object({ repo_path: Type.String(), files: Type.Array(Type.String()) }) },
      { name: "mcp__git__git_branch", description: "Lists repository branches", parameters: Type.Object({ repo_path: Type.String() }) },
      { name: "mcp__git__git_status", description: "Shows the working tree status", parameters: Type.Object({ repo_path: Type.String() }) },
      { name: "mcp__fastctx__grep", description: "Search file contents using regular expressions", parameters: Type.Object({ query: Type.String() }) },
      { name: "mcp__docs__search", description: "Search web documentation pages", parameters: Type.Object({ query: Type.String() }) },
      { name: "mcp__browser__click", description: "Click a browser page element", parameters: Type.Object({ selector: Type.String() }) },
    ];
    const loader = new DefaultResourceLoader({ cwd, agentDir: join(cwd, "agent"), settingsManager,
      extensionFactories: [createToolSearchExtension(), toolAdvisorExtension(store, onError), (pi) => {
        for (const definition of definitions) pi.registerTool({ ...definition, label: definition.name, exposure: "deferred", execute });
      }],
    });
    await loader.reload();
    const { session } = await createAgentSession({ cwd, agentDir: join(cwd, "agent"), resourceLoader: loader, settingsManager, sessionManager: sessionWithParentCall(cwd) });
    try {
      await session.bindExtensions({});
      expect(session.getActiveToolNames()).toContain("tool_search");
      const before = JSON.stringify(await session.extensionRunner!.emitContext([]));
      expect(before).toContain("Tool selection guidance");
      expect(before).not.toContain("mcp__git__git_add");
      const context = session.extensionRunner!.createToolContext("parent", undefined);
      // tool_search is model-only; use its registered definition as in the native MCP integration tests.
      const search = session.extensionRunner!.getAllRegisteredTools().find((tool) => tool.definition.name === "tool_search")!.definition;
      for (const [query, name] of [
        ["git working tree status", "mcp__git__git_status"],
        ["file contents regular expressions", "mcp__fastctx__grep"],
        ["web documentation search", "mcp__docs__search"],
        ["browser click element selector", "mcp__browser__click"],
      ] as const) {
        const result = await search.execute("search", { query, limit: 1 }, undefined, undefined, context);
        expect(result).toMatchObject({ details: { loaded: [name] } });
        expect(session.getActiveToolNames()).toContain(name);
      }
      expect(execute).not.toHaveBeenCalled();
      const status = await context.executeTool("mcp__git__git_status", { repo_path: cwd });
      expect(status.isError, JSON.stringify(status)).toBe(false);
      await store.flush();
      const branchBefore = session.sessionManager.getBranch();
      const after = JSON.stringify(await session.extensionRunner!.emitContext([{ role: "user", content: "读取源码文件", timestamp: 1 }]));
      expect(after).toContain("mcp__git__git_status: samples=1, sampleMode=nested");
      expect(after).not.toContain("mcp__git__git_add");
      expect(after).not.toContain("mcp__git__git_branch");
      expect(session.sessionManager.getBranch()).toEqual(branchBefore);
      expect(onError).not.toHaveBeenCalled();
    } finally {
      await store.flush();
      session.dispose();
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
