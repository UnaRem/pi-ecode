import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager,
  type AgentSession,
} from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream, type AssistantMessage, type JsonObject, type Model } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Type } from "typebox";
import { ConfirmationService } from "./confirmation.js";
import { TaskPlanService } from "./task-plan.js";

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

function assistant(content: AssistantMessage["content"]): AssistantMessage {
  return { role: "assistant", content, api: model.api, provider: model.provider, model: model.id,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: content.some((block) => block.type === "toolCall") ? "toolUse" : "stop", timestamp: Date.now() };
}

function call(name: string, parameters: JsonObject): AssistantMessage {
  return assistant([{ type: "toolCall", id: `${name}-${crypto.randomUUID()}`, name, arguments: parameters }]);
}

function planCall(): AssistantMessage {
  return call("task_plan", { title: "Find and verify cause", items: [
    { id: "research", text: "Find cause", completionCriteria: "Identify the stale state path", status: "in_progress" },
    { id: "verify", text: "Verify cause", completionCriteria: "Regression check passes", status: "pending" },
  ] });
}

async function sdkFixture() {
  const root = await mkdtemp(join(tmpdir(), "ecode-task-checkpoint-"));
  directories.push(root);
  const changes = vi.fn();
  const service = new TaskPlanService(changes);
  const confirmation = new ConfirmationService();
  const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
  const resourceLoader = new DefaultResourceLoader({
    cwd: root, agentDir: root, settingsManager, noExtensions: true, noSkills: true,
    noPromptTemplates: true, noThemes: true, noContextFiles: true,
    extensionFactories: [confirmation.asExtension(), service.asExtension()],
  });
  await resourceLoader.reload();
  const modelRuntime = await ModelRuntime.create({ authPath: join(root, "auth.json"), modelsPath: join(root, "models.json") });
  await modelRuntime.setRuntimeApiKey("openai", "test-key");
  const probe = vi.fn(async () => ({ content: [{ type: "text" as const, text: "Stale cache identified" }], details: {} }));
  const { session } = await createAgentSession({ cwd: root, agentDir: root, model, modelRuntime,
    resourceLoader, settingsManager, sessionManager: SessionManager.inMemory(root), thinkingLevel: "off",
    tools: ["task_plan", "task_progress", "research_probe", "request_confirmation"],
    customTools: [{ name: "research_probe", label: "Research probe", description: "Observe research execution",
      parameters: Type.Object({}), execute: probe }],
  });
  sessions.push(session);
  const notify = vi.fn();
  await session.bindExtensions({ mode: "rpc", uiContext: { ...session.extensionRunner.getUIContext(), notify } });
  confirmation.install(session);
  service.install(session);
  const run = async (responses: Array<() => AssistantMessage>): Promise<number> => {
    let request = 0;
    session.agent.streamFunction = () => {
      const respond = responses[request++];
      if (!respond) throw new Error("Unexpected request after checkpoint settlement");
      const message = respond();
      const stream = createAssistantMessageEventStream();
      stream.push({ type: "done", reason: message.stopReason === "toolUse" ? "toolUse" : "stop", message });
      return stream;
    };
    await session.prompt("Find and verify the cause");
    return request;
  };
  return { session, service, changes, probe, notify, run };
}

describe("task progress SDK checkpoints", () => {
  it("requires reports after research and reasoning, persists state and permits truthful blocked delivery", async () => {
    const test = await sdkFixture();
    const requests = await test.run([
      planCall,
      () => call("research_probe", {}),
      () => call("task_progress", { planUpdatedAt: test.service.current!.updatedAt, id: "research",
        outcome: "completed", evidence: "Research found missing cache updates", nextId: "verify" }),
      () => call("research_probe", {}),
      () => call("task_progress", { planUpdatedAt: test.service.current!.updatedAt, id: "verify",
        outcome: "blocked", evidence: "Research evidence is available but regression verification cannot run here" }),
      () => assistant([{ type: "text", text: "Verification is blocked." }]),
    ]);
    expect(requests).toBe(6);
    expect(test.probe).toHaveBeenCalledTimes(2);
    expect(test.service.current?.items.map((item) => item.status)).toEqual(["completed", "in_progress"]);
    expect(test.session.isIdle).toBe(true);
    const checkpoints = test.session.sessionManager.getBranch().filter((entry) => entry.type === "custom_message"
      && entry.customType === "pi-ecode.task-checkpoint");
    expect(checkpoints).toHaveLength(2);
    const persisted = test.session.sessionManager.getBranch().findLast((entry) => entry.type === "custom"
      && entry.customType === "pi-ecode.task-plan-state");
    expect(persisted).toMatchObject({ data: { plan: test.service.current } });
    expect(test.notify).not.toHaveBeenCalled();
  });

  it("blocks another business tool and aborts after a missed checkpoint instead of looping", async () => {
    const test = await sdkFixture();
    const requests = await test.run([
      planCall,
      () => call("research_probe", {}),
      () => {
        void test.session.steer("Continue without reporting");
        return call("research_probe", {});
      },
    ]);
    expect(requests).toBe(3);
    expect(test.probe).toHaveBeenCalledTimes(1);
    expect(test.session.isIdle).toBe(true);
    expect(test.session.pendingMessageCount).toBe(0);
    expect(test.service.current?.items[0]?.status).toBe("in_progress");
    expect(test.notify).toHaveBeenCalledWith(expect.stringContaining("待办进度同步失败"), "error");
    expect(test.session.messages).toContainEqual(expect.objectContaining({ role: "toolResult", toolName: "research_probe", isError: true }));
  });

  it("rejects a progress report mixed with another operation and checks the completed batch", async () => {
    const test = await sdkFixture();
    const requests = await test.run([
      planCall,
      () => assistant([
        { type: "toolCall", id: "mixed-research", name: "research_probe", arguments: {} },
        { type: "toolCall", id: "mixed-progress", name: "task_progress", arguments: {
          planUpdatedAt: test.service.current!.updatedAt, id: "research", outcome: "completed", evidence: "Premature report",
        } },
      ]),
      () => call("task_progress", { planUpdatedAt: test.service.current!.updatedAt, id: "research",
        outcome: "in_progress", evidence: "One path is identified; another remains" }),
      () => assistant([{ type: "text", text: "More investigation is needed." }]),
    ]);
    expect(requests).toBe(4);
    expect(test.probe).toHaveBeenCalledTimes(1);
    expect(test.service.current?.items[0]?.status).toBe("in_progress");
    expect(test.session.messages).toContainEqual(expect.objectContaining({ role: "toolResult", toolCallId: "mixed-progress", isError: true }));
    expect(test.notify).not.toHaveBeenCalled();
  });

  it("rejects stale evidence and keeps the checkpoint closed", async () => {
    const test = await sdkFixture();
    const requests = await test.run([
      planCall,
      () => call("research_probe", {}),
      () => call("task_progress", { planUpdatedAt: 0, id: "research", outcome: "completed", evidence: "Done" }),
    ]);
    expect(requests).toBe(3);
    expect(test.service.current?.items[0]?.status).toBe("in_progress");
    expect(test.notify).toHaveBeenCalledWith(expect.stringContaining("待办进度同步失败"), "error");
    expect(test.session.messages).toContainEqual(expect.objectContaining({ role: "toolResult", toolName: "task_progress", isError: true }));
  });

  it("repairs a reasoning-only final response and releases final delivery after a valid report", async () => {
    const test = await sdkFixture();
    const requests = await test.run([
      planCall,
      () => assistant([{ type: "text", text: "Reasoning is complete; verification cannot run here." }]),
      () => call("task_progress", { planUpdatedAt: test.service.current!.updatedAt, id: "research",
        outcome: "blocked", evidence: "No reproduction is available; more evidence is needed" }),
      () => assistant([{ type: "text", text: "The task remains blocked awaiting a reproduction." }]),
    ]);
    expect(requests).toBe(4);
    expect(test.probe).not.toHaveBeenCalled();
    expect(test.service.current?.items[0]?.status).toBe("in_progress");
    expect(test.notify).not.toHaveBeenCalled();
    expect(test.session.isIdle).toBe(true);
  });

  it("does not resume a run waiting for explicit confirmation", async () => {
    const test = await sdkFixture();
    const requests = await test.run([
      planCall,
      () => call("request_confirmation", { title: "Implement fix", message: "Approve the inspected fix." }),
    ]);
    expect(requests).toBe(2);
    expect(test.service.current?.items[0]?.status).toBe("in_progress");
    expect(test.session.isIdle).toBe(true);
    expect(test.notify).not.toHaveBeenCalled();
    expect(test.session.sessionManager.getBranch().some((entry) => entry.type === "custom_message"
      && entry.customType === "pi-ecode.task-checkpoint")).toBe(false);
  });
});
