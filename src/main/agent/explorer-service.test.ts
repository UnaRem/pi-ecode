import { describe, expect, it, vi } from "vitest";
import type { AgentSession, ExtensionAPI, ExtensionContext, SessionEntry, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { ProjectAgentDefinition } from "../../shared/agent-contracts.js";
import { compactionReserveTokens, EXPLORER_TOOL_NAMES, ExplorerService, explorerToolDefinitions } from "./explorer-service.js";

interface DeferredResult {
  promise: Promise<{ sessionId: string; finalText: string }>;
  resolve: (value: { sessionId: string; finalText: string }) => void;
}

function deferredResult(): DeferredResult {
  let resolve = (_value: { sessionId: string; finalText: string }): void => {};
  const promise = new Promise<{ sessionId: string; finalText: string }>((done) => { resolve = done; });
  return { promise, resolve };
}

function harness(
  runExplorer: NonNullable<ConstructorParameters<typeof ExplorerService>[0]["runExplorer"]>,
  options: Partial<ConstructorParameters<typeof ExplorerService>[0]> = {},
) {
  let branch: SessionEntry[] = [];
  const tools = new Map<string, ToolDefinition>();
  const sent: Array<{ content: unknown; options: unknown }> = [];
  const appended: Array<{ customType: string; data: unknown }> = [];
  const handlers = new Map<string, (event: unknown, context: ExtensionContext) => void>();
  const parent = { model: { id: "model" } } as unknown as AgentSession;
  const service = new ExplorerService({ getParentSession: () => parent, onChange: vi.fn(), runExplorer, ...options });
  const pi = {
    on: (event: string, handler: (event: unknown, context: ExtensionContext) => void) => handlers.set(event, handler),
    registerTool: (definition: ToolDefinition) => { tools.set(definition.name, definition); },
    appendEntry: (customType: string, data: unknown) => appended.push({ customType, data }),
    sendMessage: (message: { content: unknown }, options: unknown) => sent.push({ content: message.content, options }),
  } as unknown as ExtensionAPI;
  const extension = service.asExtension();
  void (typeof extension === "function" ? extension(pi) : extension.factory(pi));
  const context = { sessionManager: { getBranch: () => branch } } as unknown as ExtensionContext;
  handlers.get("session_start")?.({}, context);
  return {
    service,
    sent,
    appended,
    setBranch: (entries: SessionEntry[]) => { branch = entries; },
    restore: () => handlers.get("session_tree")?.({}, context),
    call: async (name: string, params: Record<string, unknown>) => {
      const tool = tools.get(name);
      if (!tool) throw new Error(`${name} tool was not registered.`);
      return tool.execute(`call-${name}`, params, undefined, undefined, context);
    },
    dispatch: async (explorers: Array<Record<string, string>>, thinkingLevel?: "low" | "medium") => {
      const tool = tools.get("dispatch_explorers");
      if (!tool) throw new Error("Explorer tool was not registered.");
      return tool.execute("dispatch-1", {
        description: "parallel research",
        explorers,
        ...(thinkingLevel ? { thinking_level: thinkingLevel } : {}),
      }, undefined, undefined, context);
    },
  };
}

function agent(id: string, role: ProjectAgentDefinition["role"] = "explorer"): ProjectAgentDefinition {
  return {
    id,
    name: id,
    role,
    builtIn: true,
    enabled: true,
    model: { mode: "inherit" },
    thinkingLevel: "low",
    autoCompaction: { enabled: true, thresholdPercent: null },
    prompt: `prompt for ${id}`,
    disabledTools: [],
    createdAt: 1,
    updatedAt: 1,
  };
}

function request(index: number): Record<string, string> {
  return {
    task_name: `task_${index}`,
    title: `Task ${index}`,
    objective: `Answer question ${index}`,
    scope: `src/area-${index}`,
    deliverable: `Evidence ${index}`,
  };
}

describe("ExplorerService", () => {
  it("derives an auto-compaction reserve from the selected model window", () => {
    expect(compactionReserveTokens(200_000, 70)).toBe(60_000);
    expect(compactionReserveTokens(1, 90)).toBe(1);
  });

  it("reuses the parent read, ffgrep, and fffind definitions exactly", () => {
    const definitions = new Map<string, { name: string }>(EXPLORER_TOOL_NAMES.map((name) => [name, { name }]));
    const parent = {
      getToolDefinition: vi.fn((name: string) => definitions.get(name)),
    } as unknown as Pick<AgentSession, "getToolDefinition">;

    expect(explorerToolDefinitions(parent)).toEqual(EXPLORER_TOOL_NAMES.map((name) => definitions.get(name)));
    expect(parent.getToolDefinition).toHaveBeenCalledTimes(3);
    expect(parent.getToolDefinition).not.toHaveBeenCalledWith("grep");
    expect(parent.getToolDefinition).not.toHaveBeenCalledWith("find");
  });

  it("refuses to fall back when the parent fff tools are unavailable", () => {
    const parent = {
      getToolDefinition: (name: string) => name === "read" ? ({ name } as ToolDefinition) : undefined,
    } as Pick<AgentSession, "getToolDefinition">;

    expect(() => explorerToolDefinitions(parent)).toThrow("parent ffgrep tool");
  });

  it("defaults Explorer thinking to low and accepts a batch-level medium override", async () => {
    const low = deferredResult();
    const medium = deferredResult();
    const lowTest = harness(() => low.promise);
    const mediumTest = harness(() => medium.promise);

    await lowTest.dispatch([request(1)]);
    await mediumTest.dispatch([request(2)], "medium");

    expect(lowTest.service.current[0]?.thinkingLevel).toBe("low");
    expect(mediumTest.service.current[0]?.thinkingLevel).toBe("medium");
    lowTest.service.interruptAll();
    mediumTest.service.interruptAll();
    low.resolve({ sessionId: "low", finalText: "stopped" });
    medium.resolve({ sessionId: "medium", finalText: "stopped" });
  });

  it("assigns configured project agents and refuses to run one agent twice", async () => {
    const pending = deferredResult();
    const definitions = [agent("explorer-1"), agent("explorer-2"), agent("validator-1", "validator")];
    const test = harness(() => pending.promise, { getAgentDefinitions: () => definitions, getMaxConcurrent: () => 2 });

    await test.dispatch([request(1), request(2)]);
    expect(test.service.current.map((task) => task.agentId)).toEqual(["explorer-1", "explorer-2"]);
    expect(test.service.current.every((task) => task.thinkingLevel === "low")).toBe(true);
    await expect(test.dispatch([{ ...request(3), agent_id: "explorer-1" }])).rejects.toThrow("正在执行其他任务");

    const stop = test.service.interruptAll();
    pending.resolve({ sessionId: "child", finalText: "stopped" });
    await stop;
  });

  it("uses a configured agent thinking level unless the dispatch explicitly overrides it", async () => {
    const low = deferredResult();
    const medium = deferredResult();
    const configured = agent("reviewer-1", "reviewer");
    configured.thinkingLevel = "high";
    const first = harness(() => low.promise, { getAgentDefinitions: () => [configured] });
    const second = harness(() => medium.promise, { getAgentDefinitions: () => [configured] });

    await first.dispatch([{ ...request(1), agent_id: "reviewer-1" }]);
    await second.dispatch([{ ...request(2), agent_id: "reviewer-1" }], "medium");
    expect(first.service.current[0]?.thinkingLevel).toBe("high");
    expect(second.service.current[0]?.thinkingLevel).toBe("medium");
    void first.service.interruptAll();
    void second.service.interruptAll();
    low.resolve({ sessionId: "low", finalText: "stopped" });
    medium.resolve({ sessionId: "medium", finalText: "stopped" });
  });

  it("retries one inactive attempt and preserves the selected thinking level", async () => {
    vi.useFakeTimers();
    let attempts = 0;
    const service = new ExplorerService({
      getParentSession: () => ({ model: { id: "model" } }) as unknown as AgentSession,
      onChange: vi.fn(),
      watchdog: { warningMs: 10, inactivityMs: 20, totalMs: 100, intervalMs: 5, maxAttempts: 2 },
      runExplorer: (task, _request, _parent, signal) => {
        attempts += 1;
        if (attempts === 2) return Promise.resolve({ sessionId: "retry-child", finalText: "recovered" });
        return new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true }));
      },
    });
    const tools = new Map<string, ToolDefinition>();
    const extension = service.asExtension();
    const pi = {
      on: vi.fn(),
      registerTool: (definition: ToolDefinition) => { tools.set(definition.name, definition); },
      appendEntry: vi.fn(),
      sendMessage: vi.fn(),
    } as unknown as ExtensionAPI;
    void (typeof extension === "function" ? extension(pi) : extension.factory(pi));
    const dispatchTool = tools.get("dispatch_explorers");
    if (!dispatchTool) throw new Error("Explorer tool was not registered.");

    await dispatchTool.execute("dispatch-retry", { description: "retry", thinking_level: "medium", explorers: [request(1)] }, undefined, undefined, {} as ExtensionContext);
    await vi.advanceTimersByTimeAsync(75);
    await vi.waitFor(() => expect(service.current[0]?.status).toBe("completed"));

    expect(attempts).toBe(2);
    expect(service.current[0]).toMatchObject({ attempt: 2, maxAttempts: 2, thinkingLevel: "medium", finalText: "recovered" });
    vi.useRealTimers();
  });

  it("notifies the parent when one task finishes and returns the saved report only on request", async () => {
    const first = deferredResult();
    const second = deferredResult();
    const test = harness((task) => task.taskName === "task_1" ? first.promise : second.promise);
    await test.dispatch([request(1), request(2)]);

    first.resolve({ sessionId: "child-1", finalText: "private result 1" });
    await vi.waitFor(() => expect(test.sent).toHaveLength(1));
    expect(JSON.stringify(test.sent[0]?.content)).toContain("agent_completion");
    expect(JSON.stringify(test.sent[0]?.content)).not.toContain("private result 1");
    expect(test.sent[0]?.options).toEqual({ triggerTurn: true, deliverAs: "followUp" });

    const taskId = test.service.current.find((task) => task.taskName === "task_1")?.id;
    if (!taskId) throw new Error("Completed task is missing.");
    const statusBefore = await test.call("agent_status", { task_id: taskId });
    expect(JSON.stringify(statusBefore)).toContain('\"resultUnread\":true');
    const result = await test.call("agent_result", { task_id: taskId });
    expect(JSON.stringify(result)).toContain("private result 1");
    const statusAfter = await test.call("agent_status", { task_id: taskId });
    expect(JSON.stringify(statusAfter)).toContain('\"resultUnread\":false');

    const stop = test.service.interruptAll();
    second.resolve({ sessionId: "child-2", finalText: "stopped" });
    await stop;
  });

  it("runs at most three Explorers and starts queued work in FIFO order", async () => {
    const deferred = Array.from({ length: 4 }, deferredResult);
    const starts: string[] = [];
    const test = harness((task) => {
      starts.push(task.taskName);
      return deferred[Number(task.taskName.slice(5)) - 1]!.promise;
    });

    await test.dispatch([request(1), request(2), request(3), request(4)]);
    expect(starts).toEqual(["task_1", "task_2", "task_3"]);
    expect(test.service.current.map((task) => task.status)).toEqual(["running", "running", "running", "queued"]);

    deferred[0]!.resolve({ sessionId: "child-1", finalText: "result 1" });
    await vi.waitFor(() => expect(starts).toEqual(["task_1", "task_2", "task_3", "task_4"]));
    expect(test.service.current.find((task) => task.taskName === "task_4")?.status).toBe("running");

    deferred[1]!.resolve({ sessionId: "child-2", finalText: "result 2" });
    deferred[2]!.resolve({ sessionId: "child-3", finalText: "result 3" });
    deferred[3]!.resolve({ sessionId: "child-4", finalText: "result 4" });
    await vi.waitFor(() => expect(test.sent).toHaveLength(1));
    expect(test.service.current.every((task) => task.status === "completed")).toBe(true);
    expect(JSON.stringify(test.sent[0]?.content)).not.toContain("result 1");
    expect(test.sent[0]?.options).toEqual({ triggerTurn: true, deliverAs: "followUp" });
  });

  it("keeps interrupted tasks terminal when child promises settle later", async () => {
    const pending = deferredResult();
    const test = harness(() => pending.promise);
    await test.dispatch([request(1)]);

    const interrupted = test.service.interruptAll();
    pending.resolve({ sessionId: "late-child", finalText: "late result" });
    await interrupted;

    expect(test.sent).toHaveLength(0);
    expect(test.service.current[0]?.status).toBe("interrupted");
    expect(test.service.current[0]?.finalText).toBeUndefined();
  });

  it("restores a persisted agent generation for the same parent session", () => {
    const test = harness(vi.fn(async () => ({ sessionId: "unused", finalText: "unused" })));
    const completed = {
      id: "task-old", taskName: "inspect", title: "Inspect", objective: "Find behavior", scope: "src/",
      deliverable: "Evidence", status: "completed", originToolCallId: "dispatch-old", thinkingLevel: "low",
      attempt: 1, maxAttempts: 2, revision: 2, queuedAt: 1, startedAt: 2, endedAt: 3, finalText: "saved",
      agentId: "explorer-1", agentRole: "explorer", provider: "openai", modelId: "model",
    };
    test.setBranch([{
      type: "custom", id: "entry-generation", parentId: null, timestamp: new Date().toISOString(),
      customType: "pi-ecode.explorer-state", data: {
        version: 5,
        tasks: [completed], locators: [], completions: [], agentSnapshots: [],
        generations: [{ id: "generation-1", agentId: "explorer-1", provider: "openai", modelId: "model", sessionFile: "C:/sessions/child.jsonl", createdAt: 1, lastUsedAt: 2 }],
      },
    } as SessionEntry]);

    test.restore();
    expect(test.appended.at(-1)).toBeUndefined();
    expect(test.service.current[0]).toMatchObject({ agentId: "explorer-1", provider: "openai", modelId: "model" });
  });

  it("redelivers a persisted pending completion after restoring the parent session", async () => {
    const test = harness(vi.fn(async () => ({ sessionId: "unused", finalText: "unused" })));
    const completed = {
      id: "child-complete", taskName: "inspect", title: "Inspect", objective: "Find behavior", scope: "src/",
      deliverable: "Evidence", status: "completed", originToolCallId: "dispatch-old", thinkingLevel: "low",
      attempt: 1, maxAttempts: 2, revision: 2, queuedAt: 1, startedAt: 2, endedAt: 3, finalText: "saved result",
    };
    test.setBranch([{
      type: "custom", id: "entry-pending", parentId: null, timestamp: new Date().toISOString(),
      customType: "pi-ecode.explorer-state", data: {
        version: 3,
        tasks: [completed],
        locators: [],
        completions: [{ id: "completion-1", taskId: "child-complete", createdAt: 3 }],
      },
    } as SessionEntry]);

    test.restore();
    await vi.waitFor(() => expect(test.sent).toHaveLength(1));
    expect(JSON.stringify(test.sent[0]?.content)).toContain("completion-1");
    expect(JSON.stringify(test.sent[0]?.content)).not.toContain("saved result");
  });

  it("restores unfinished parent state as interrupted without rerunning children", () => {
    const runExplorer = vi.fn(async () => ({ sessionId: "unused", finalText: "unused" }));
    const test = harness(runExplorer);
    const running = {
      id: "child-1", taskName: "inspect", title: "Inspect", objective: "Find behavior", scope: "src/",
      deliverable: "Evidence", status: "running", originToolCallId: "dispatch-old", thinkingLevel: "low",
      attempt: 1, maxAttempts: 2, revision: 1, queuedAt: 1, startedAt: 2,
    };
    test.setBranch([{
      type: "custom", id: "entry-1", parentId: null, timestamp: new Date().toISOString(),
      customType: "pi-ecode.explorer-state", data: { version: 1, tasks: [running], deliveredToolCallIds: [] },
    } as SessionEntry]);

    test.restore();

    expect(runExplorer).not.toHaveBeenCalled();
    expect(test.service.current[0]?.status).toBe("interrupted");
    expect(test.service.current[0]?.errorMessage).toContain("parent session closed");
  });
});
