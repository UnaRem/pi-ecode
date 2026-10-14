import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager, type AgentSession } from "@earendil-works/pi-coding-agent";
import { createInMemoryTransportPair } from "@earendil-works/pi-mcp/testing";
import type { JsonRpcRequest, Tool } from "@earendil-works/pi-mcp";
import type { AgentEvent } from "../../shared/contracts.js";
import type { McpToolSummary } from "../../shared/mcp-contracts.js";
import { AgentService } from "./agent-service.js";
import { EMPTY_AGENT_SNAPSHOT } from "./empty-agent-snapshot.js";
import { NativeMcp } from "./native-mcp.js";
import { toolAdvisorExtension } from "./tool-advisor.js";
import { ToolStatisticsStore } from "./tool-statistics.js";

const sessions: AgentSession[] = [];
const stores: ToolStatisticsStore[] = [];
const roots: string[] = [];
afterEach(async () => {
  for (const session of sessions.splice(0)) {
    await session.extensionRunner!.emit({ type: "session_shutdown", reason: "quit" });
    session.dispose();
  }
  await Promise.all(stores.splice(0).map((store) => store.flush()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function availabilityHarness() {
  const cwd = await mkdtemp(join(tmpdir(), "pi-ecode-availability-"));
  roots.push(cwd);
  const store = new ToolStatisticsStore(join(cwd, "statistics.json"));
  stores.push(store);
  await store.initialize();
  const { client, server } = createInMemoryTransportPair();
  const definition: Tool = { name: "git_status", description: "Shows the working tree status",
    inputSchema: { type: "object", properties: { repo_path: { type: "string" } }, required: ["repo_path"] } };
  let offered = [definition];
  const calls: JsonRpcRequest[] = [];
  server.onMessage((message) => {
    if (!("method" in message) || !("id" in message)) return;
    if (message.method === "tools/call") calls.push(message);
    const result = message.method === "initialize"
      ? { protocolVersion: "2025-11-25", capabilities: { tools: { listChanged: true } }, serverInfo: { name: "fixture", version: "1" } }
      : message.method === "tools/list" ? { tools: offered }
      : message.method === "tools/call" ? { content: [{ type: "text", text: "working tree clean" }] } : {};
    void server.send({ jsonrpc: "2.0", id: message.id, result });
  });
  await server.start();
  const service = new AgentService();
  const publisher = service as unknown as { publishMcpTools: (session: AgentSession, tools: McpToolSummary[]) => void;
    sessionMcp: WeakMap<AgentSession, NativeMcp> };
  const events: AgentEvent[] = [];
  service.subscribe((event) => events.push(event));
  let owner: AgentSession | undefined;
  const native = new NativeMcp((tools) => { if (owner) publisher.publishMcpTools(owner, tools); });
  const settingsManager = SettingsManager.inMemory();
  const loader = new DefaultResourceLoader({ cwd, agentDir: join(cwd, "agent"), settingsManager,
    extensionFactories: [...native.extensions({
      loadConfig: () => ({ servers: [{ name: "git", source: "fixture", config: { url: "https://fixture.invalid/mcp", exposure: "deferred" } }], errors: [] }),
      createTransport: () => client, logPath: join(cwd, "mcp.log"),
    }), toolAdvisorExtension(store, (message) => { throw new Error(message); })],
  });
  await loader.reload();
  const manager = SessionManager.inMemory(cwd);
  manager.appendMessage({ role: "assistant", content: [{ type: "toolCall", id: "parent", name: "parent_tool", arguments: {} }],
    api: "openai-completions", provider: "fixture", model: "fixture", stopReason: "toolUse", timestamp: 1,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });
  const { session } = await createAgentSession({ cwd, agentDir: join(cwd, "agent"), resourceLoader: loader, settingsManager, sessionManager: manager });
  sessions.push(session);
  owner = session;
  Object.assign(service, { projectPath: cwd, runtime: { session, diagnostics: [] }, statistics: store,
    history: { getSnapshot: async () => ({ history: EMPTY_AGENT_SNAPSHOT.history, review: EMPTY_AGENT_SNAPSHOT.review }) } });
  publisher.sessionMcp.set(session, native);
  await session.bindExtensions({});
  await vi.waitFor(() => expect(native.current).toHaveLength(1));
  return { session, service, publisher, store, native, events, calls, async offer(available: boolean) {
    offered = available ? [definition] : [];
    await server.send({ jsonrpc: "2.0", method: "notifications/tools/list_changed" });
    await vi.waitFor(() => expect(native.current).toHaveLength(available ? 1 : 0));
  } };
}

async function discoverStatus(session: AgentSession) {
  const context = session.extensionRunner!.createToolContext("parent", undefined);
  const search = session.extensionRunner!.getAllRegisteredTools().find((tool) => tool.definition.name === "tool_search")!.definition;
  const result = await search.execute("search", { query: "git working tree status", limit: 1 }, undefined, undefined, context);
  expect(result).toMatchObject({ details: { loaded: ["mcp__git__git_status"] } });
  return context;
}

describe("tool availability publication", () => {
  it("withdraws statistics immediately without deleting or pooling historical samples", async () => {
    const { session, service, publisher, store, events, calls, offer } = await availabilityHarness();
    // Seed a historical direct observation; the nested observation below uses the MCP pipeline.
    await store.record({ name: "mcp__git__git_status", capability: "git", nested: false, outcome: "successes", durationMs: 30 });
    expect((await service.getSnapshot()).toolStatistics).toEqual([]);
    const context = await discoverStatus(session);
    const result = await context.executeTool("mcp__git__git_status", { repo_path: session.sessionManager.getCwd() });
    expect(result.isError).toBe(false);
    await store.flush();
    const historical = store.current;
    expect(historical).toEqual([
      expect.objectContaining({ nested: false, successes: 1, medianMs: 30 }),
      expect.objectContaining({ nested: true, successes: 1 }),
    ]);
    expect((await service.getSnapshot()).toolStatistics).toEqual(historical);

    events.length = 0;
    await offer(false);
    expect(session.getAllTools().find((tool) => tool.name === "mcp__git__git_status")?.exposure).toBe("hidden");
    expect(session.getActiveToolNames()).not.toContain("mcp__git__git_status");
    expect(events).toEqual([{ type: "mcp-tools", tools: [] }, { type: "tool-statistics", statistics: [] }]);
    expect((await service.getSnapshot()).toolStatistics).toEqual([]);
    expect(store.current).toEqual(historical);
    expect(JSON.stringify(await session.extensionRunner!.emitContext([]))).not.toContain("mcp__git__git_status: samples");

    const withdrawn = await context.executeTool("mcp__git__git_status", { repo_path: session.sessionManager.getCwd() });
    expect(withdrawn.isError).toBe(true);
    await store.flush();
    expect(calls).toHaveLength(1);
    expect(store.current).toEqual([
      historical[0], expect.objectContaining({ nested: true, successes: 1, blocked: 1, medianMs: historical[1]!.medianMs }),
    ]);
    expect((await service.getSnapshot()).toolStatistics).toEqual([]);

    await offer(true);
    expect((await service.getSnapshot()).toolStatistics).toEqual([]);
    await discoverStatus(session);
    expect((await service.getSnapshot()).toolStatistics).toEqual(store.current);
    const restored = new ToolStatisticsStore(join(session.sessionManager.getCwd(), "statistics.json"));
    await restored.initialize();
    expect(restored.current).toEqual(store.current);

    events.length = 0;
    const staleSession = { sessionId: "stale" } as AgentSession;
    publisher.publishMcpTools(staleSession, []);
    expect(events).toEqual([]);
  });
});
