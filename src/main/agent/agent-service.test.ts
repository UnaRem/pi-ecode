import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentSession, AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import type { AgentEvent, SessionSummary, ValidationState } from "../../shared/contracts.js";

const sessionSummaryState = vi.hoisted(() => ({ sessions: [] as SessionSummary[] }));
vi.mock("./session-summaries.js", () => ({
  listSessionSummaries: async () => sessionSummaryState.sessions,
}));

import { AgentService } from "./agent-service.js";

interface PromptOptions {
  preflightResult?: (accepted: boolean) => void;
}

function validationState(status: ValidationState["status"], runId: string | null): ValidationState {
  return {
    supported: true,
    isSelfProject: true,
    status,
    runId,
    activeStep: null,
    steps: [],
    sourceRevision: "revision-1",
    originToolCallId: null,
    startedAt: 1,
    verifiedAt: status === "passed" ? 2 : null,
    message: null,
  };
}

/**
 * AgentService 在构造时把 onChange 闭包交给 ValidationService；这里直接取回那个闭包，
 * 以便在不真正跑验证的前提下验证「验证状态 → 宿主侧同步」这条真实接线。
 */
function validationPublisher(service: AgentService): (state: ValidationState) => void {
  const validation = (service as unknown as { validation: { onChange: (state: ValidationState) => void } }).validation;
  if (typeof validation?.onChange !== "function") throw new Error("未取到 ValidationService 的 onChange。");
  return (state) => validation.onChange(state);
}

describe("AgentService codegraph 索引同步", () => {
  interface SyncHarness {
    projectPath: string;
    codegraphTool: { syncIndex: (path: string, signal: AbortSignal) => Promise<boolean> };
    codegraphSync: { controller: AbortController } | undefined;
    codegraphSyncIntent: { runId: string; projectPath: string } | undefined;
    codegraphSyncDraining: boolean;
    cancelCodegraphSync: () => Promise<void>;
    disposeRuntime: () => Promise<void>;
  }

  function syncHarness(syncIndex: SyncHarness["codegraphTool"]["syncIndex"]): { service: AgentService; internal: SyncHarness } {
    const service = new AgentService();
    const internal = service as unknown as SyncHarness;
    internal.projectPath = "C:/project";
    internal.codegraphTool = { syncIndex };
    return { service, internal };
  }

  it("starts one refresh per passing validation run without blocking it", async () => {
    let releaseSync: (() => void) | undefined;
    const syncIndex = vi.fn((_path: string, _signal: AbortSignal) => new Promise<boolean>((resolve) => {
      releaseSync = () => resolve(true);
    }));
    const { service, internal } = syncHarness(syncIndex);
    const publish = validationPublisher(service);

    publish(validationState("passed", "run-1"));
    // 同一次验证重复发布不再同步。
    publish(validationState("passed", "run-1"));

    await vi.waitFor(() => expect(syncIndex).toHaveBeenCalledTimes(1));
    // publish 已经返回而同步仍在进行：它是后台副作用，不可能阻塞已通过的验证结果。
    expect(internal.codegraphSync).toBeDefined();
    expect(syncIndex).toHaveBeenCalledWith("C:/project", expect.any(AbortSignal));

    releaseSync?.();
    await vi.waitFor(() => expect(internal.codegraphSync).toBeUndefined());
    publish(validationState("passed", "run-2"));
    await vi.waitFor(() => expect(syncIndex).toHaveBeenCalledTimes(2));
    releaseSync?.();
    await vi.waitFor(() => expect(internal.codegraphSync).toBeUndefined());
  });

  it("starts the new run's refresh right after a cancelled sync finishes cleanup", async () => {
    const calls: Array<{ signal: AbortSignal; release: () => void }> = [];
    const syncIndex = vi.fn((_path: string, signal: AbortSignal) => new Promise<boolean>((resolve) => {
      calls.push({ signal, release: () => resolve(true) });
    }));
    const { service, internal } = syncHarness(syncIndex);
    const publish = validationPublisher(service);

    publish(validationState("passed", "run-1"));
    await vi.waitFor(() => expect(calls).toHaveLength(1));

    // 新一轮验证开始：旧同步被取消，但它的进程还没有真正结束。
    publish(validationState("running", "run-2"));
    await vi.waitFor(() => expect(calls[0]?.signal.aborted).toBe(true));

    // 竞态时序：新 passed 在旧同步清理完成之前发布；此时不能因为「已有在途同步」就静默丢弃它。
    publish(validationState("passed", "run-2"));
    expect(syncIndex).toHaveBeenCalledTimes(1);

    calls[0]?.release();
    await vi.waitFor(() => expect(syncIndex).toHaveBeenCalledTimes(2));
    // 第二次同步是新一次启动：signal 未被取消，cwd 仍是捕获的项目。
    expect(syncIndex.mock.calls[1]?.[0]).toBe("C:/project");
    expect(calls[1]?.signal.aborted).toBe(false);

    calls[1]?.release();
    await vi.waitFor(() => expect(internal.codegraphSync).toBeUndefined());
  });

  it("drops the queued refresh when the next validation phase starts before cleanup finishes", async () => {
    const calls: Array<{ signal: AbortSignal; release: () => void }> = [];
    const syncIndex = vi.fn((_path: string, signal: AbortSignal) => new Promise<boolean>((resolve) => {
      calls.push({ signal, release: () => resolve(true) });
    }));
    const { service, internal } = syncHarness(syncIndex);
    const publish = validationPublisher(service);

    publish(validationState("passed", "run-1"));
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    publish(validationState("running", "run-2"));
    await vi.waitFor(() => expect(calls[0]?.signal.aborted).toBe(true));

    // run-2 的同步先排队，随后又被 run-3 的 running 作废。
    publish(validationState("passed", "run-2"));
    publish(validationState("running", "run-3"));
    calls[0]?.release();

    await vi.waitFor(() => expect(internal.codegraphSyncDraining).toBe(false));
    // 旧进程结束后不得滞后启动已作废的同步。
    expect(syncIndex).toHaveBeenCalledTimes(1);
    expect(internal.codegraphSyncIntent).toBeUndefined();
    expect(internal.codegraphSync).toBeUndefined();
  });

  it("does not start a stale refresh after the project changed", async () => {
    const calls: Array<{ signal: AbortSignal; release: () => void }> = [];
    const syncIndex = vi.fn((_path: string, signal: AbortSignal) => new Promise<boolean>((resolve) => {
      calls.push({ signal, release: () => resolve(true) });
    }));
    const { service, internal } = syncHarness(syncIndex);
    const publish = validationPublisher(service);

    publish(validationState("passed", "run-1"));
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    publish(validationState("running", "run-2"));
    await vi.waitFor(() => expect(calls[0]?.signal.aborted).toBe(true));
    publish(validationState("passed", "run-2"));

    // 项目切换：在途同步与排队意图都必须留在旧目录，不能在切换后补偿启动。
    internal.projectPath = "C:/other";
    calls[0]?.release();

    await vi.waitFor(() => expect(internal.codegraphSyncDraining).toBe(false));
    expect(syncIndex).toHaveBeenCalledTimes(1);
  });

  it("cancels an in-flight refresh on a new validation phase and waits for cleanup", async () => {
    let syncSignal: AbortSignal | undefined;
    let releaseSync: (() => void) | undefined;
    const syncIndex = vi.fn((_path: string, signal: AbortSignal) => new Promise<boolean>((resolve) => {
      syncSignal = signal;
      releaseSync = () => resolve(true);
    }));
    const { service, internal } = syncHarness(syncIndex);
    const events: AgentEvent[] = [];
    service.subscribe((event) => events.push(event));
    const publish = validationPublisher(service);

    publish(validationState("passed", "run-1"));
    await vi.waitFor(() => expect(syncIndex).toHaveBeenCalledTimes(1));

    publish(validationState("running", "run-2"));
    await vi.waitFor(() => expect(syncSignal?.aborted).toBe(true));

    // 取消必须等到清理完成，否则旧项目目录仍可能被继续写入。
    let cleaned = false;
    const cleanup = internal.cancelCodegraphSync().then(() => { cleaned = true; });
    await new Promise((resolveWait) => setTimeout(resolveWait, 20));
    expect(cleaned).toBe(false);
    releaseSync?.();
    await cleanup;
    expect(cleaned).toBe(true);
    // 主动取消不是失败，不向用户报错。
    expect(events.filter((event) => event.type === "notice")).toEqual([]);
  });

  it("surfaces a failed refresh as a notice without touching the validation result", async () => {
    const syncIndex = vi.fn(async () => { throw new Error("codegraph sync 以退出码 4 结束。"); });
    const { service } = syncHarness(syncIndex);
    const events: AgentEvent[] = [];
    service.subscribe((event) => events.push(event));
    const publish = validationPublisher(service);
    const passed = validationState("passed", "run-1");

    publish(passed);

    await vi.waitFor(() => expect(events.some((event) => event.type === "notice")).toBe(true));
    expect(events.find((event) => event.type === "notice")).toEqual({
      type: "notice",
      message: expect.stringContaining("codegraph sync 以退出码 4 结束。"),
    });
    // 同步失败不改变验证状态：唯一的 validation 事件就是刚发布的 passed。
    expect(events.filter((event) => event.type === "validation")).toEqual([{ type: "validation", validation: passed }]);
  });

  it("stops an in-flight refresh before the runtime is disposed", async () => {
    let syncSignal: AbortSignal | undefined;
    let releaseSync: (() => void) | undefined;
    const syncIndex = vi.fn((_path: string, signal: AbortSignal) => new Promise<boolean>((resolve) => {
      syncSignal = signal;
      releaseSync = () => resolve(true);
    }));
    const { service, internal } = syncHarness(syncIndex);
    const publish = validationPublisher(service);

    publish(validationState("passed", "run-1"));
    await vi.waitFor(() => expect(syncIndex).toHaveBeenCalledTimes(1));

    let disposed = false;
    const disposal = internal.disposeRuntime().then(() => { disposed = true; });
    await new Promise((resolveWait) => setTimeout(resolveWait, 20));
    // 项目切换与关闭必须等到在途同步真正结束。
    expect(syncSignal?.aborted).toBe(true);
    expect(disposed).toBe(false);
    releaseSync?.();
    await disposal;
    expect(disposed).toBe(true);
  });
});

describe("AgentService prompt lifecycle", () => {
  afterEach(() => {
    sessionSummaryState.sessions = [];
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("moves only inactive sessions from the active project to trash", async () => {
    const activePath = "C:/sessions/active.jsonl";
    const inactivePath = "C:/sessions/inactive.jsonl";
    sessionSummaryState.sessions = [
      { path: activePath, id: "active", title: "Active", modifiedAt: 2, messageCount: 1 },
      { path: inactivePath, id: "inactive", title: "Inactive", modifiedAt: 1, messageCount: 1 },
    ];
    const trashItem = vi.fn(async (path: string) => {
      sessionSummaryState.sessions = sessionSummaryState.sessions.filter((session) => session.path !== path);
    });
    const service = new AgentService(async () => undefined, trashItem);
    const session = { sessionFile: activePath, isStreaming: false, isCompacting: false } as unknown as AgentSession;
    Object.assign(service as unknown as { projectPath: string; runtime: { session: AgentSession } }, {
      projectPath: "C:/project",
      runtime: { session },
    });
    const events: AgentEvent[] = [];
    service.subscribe((event) => events.push(event));

    await service.deleteSession(inactivePath);

    expect(trashItem).toHaveBeenCalledWith(inactivePath);
    expect(events.at(-1)).toEqual({ type: "sessions", sessions: [expect.objectContaining({ path: activePath })] });
    await expect(service.deleteSession(activePath)).rejects.toThrow("active session");
    await expect(service.deleteSession("C:/outside.jsonl")).rejects.toThrow("active project");
  });

  it("does not compact a branch twice before a new conversation entry", async () => {
    let branch = [{ type: "compaction" }];
    const compact = vi.fn(async () => undefined);
    const session = {
      isStreaming: false,
      isCompacting: false,
      model: null,
      compact,
      getContextUsage: () => undefined,
      sessionManager: { getBranch: () => branch },
    } as unknown as AgentSession;
    const service = new AgentService();
    Object.assign(service as unknown as { runtime: { session: AgentSession } }, { runtime: { session } });
    const contextState = (service as unknown as {
      contextState: (activeSession: AgentSession) => { canCompact: boolean };
    }).contextState.bind(service);

    expect(contextState(session).canCompact).toBe(false);
    await service.compact();
    expect(compact).not.toHaveBeenCalled();

    branch = [{ type: "message" }];
    expect(contextState(session).canCompact).toBe(true);
  });

  it("persists model selections and reapplies the 200K context budget", async () => {
    const model = { provider: "provider", id: "last-selected", contextWindow: 1_050_000 };
    const applyOverrides = vi.fn();
    const session = {
      model,
      modelRuntime: { getModel: vi.fn(() => model) },
      settingsManager: {
        getGlobalSettings: () => ({}),
        getProjectSettings: () => ({}),
        applyOverrides,
      },
      setModel: vi.fn(async () => undefined),
      getAvailableThinkingLevels: () => [],
    } as unknown as AgentSession;
    const service = new AgentService();
    Object.assign(service as unknown as { runtime: { session: AgentSession } }, { runtime: { session } });

    await service.setModel(model.provider, model.id);

    expect(session.modelRuntime.getModel).toHaveBeenCalledWith(model.provider, model.id);
    expect(session.setModel).toHaveBeenCalledWith(model, { persist: true });
    expect(applyOverrides).toHaveBeenCalledWith({ compaction: { reserveTokens: 850_000 } });
  });

  it("normalizes and persists a renamed session", () => {
    const session = { setSessionName: vi.fn() } as unknown as AgentSession;
    const service = new AgentService();
    Object.assign(service as unknown as { runtime: { session: AgentSession } }, { runtime: { session } });

    service.renameSession(`  Renamed\nconversation ${"x".repeat(90)}  `);

    const savedTitle = vi.mocked(session.setSessionName).mock.calls[0]?.[0] ?? "";
    expect(savedTitle).toBe("Renamed conversation " + "x".repeat(59));
    expect(savedTitle).toHaveLength(80);
  });

  it("reads full tool output only from the active session", () => {
    const session = {
      messages: [{
        role: "toolResult", toolCallId: "call-1", toolName: "bash",
        content: [{ type: "text", text: "complete output" }], isError: false,
      }],
    } as unknown as AgentSession;
    const service = new AgentService();
    Object.assign(service as unknown as { runtime: { session: AgentSession } }, { runtime: { session } });

    expect(service.getToolOutput("call-1")).toBe("complete output");
    expect(() => service.getToolOutput("missing")).toThrow("active session");
    expect(() => service.getToolOutput("x".repeat(201))).toThrow("Invalid tool call id");
  });

  it("reads historical images only by active-session indexes", () => {
    const session = {
      messages: [{ role: "user", content: [
        { type: "text", text: "Inspect" },
        { type: "image", mimeType: "image/png", data: "aGVsbG8=" },
      ] }],
    } as unknown as AgentSession;
    const service = new AgentService();
    Object.assign(service as unknown as { runtime: { session: AgentSession } }, { runtime: { session } });

    expect(service.getConversationImage("0:1")?.data).toEqual(Uint8Array.from([104, 101, 108, 108, 111]));
    expect(() => service.getConversationImage("../image.png")).toThrow("Invalid conversation image id");
    expect(service.getConversationImage("0:9")).toBeNull();
  });

  it("continues a transient provider failure with a hidden control message", async () => {
    const session = {
      isIdle: true,
      isStreaming: false,
      pendingMessageCount: 0,
      messages: [{ role: "assistant", content: [], stopReason: "error", errorMessage: "502 Bad Gateway" }],
      sendCustomMessage: vi.fn(async () => undefined),
    } as unknown as AgentSession;
    const service = new AgentService();
    Object.assign(service as unknown as { runtime: { session: AgentSession } }, { runtime: { session } });

    await service.continueAfterError();

    expect(session.sendCustomMessage).toHaveBeenCalledWith(expect.objectContaining({
      customType: "pi-ecode.provider-recovery",
      display: false,
    }), { triggerTurn: true });
  });

  it("shows work immediately and steers messages submitted during preflight", async () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(1_000);
    let finishPrompt: (() => void) | undefined;
    let finishPreflight: ((accepted: boolean) => void) | undefined;
    const session = {
      isStreaming: false,
      pendingMessageCount: 0,
      prompt: vi.fn((_text: string, options: PromptOptions) => {
        finishPreflight = options.preflightResult;
        return new Promise<void>((resolve) => { finishPrompt = resolve; });
      }),
      steer: vi.fn(async () => undefined),
    } as unknown as AgentSession;
    const service = new AgentService();
    Object.assign(service as unknown as { runtime: { session: AgentSession } }, { runtime: { session } });
    const events: AgentEvent[] = [];
    service.subscribe((event) => events.push(event));

    const firstPrompt = service.prompt("first");
    expect(events.at(-1)).toEqual({
      type: "state",
      patch: { isStreaming: true, workingStartedAt: 1_000, pendingCount: 0, error: null, canContinue: false },
    });
    now.mockReturnValue(5_000);
    const steeringPrompt = service.prompt("continue");

    const lifecycle = service as unknown as { promptLifecycle: { workingStartedAt: number | null } };
    expect(lifecycle.promptLifecycle.workingStartedAt).toBe(1_000);
    expect(session.prompt).toHaveBeenCalledTimes(1);
    expect(session.steer).not.toHaveBeenCalled();
    finishPreflight?.(true);
    await steeringPrompt;
    expect(session.steer).toHaveBeenCalledWith("continue", []);
    finishPrompt?.();
    await firstPrompt;
    expect(events.at(-1)).toEqual({
      type: "state",
      patch: { isStreaming: false, workingStartedAt: null, pendingCount: 0 },
    });
  });

  it("coalesces high-frequency assistant updates before publishing", () => {
    vi.useFakeTimers();
    const session = {
      sessionId: "session-1",
      model: null,
      isCompacting: false,
      getContextUsage: () => undefined,
      sessionManager: { getBranch: () => [] },
    } as unknown as AgentSession;
    const service = new AgentService();
    const events: AgentEvent[] = [];
    service.subscribe((event) => events.push(event));
    const handleEvent = (service as unknown as {
      handleSessionEvent: (activeSession: AgentSession, event: AgentSessionEvent) => void;
    }).handleSessionEvent.bind(service);

    for (const delta of ["Hello", " ", "world"]) {
      handleEvent(session, {
        type: "message_update",
        message: { role: "assistant", content: [] },
        assistantMessageEvent: { type: "text_delta", delta },
      } as unknown as AgentSessionEvent);
    }

    expect(events).toEqual([]);
    vi.advanceTimersByTime(33);
    expect(events.filter((event) => event.type === "timeline-upsert")).toEqual([
      expect.objectContaining({ item: expect.objectContaining({ message: expect.objectContaining({ text: "Hello world" }) }) }),
    ]);
    expect(events.filter((event) => event.type === "context")).toHaveLength(1);
  });

  it("clears the previous change review when a new agent run starts", () => {
    const session = { sessionId: "session-1" } as unknown as AgentSession;
    const service = new AgentService();
    const events: AgentEvent[] = [];
    service.subscribe((event) => events.push(event));
    const handleEvent = (service as unknown as {
      handleSessionEvent: (activeSession: AgentSession, event: AgentSessionEvent) => void;
    }).handleSessionEvent.bind(service);

    handleEvent(session, { type: "agent_start" } as unknown as AgentSessionEvent);

    expect(events).toContainEqual({
      type: "review",
      review: {
        available: false,
        baseCommit: null,
        headCommit: null,
        files: [],
        patch: "",
        truncated: false,
        message: null,
      },
    });
  });

  it("starts child validation without waiting for a parent-session checkpoint", async () => {
    const session = { sessionId: "session-validator" } as unknown as AgentSession;
    const service = new AgentService();
    const validation: ValidationState = {
      supported: true,
      isSelfProject: true,
      status: "passed",
      runId: "run-1",
      activeStep: null,
      steps: [],
      sourceRevision: "revision-1",
      originToolCallId: null,
      startedAt: 1,
      verifiedAt: 2,
      message: "passed",
    };
    const internal = service as unknown as {
      runtime: { session: AgentSession };
      executeValidation: (activeSession: AgentSession) => Promise<ValidationState>;
      runValidationFromAgent: () => Promise<ValidationState>;
    };
    internal.runtime = { session };
    const executeValidation = vi.spyOn(internal, "executeValidation").mockResolvedValue(validation);

    await expect(internal.runValidationFromAgent()).resolves.toEqual(validation);
    expect(executeValidation).toHaveBeenCalledWith(session);
  });

  it("records tool execution start and end times", () => {
    const now = vi.spyOn(Date, "now").mockReturnValueOnce(1_000).mockReturnValueOnce(4_500);
    const session = { sessionId: "session-1" } as unknown as AgentSession;
    const service = new AgentService();
    const events: AgentEvent[] = [];
    service.subscribe((event) => events.push(event));
    const handleEvent = (service as unknown as {
      handleSessionEvent: (activeSession: AgentSession, event: AgentSessionEvent) => void;
    }).handleSessionEvent.bind(service);

    handleEvent(session, {
      type: "tool_execution_start",
      toolCallId: "tool-1",
      toolName: "bash",
      args: { command: "npm test" },
    } as unknown as AgentSessionEvent);
    handleEvent(session, {
      type: "tool_execution_end",
      toolCallId: "tool-1",
      toolName: "bash",
      result: { content: [{ type: "text", text: "passed" }] },
      isError: false,
    } as unknown as AgentSessionEvent);

    const toolEvents = events.filter((event) => event.type === "timeline-upsert" && event.item.kind === "tool");
    expect(toolEvents.at(-1)).toMatchObject({ item: { tool: { startedAt: 1_000, endedAt: 4_500 } } });
    now.mockRestore();
  });

  it("honors stop requests made before agent_start", async () => {
    let finishPrompt: (() => void) | undefined;
    let finishPreflight: ((accepted: boolean) => void) | undefined;
    const session = {
      isStreaming: false,
      isCompacting: false,
      pendingMessageCount: 0,
      sessionId: "session-1",
      prompt: vi.fn((_text: string, options: PromptOptions) => new Promise<void>((resolve) => {
        finishPreflight = options.preflightResult;
        finishPrompt = resolve;
      })),
      abort: vi.fn(async () => undefined),
      clearQueue: vi.fn(),
      sessionManager: { getCwd: () => "C:/workspace", getBranch: () => [] },
    } as unknown as AgentSession;
    const service = new AgentService();
    Object.assign(service as unknown as { runtime: { session: AgentSession }; history: unknown }, {
      runtime: { session },
      history: {
        settlePending: vi.fn(async () => undefined),
        getState: vi.fn(async () => ({ available: true, canUndo: false, canRedo: false, isBusy: false, message: null })),
      },
    });

    const promptOperation = service.prompt("first");
    const stopOperation = service.stop();
    finishPreflight?.(true);
    await vi.waitFor(() => expect(session.abort).toHaveBeenCalled());
    finishPrompt?.();
    await Promise.all([promptOperation, stopOperation]);
    expect(session.clearQueue).toHaveBeenCalled();
  });
});
