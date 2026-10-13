import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { Type } from "typebox";
import { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { toolAdvisorExtension } from "./tool-advisor.js";
import { ToolStatisticsStore } from "./tool-statistics.js";

describe("tool advisor SDK hooks", () => {
  it("recommends before requests and records actual nested execution, failure and blocking", async () => {
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
    const manager = SessionManager.inMemory(cwd);
    manager.appendMessage({ role: "assistant", content: [{ type: "toolCall", id: "parent", name: "parent_tool", arguments: {} }],
      api: "openai-completions", provider: "fixture", model: "fixture", stopReason: "toolUse", timestamp: 1,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });
    const { session } = await createAgentSession({ cwd, agentDir: join(cwd, "agent"), resourceLoader: loader, settingsManager, sessionManager: manager });
    try {
      await session.bindExtensions({});
      const branchBefore = session.sessionManager.getBranch();
      const messages = await session.extensionRunner!.emitContext([{ role: "user", content: "读取源码文件", timestamp: 1 }]);
      expect(JSON.stringify(messages)).toContain("Local tool candidates");
      expect(JSON.stringify(messages)).not.toContain("file-search: codegraph_explore");
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
      expect(onError).not.toHaveBeenCalled();
    } finally {
      session.dispose();
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
