import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager,
  type AgentSession, type ExtensionAPI, type ExtensionContext, type ExtensionToolContext,
  type SessionEntry, type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream, type AssistantMessage, type JsonValue, type Model, type ToolResultMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Type } from "typebox";
import { createConfirmationResponse, findPendingConfirmation, type PendingConfirmation } from "../../shared/confirmation.js";
import { historyMessages, mapTimeline } from "./timeline-mapper.js";
import { CONFIRMATION_TOOL_NAME, ConfirmationService } from "./confirmation.js";

const parameters = { title: "修改文件", message: "更新入口文件。" };
const request: PendingConfirmation = { ...parameters, requestId: "confirm-1" };
const model: Model<"openai-responses"> = {
  id: "gpt-4o", name: "Test model", api: "openai-responses", provider: "openai",
  baseUrl: "https://api.openai.com/v1", reasoning: false, input: ["text"],
  contextWindow: 128_000, maxTokens: 16_384,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};
const directories: string[] = [];
const sessions: AgentSession[] = [];

afterEach(async () => {
  for (const session of sessions.splice(0)) session.dispose();
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

type ToolCallHandler = (event: { toolName: string; toolCallId: string }, context: ExtensionContext) => unknown;

function harness() {
  let tool: ToolDefinition | undefined;
  let handler: ToolCallHandler | undefined;
  const service = new ConfirmationService();
  const pi = {
    on: (name: string, callback: ToolCallHandler) => { if (name === "tool_call") handler = callback; },
    registerTool: (definition: ToolDefinition) => { tool = definition; },
  } as unknown as ExtensionAPI;
  const extension = service.asExtension();
  if (typeof extension === "function") void extension(pi); else void extension.factory(pi);
  if (!tool || !handler) throw new Error("确认工具未注册。");
  return { service, tool, handler };
}

function assistant(calls = [{ type: "toolCall" as const, id: request.requestId, name: CONFIRMATION_TOOL_NAME, arguments: parameters }]): AssistantMessage {
  return {
    role: "assistant", content: calls, api: model.api, provider: model.provider, model: model.id,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: "toolUse", timestamp: 2,
  };
}

async function pendingResult(test = harness()): Promise<ToolResultMessage> {
  const result = await test.tool.execute(request.requestId, parameters, undefined, undefined, {} as ExtensionToolContext);
  return { role: "toolResult", toolCallId: request.requestId, toolName: CONFIRMATION_TOOL_NAME,
    content: result.content, details: result.details as JsonValue, isError: false, timestamp: 3 };
}

function entry(message: AssistantMessage | ToolResultMessage): SessionEntry {
  return { type: "message", id: `entry-${message.timestamp}`, parentId: null, timestamp: "now", message };
}

function sessionWithBranch(branch: SessionEntry[], isIdle = true): AgentSession {
  return { isIdle, sessionManager: { getBranch: () => branch } } as unknown as AgentSession;
}

async function sdkSession(manager?: SessionManager) {
  const root = await mkdtemp(join(tmpdir(), "ecode-confirmation-"));
  directories.push(root);
  const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
  const service = new ConfirmationService();
  const resourceLoader = new DefaultResourceLoader({
    cwd: root, agentDir: root, settingsManager, noExtensions: true,
    noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
    extensionFactories: [service.asExtension()],
  });
  await resourceLoader.reload();
  const modelRuntime = await ModelRuntime.create({ authPath: join(root, "auth.json"), modelsPath: join(root, "models.json") });
  await modelRuntime.setRuntimeApiKey("openai", "test-key");
  const sibling = vi.fn(async () => ({ content: [{ type: "text" as const, text: "unexpected execution" }], details: {} }));
  const { session } = await createAgentSession({ cwd: root, agentDir: root, model, modelRuntime,
    resourceLoader, settingsManager, sessionManager: manager ?? SessionManager.create(root, join(root, "sessions")),
    tools: [CONFIRMATION_TOOL_NAME, "write_probe"], thinkingLevel: "off",
    customTools: [{ name: "write_probe", label: "Probe", description: "Observe sibling execution",
      parameters: Type.Object({}), execute: sibling }],
  });
  sessions.push(session);
  await session.bindExtensions({ mode: "rpc" });
  service.install(session);
  return { session, service, sibling };
}

describe("ConfirmationService", () => {
  it("returns a durable pending result immediately without invoking UI", async () => {
    const test = harness();
    const confirm = vi.fn();
    const result = await test.tool.execute(request.requestId, parameters, undefined, undefined,
      { ui: { confirm } } as unknown as ExtensionToolContext);
    expect(confirm).not.toHaveBeenCalled();
    expect(result).toMatchObject({ terminate: true, details: {
      kind: "pi-ecode.confirmation", version: 1, status: "pending", ...request,
    } });
    expect(result.content).toHaveLength(2);
    expect(result.content[1]).toEqual({ type: "text", text: JSON.stringify({
      kind: "pi-ecode.confirmation", version: 1, status: "pending", requestId: request.requestId,
    }) });
  });

  it("allows only the first confirmation and blocks sibling tools and repeated confirmation", async () => {
    const test = harness();
    const branch = [entry(assistant([
      { type: "toolCall", id: "read-1", name: "read", arguments: parameters },
      { type: "toolCall", id: request.requestId, name: CONFIRMATION_TOOL_NAME, arguments: parameters },
      { type: "toolCall", id: "confirm-2", name: CONFIRMATION_TOOL_NAME, arguments: parameters },
    ]))];
    const context = { sessionManager: { getBranch: () => branch } } as unknown as ExtensionContext;
    expect(test.handler({ toolName: CONFIRMATION_TOOL_NAME, toolCallId: request.requestId }, context)).toBeUndefined();
    for (const event of [{ toolName: "read", toolCallId: "read-1" }, { toolName: CONFIRMATION_TOOL_NAME, toolCallId: "confirm-2" }]) {
      expect(test.handler(event, context)).toMatchObject({ block: true, terminate: true });
    }
    branch.push(entry(await pendingResult(test)));
    expect(test.handler({ toolName: CONFIRMATION_TOOL_NAME, toolCallId: request.requestId }, context)).toMatchObject({ block: true });
    branch.push({ type: "message", id: "user", parentId: null, timestamp: "now",
      message: { role: "user", content: "新任务", timestamp: 4 } });
    expect(test.handler({ toolName: "read", toolCallId: "read-new" }, context)).toBeUndefined();
  });

  it("validates the current persisted branch, action, title, idle state and details", async () => {
    const test = harness();
    const result = await pendingResult(test);
    const branch = [entry(assistant()), entry(result)];
    const session = sessionWithBranch(branch);
    const wire = createConfirmationResponse(request, true, "先验证");
    expect(() => test.service.assertResponse(session, wire)).not.toThrow();
    expect(() => test.service.assertResponse(sessionWithBranch(branch, false), wire)).toThrow("等待");
    expect(() => test.service.assertResponse(session, wire, true)).toThrow("等待");
    expect(() => test.service.assertResponse(session, createConfirmationResponse({ ...request, requestId: "old" }, true, ""))).toThrow("失效");
    expect(() => test.service.assertResponse(session, wire.replace("确认执行", "取消执行"))).toThrow("不匹配");
    expect(() => test.service.assertResponse(session, wire.replace("修改文件", "其他标题"))).toThrow("不匹配");
    expect(() => test.service.assertResponse(session, wire + "extra")).toThrow("格式");
    expect(() => test.service.assertResponse(sessionWithBranch([]), "普通文字")).not.toThrow();
    expect(() => test.service.assertResponse(sessionWithBranch([entry(assistant()), entry({ ...result, details: { confirmed: true } })]), wire)).toThrow("失效");
    branch.push({ type: "message", id: "response", parentId: null, timestamp: "now",
      message: { role: "user", content: wire, timestamp: 4 } });
    expect(() => test.service.assertResponse(session, wire)).toThrow("失效");
  });

  it("keeps a real SDK run idle with queued steer/follow-up and an existing finishTurn continue", async () => {
    const { session, service } = await sdkSession();
    let release!: () => void;
    const ready = new Promise<void>((resolve) => { release = resolve; });
    const provider = vi.fn(() => {
      const stream = createAssistantMessageEventStream();
      void ready.then(() => stream.push({ type: "done", reason: "toolUse", message: assistant() }));
      return stream;
    });
    session.agent.streamFunction = provider;
    const previous = vi.fn(() => ({ action: "continue" as const }));
    // Install another service to verify composition with a pre-existing finishTurn handler.
    session.agent.finishTurn = previous;
    const composed = new ConfirmationService();
    composed.install(session);
    composed.install(session);
    const operation = session.prompt("请求确认");
    await vi.waitFor(() => expect(provider).toHaveBeenCalledTimes(1));
    await session.steer("排队修订");
    await session.followUp("排队后续");
    release();
    await operation;
    expect(previous).toHaveBeenCalledTimes(1);
    expect(provider).toHaveBeenCalledTimes(1);
    expect(session.isIdle).toBe(true);
    expect(session.pendingMessageCount).toBe(0);
    expect(findPendingConfirmation(mapTimeline(historyMessages(session.sessionManager.getBranch())))).toEqual(request);
    const wire = createConfirmationResponse(request, true, "");
    expect(() => service.assertResponse(session, wire)).not.toThrow();
    const file = session.sessionFile!;
    const restored = await sdkSession(SessionManager.open(file));
    expect(() => restored.service.assertResponse(restored.session, wire)).not.toThrow();
    const branch = restored.session.sessionManager.getBranch();
    const beforeConfirmation = branch.find((candidate) => candidate.type === "message" && candidate.message.role === "user")!;
    restored.session.sessionManager.branch(beforeConfirmation.id);
    expect(() => restored.service.assertResponse(restored.session, wire)).toThrow("失效");
  });

  it("records background notifications while pending without restarting the real SDK", async () => {
    const { session, service } = await sdkSession();
    let requests = 0;
    const provider = vi.fn(() => {
      const stream = createAssistantMessageEventStream();
      requests += 1;
      const message = requests === 1 ? assistant() : { ...assistant([]), stopReason: "stop" as const };
      stream.push({ type: "done", reason: message.stopReason === "toolUse" ? "toolUse" : "stop", message });
      return stream;
    });
    session.agent.streamFunction = provider;
    let notified = false;
    const unsubscribe = session.subscribe(async (event) => {
      if (event.type !== "agent_settled" || notified) return;
      notified = true;
      await session.sendCustomMessage({ customType: "explorer-finished", content: "子代理已完成", display: false },
        { triggerTurn: true, deliverAs: "followUp" });
    });
    await session.prompt("确认方案");
    unsubscribe();
    await session.sendCustomMessage({ customType: "validation-finished", content: "验证已完成", display: false },
      { triggerTurn: true, deliverAs: "followUp" });
    expect(provider).toHaveBeenCalledTimes(1);
    expect(session.isIdle).toBe(true);
    const notifications = session.sessionManager.getBranch().filter((candidate) => candidate.type === "custom_message");
    expect(notifications.map((candidate) => candidate.customType)).toEqual(["explorer-finished", "validation-finished"]);
    const wire = createConfirmationResponse(request, true, "先检查验证结果");
    service.assertResponse(session, wire);
    await session.prompt(wire);
    expect(provider).toHaveBeenCalledTimes(2);
    await session.sendCustomMessage({ customType: "later-notification", content: "后续通知", display: false },
      { triggerTurn: true, deliverAs: "followUp" });
    expect(provider).toHaveBeenCalledTimes(3);
  });

  it("blocks a real SDK sibling batch and retains only its first pending confirmation", async () => {
    const { session, sibling } = await sdkSession();
    const provider = vi.fn(() => {
      const stream = createAssistantMessageEventStream();
      stream.push({ type: "done", reason: "toolUse", message: assistant([
        { type: "toolCall", id: "probe", name: "write_probe", arguments: parameters },
        { type: "toolCall", id: request.requestId, name: CONFIRMATION_TOOL_NAME, arguments: parameters },
        { type: "toolCall", id: "confirm-2", name: CONFIRMATION_TOOL_NAME, arguments: parameters },
      ]) });
      return stream;
    });
    session.agent.streamFunction = provider;
    await session.prompt("混合工具请求");
    expect(provider).toHaveBeenCalledTimes(1);
    expect(sibling).not.toHaveBeenCalled();
    expect(session.isIdle).toBe(true);
    const results = session.messages.filter((message) => message.role === "toolResult");
    expect(results.map((result) => result.isError)).toEqual([true, false, true]);
    expect(findPendingConfirmation(mapTimeline(historyMessages(session.sessionManager.getBranch())))).toEqual(request);
  });

  it("rejects double clicks during and after the accepted real SDK reply while allowing ordinary text", async () => {
    const { session, service } = await sdkSession();
    session.agent.streamFunction = () => {
      const stream = createAssistantMessageEventStream();
      stream.push({ type: "done", reason: "toolUse", message: assistant() });
      return stream;
    };
    await session.prompt("确认方案");
    const wire = createConfirmationResponse(request, false, "采用其他方案");
    service.assertResponse(session, wire);
    let release!: () => void;
    const ready = new Promise<void>((resolve) => { release = resolve; });
    session.agent.streamFunction = () => {
      const stream = createAssistantMessageEventStream();
      void ready.then(() => stream.push({ type: "done", reason: "stop", message: { ...assistant([]), stopReason: "stop" } }));
      return stream;
    };
    const operation = session.prompt(wire);
    // The host also treats asynchronous preflight as active, before SDK isIdle changes.
    expect(() => service.assertResponse(session, wire, true)).toThrow("等待");
    await vi.waitFor(() => expect(session.isIdle).toBe(false));
    expect(() => service.assertResponse(session, wire)).toThrow("等待");
    release();
    await operation;
    expect(() => service.assertResponse(session, wire)).toThrow("失效");
    expect(() => service.assertResponse(session, "普通文字继续")).not.toThrow();
    await session.prompt("普通文字继续");
    expect(session.isIdle).toBe(true);
  });
});
