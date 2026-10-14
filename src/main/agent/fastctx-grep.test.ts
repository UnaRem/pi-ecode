import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager, type AgentSession } from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream, type AssistantMessage, type Model, type ToolCall } from "@earendil-works/pi-ai";
import { createInMemoryTransportPair } from "@earendil-works/pi-mcp/testing";
import type { JsonRpcRequest, Tool } from "@earendil-works/pi-mcp";
import { NativeMcp } from "./native-mcp.js";

const model: Model<"openai-responses"> = { id: "fixture", name: "fixture", provider: "openai", api: "openai-responses",
  baseUrl: "https://fixture.invalid/v1", reasoning: false, input: ["text"], contextWindow: 32768, maxTokens: 128,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
const sessions: AgentSession[] = [];
const roots: string[] = [];
afterEach(async () => {
  for (const session of sessions.splice(0)) {
    await session.extensionRunner!.emit({ type: "session_shutdown", reason: "quit" });
    session.dispose();
  }
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function assistant(calls: ToolCall[]): AssistantMessage {
  return { role: "assistant", content: calls, api: model.api, provider: model.provider, model: model.id,
    stopReason: calls.length ? "toolUse" : "stop", timestamp: Date.now(),
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
}

async function harness() {
  const cwd = await mkdtemp(join(tmpdir(), "pi-ecode-grep-input-"));
  roots.push(cwd);
  const { client, server } = createInMemoryTransportPair();
  const inputSchema = { type: "object", properties: { pattern: { type: "string" }, path: { type: "string" },
    encoding: { type: "string" }, fallback_encoding: { type: "string" },
    glob: { type: "array", items: { type: "string" } } }, required: ["pattern"] };
  const offered: Tool[] = ["grep", "lookup"].map((name) => ({ name, description: name, inputSchema }));
  const calls: JsonRpcRequest[] = [];
  server.onMessage((message) => {
    if (!("method" in message) || !("id" in message)) return;
    if (message.method === "tools/call") calls.push(message);
    const parameters = message.params as { arguments?: Record<string, unknown> } | undefined;
    const input = parameters?.arguments;
    const conflict = input?.path === "directory" ? input.encoding !== undefined : input?.fallback_encoding !== undefined;
    const invalidPattern = input?.pattern === "";
    const invalidGlob = Array.isArray(input?.glob) && (input.glob.length === 0 || input.glob.includes("["));
    const result = message.method === "initialize"
      ? { protocolVersion: "2025-11-25", capabilities: { tools: {} }, serverInfo: { name: "fixture", version: "1" } }
      : message.method === "tools/list" ? { tools: offered }
      : message.method === "tools/call" ? { content: [{ type: "text", text: conflict ? "encoding target conflict" : invalidPattern ? "empty pattern" : invalidGlob ? "invalid glob" : "matched" }],
        isError: conflict || invalidPattern || invalidGlob } : {};
    void server.send({ jsonrpc: "2.0", id: message.id, result });
  });
  await server.start();
  const native = new NativeMcp(() => undefined);
  const settingsManager = SettingsManager.inMemory({ retry: { enabled: false }, compaction: { enabled: false } });
  const loader = new DefaultResourceLoader({ cwd, agentDir: cwd, settingsManager, noExtensions: true,
    noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
    extensionFactories: native.extensions({ loadConfig: () => ({ servers: [{ name: "fastctx", source: "fixture",
      config: { url: "https://fixture.invalid/mcp", exposure: "deferred" } }], errors: [] }),
    createTransport: () => client, logPath: join(cwd, "mcp.log") }),
  });
  await loader.reload();
  const modelRuntime = await ModelRuntime.create({ authPath: join(cwd, "auth.json"), modelsPath: join(cwd, "models.json") });
  await modelRuntime.setRuntimeApiKey("openai", "fixture");
  const { session } = await createAgentSession({ cwd, agentDir: cwd, model, modelRuntime, thinkingLevel: "off",
    resourceLoader: loader, settingsManager, sessionManager: SessionManager.inMemory(cwd) });
  sessions.push(session);
  await session.bindExtensions({});
  await vi.waitFor(() => expect(native.current).toHaveLength(2));
  session.setActiveToolsByName(["mcp__fastctx__grep", "mcp__fastctx__lookup"]);
  return { session, calls };
}

async function directCalls(session: AgentSession, calls: ToolCall[]) {
  let request = 0;
  // Supply deterministic model output while exercising the normal direct tool execution pipeline.
  session.agent.streamFunction = () => {
    const stream = createAssistantMessageEventStream();
    const message = assistant(request++ === 0 ? calls : []);
    stream.push({ type: "done", reason: message.stopReason === "toolUse" ? "toolUse" : "stop", message });
    return stream;
  };
  await session.prompt("Check grep parameters");
  return session.messages.filter((message) => message.role === "toolResult");
}

function grepCall(id: string, arguments_: ToolCall["arguments"]): ToolCall {
  return { type: "toolCall", id, name: "mcp__fastctx__grep", arguments: arguments_ };
}

function sentArguments(calls: JsonRpcRequest[]): unknown[] {
  return calls.map((call) => (call.params as { arguments: unknown }).arguments);
}

describe("FastCtx grep input normalization", () => {
  it("omits empty encoding placeholders for direct and nested calls, keeping meaningful values", async () => {
    const { session, calls } = await harness();
    const emptyInput = { pattern: "needle", path: "file", encoding: "", fallback_encoding: "" };
    const results = await directCalls(session, [
      grepCall("empty", emptyInput),
      grepCall("file", { pattern: "needle", path: "file", encoding: "gbk", fallback_encoding: "" }),
      grepCall("directory", { pattern: "needle", path: "directory", encoding: "", fallback_encoding: "gbk" }),
      grepCall("null", { pattern: "needle", path: "file", encoding: null, fallback_encoding: null }),
      grepCall("omitted", { pattern: "needle", path: "file" }),
    ]);
    expect(results).toHaveLength(5);
    expect(results.every((result) => !result.isError)).toBe(true);
    expect(emptyInput).toEqual({ pattern: "needle", path: "file", encoding: "", fallback_encoding: "" });
    expect(sentArguments(calls)).toEqual(expect.arrayContaining([
      { pattern: "needle", path: "file" },
      { pattern: "needle", path: "file", encoding: "gbk" },
      { pattern: "needle", path: "directory", fallback_encoding: "gbk" },
    ]));
    expect(sentArguments(calls).filter((input) => JSON.stringify(input) === JSON.stringify({ pattern: "needle", path: "file" }))).toHaveLength(3);
    const context = session.extensionRunner!.createToolContext("empty", undefined);
    const nested = await context.executeTool("mcp__fastctx__grep", { pattern: "nested", encoding: "", fallback_encoding: "" });
    expect(nested.isError).toBe(false);
    expect(sentArguments(calls).at(-1)).toEqual({ pattern: "nested" });
    const schema = session.getAllTools().find((tool) => tool.name === "mcp__fastctx__grep")!.parameters;
    expect(schema).toMatchObject({ required: ["pattern"] });
  });

  it("omits empty glob filters for direct and nested calls while preserving nonempty filters", async () => {
    const { session, calls } = await harness();
    const emptyInput = { pattern: "needle", glob: [] };
    const filteredInput = { pattern: "needle", glob: ["**/*.ts", "!**/*.test.ts"] };
    const results = await directCalls(session, [
      grepCall("empty", emptyInput),
      grepCall("omitted", { pattern: "needle" }),
      grepCall("null", { pattern: "needle", glob: null }),
      grepCall("filtered", filteredInput),
    ]);
    expect(results).toHaveLength(4);
    expect(results.every((result) => !result.isError)).toBe(true);
    expect(emptyInput).toEqual({ pattern: "needle", glob: [] });
    expect(sentArguments(calls)).toEqual([
      { pattern: "needle" }, { pattern: "needle" }, { pattern: "needle" }, filteredInput,
    ]);
    const context = session.extensionRunner!.createToolContext("empty", undefined);
    const nested = await context.executeTool("mcp__fastctx__grep", { pattern: "nested", glob: [] });
    expect(nested.isError).toBe(false);
    expect(sentArguments(calls).at(-1)).toEqual({ pattern: "nested" });
    const filtered = await context.executeTool("mcp__fastctx__grep", filteredInput);
    expect(filtered.isError).toBe(false);
    expect(sentArguments(calls).at(-1)).toEqual(filteredInput);
  });

  it("preserves invalid nonempty globs, schema validation and empty globs on other tools", async () => {
    const { session, calls } = await harness();
    const results = await directCalls(session, [
      grepCall("invalid", { pattern: "needle", glob: ["["] }),
      grepCall("wrong-type", { pattern: "needle", glob: "*.ts" }),
      grepCall("wrong-item", { pattern: "needle", glob: [{}] }),
      { type: "toolCall", id: "other", name: "mcp__fastctx__lookup", arguments: { pattern: "needle", glob: [] } },
    ]);
    expect(results).toHaveLength(4);
    expect(results.every((result) => result.isError)).toBe(true);
    expect(sentArguments(calls)).toEqual([
      { pattern: "needle", glob: ["["] }, { pattern: "needle", glob: [] },
    ]);
    expect(results.find((result) => result.toolCallId === "invalid")?.content).toEqual([
      expect.objectContaining({ text: "invalid glob" }),
    ]);
    for (const id of ["wrong-type", "wrong-item"]) {
      expect(results.find((result) => result.toolCallId === id)?.content).toEqual([
        expect.objectContaining({ text: expect.stringContaining("glob") }),
      ]);
    }
  });

  it("preserves nonempty conflicts, empty patterns, required validation and other tools", async () => {
    const { session, calls } = await harness();
    const results = await directCalls(session, [
      grepCall("conflict", { pattern: "needle", path: "file", encoding: "utf-8", fallback_encoding: "gbk" }),
      grepCall("missing", { path: "file", encoding: "", fallback_encoding: "" }),
      grepCall("pattern", { pattern: "", path: "file", encoding: "", fallback_encoding: "" }),
      { type: "toolCall", id: "other", name: "mcp__fastctx__lookup", arguments: { pattern: "needle", path: "file", fallback_encoding: "" } },
    ]);
    expect(results).toHaveLength(4);
    expect(results.every((result) => result.isError)).toBe(true);
    expect(calls).toHaveLength(3);
    expect(sentArguments(calls)).toEqual(expect.arrayContaining([
      { pattern: "needle", path: "file", encoding: "utf-8", fallback_encoding: "gbk" },
      { pattern: "", path: "file" },
      { pattern: "needle", path: "file", fallback_encoding: "" },
    ]));
    expect(results.find((result) => result.toolCallId === "missing")?.content).toEqual([
      expect.objectContaining({ text: expect.stringContaining("pattern") }),
    ]);
  });
});
