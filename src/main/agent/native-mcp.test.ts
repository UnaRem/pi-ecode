import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager, type AgentSession } from "@earendil-works/pi-coding-agent";
import { createInMemoryTransportPair } from "@earendil-works/pi-mcp/testing";
import type { JsonRpcRequest, Tool } from "@earendil-works/pi-mcp";
import { NativeMcp } from "./native-mcp.js";

const sessions: AgentSession[] = [];
const roots: string[] = [];
afterEach(async () => {
  for (const session of sessions.splice(0)) {
    await session.extensionRunner?.emit({ type: "session_shutdown", reason: "quit" });
    session.dispose();
  }
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function harness(resources = false) {
  const cwd = await mkdtemp(join(tmpdir(), "pi-ecode-native-mcp-"));
  roots.push(cwd);
  const { client, server } = createInMemoryTransportPair();
  let offered: Tool[] = [{ name: "lookup", description: "Find a documentation page", inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] } }];
  const calls: JsonRpcRequest[] = [];
  server.onMessage((message) => {
    if (!("method" in message) || !("id" in message)) return;
    if (message.method === "tools/call") calls.push(message);
    const result = message.method === "initialize"
      ? { protocolVersion: "2025-11-25", capabilities: { tools: { listChanged: true }, ...(resources ? { resources: {} } : {}) }, serverInfo: { name: "fixture", version: "1" } }
      : message.method === "tools/list" ? { tools: offered }
      : message.method === "tools/call" ? { content: [{ type: "text", text: "documentation found" }] } : {};
    void server.send({ jsonrpc: "2.0", id: message.id, result });
  });
  await server.start();
  const onChange = vi.fn();
  const native = new NativeMcp(onChange);
  const settingsManager = SettingsManager.inMemory();
  const resourceLoader = new DefaultResourceLoader({ cwd, agentDir: join(cwd, "agent"), settingsManager,
    extensionFactories: native.extensions({
      loadConfig: () => ({ servers: [{ name: "docs", source: "fixture", config: { url: "https://fixture.invalid/mcp", exposure: "deferred" } }], errors: [] }),
      createTransport: () => client,
      logPath: join(cwd, "mcp.log"),
    }),
  });
  await resourceLoader.reload();
  const { session } = await createAgentSession({ cwd, agentDir: join(cwd, "agent"), resourceLoader, settingsManager, sessionManager: SessionManager.inMemory(cwd) });
  sessions.push(session);
  await session.bindExtensions({});
  await vi.waitFor(() => expect(native.current).toHaveLength(resources ? 4 : 1));
  return { native, onChange, session, calls, async withdraw() {
    offered = [];
    await server.send({ jsonrpc: "2.0", method: "notifications/tools/list_changed" });
  } };
}

describe("native MCP", () => {
  it("discovers deferred tools, loads them through tool_search and calls the real MCP pipeline", async () => {
    const { native, session, calls } = await harness();
    expect(native.current[0]).toMatchObject({ name: "mcp__docs__lookup", server: "docs", exposure: "deferred" });
    expect(session.getActiveToolNames()).toContain("tool_search");
    const context = session.extensionRunner!.createToolContext("fixture", undefined);
    const search = session.extensionRunner!.getAllRegisteredTools().find((tool) => tool.definition.name === "tool_search")!.definition;
    const found = await search.execute("search", { query: "documentation" }, undefined, undefined, context);
    expect(JSON.stringify(found)).toContain("mcp__docs__lookup");
    expect(session.getActiveToolNames()).toContain("mcp__docs__lookup");
    const lookup = session.extensionRunner!.getAllRegisteredTools().find((tool) => tool.definition.name === "mcp__docs__lookup")!.definition;
    const result = await lookup.execute("lookup", { query: "SDK" }, undefined, undefined, context);
    expect(result.content).toEqual([{ type: "text", text: "documentation found" }]);
    expect(calls[0]?.params).toMatchObject({ name: "lookup", arguments: { query: "SDK" } });
  });

  it("removes withdrawn tools from the session directory", async () => {
    const { native, session, onChange, withdraw } = await harness();
    await withdraw();
    await vi.waitFor(() => expect(native.current).toEqual([]));
    expect(onChange).toHaveBeenLastCalledWith([]);
    expect(session.getAllTools().find((tool) => tool.name === "mcp__docs__lookup")?.exposure).toBe("hidden");
  });

  it("includes shared resource tools when a server advertises resources", async () => {
    const { native } = await harness(true);
    expect(native.current.filter(tool => tool.server === "MCP resources").map(tool => tool.name)).toEqual([
      "list_mcp_resource_templates", "list_mcp_resources", "read_mcp_resource",
    ]);
  });

  it("isolates tool directories across sessions", async () => {
    const first = await harness();
    const second = await harness();
    await first.withdraw();
    await vi.waitFor(() => expect(first.native.current).toEqual([]));
    expect(second.native.current).toHaveLength(1);
  });

  it("clears registered tools on session shutdown", async () => {
    const { native, session } = await harness();
    await session.extensionRunner!.emit({ type: "session_shutdown", reason: "quit" });
    expect(native.current).toEqual([]);
  });
});
