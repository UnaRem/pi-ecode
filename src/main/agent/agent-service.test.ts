import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager, type AgentSession, type AgentSessionEvent, type CreateAgentSessionRuntimeFactory, type PromptOptions } from "@earendil-works/pi-coding-agent";
import type { AgentEvent, SessionSummary, ValidationState } from "../../shared/contracts.js";

const sessionSummaryState = vi.hoisted(() => ({ sessions: [] as SessionSummary[], scans: 0,
  pending: undefined as Promise<SessionSummary[]> | undefined }));
vi.mock("./session-summaries.js", () => ({
  listSessionSummaries: async () => { sessionSummaryState.scans += 1; return sessionSummaryState.pending ?? sessionSummaryState.sessions; },
}));

import { AgentService } from "./agent-service.js";
import { EMPTY_AGENT_SNAPSHOT } from "./empty-agent-snapshot.js";
import { createConfirmationResponse } from "../../shared/confirmation.js";

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

describe("AgentService 托管进程", () => {
  it("publishes process snapshots and rejects unregistered ids before delegating stop", async () => {
    const service = new AgentService();
    const internal = service as unknown as {
      projectPath: string;
      managedProcesses: { current: Array<{ id: string; projectPath: string }>; stop: (id: string) => Promise<void> };
      createManagedProcesses: () => { configure: (path: string) => Promise<void>; dispose: () => Promise<void> };
    };
    const events: AgentEvent[] = [];
    service.subscribe((event) => events.push(event));
    const publisher = internal.createManagedProcesses();
    await publisher.configure(process.cwd());
    expect(events).toContainEqual({ type: "processes", processes: [] });
    await publisher.dispose();
    const stop = vi.fn(async () => undefined);
    internal.projectPath = "C:/project";
    internal.managedProcesses = { current: [{ id: "registered", projectPath: "C:/project" },
      { id: "other", projectPath: "C:/other" }], stop };
    await service.stopManagedProcess("registered");
    expect(stop).toHaveBeenCalledWith("registered");
    await expect(service.stopManagedProcess("123")).rejects.toThrow("active project");
    await expect(service.stopManagedProcess("other")).rejects.toThrow("active project");
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it("configures a project after runtime disposal and cleans failed project opens", async () => {
    const service = new AgentService();
    const order: string[] = [];
    const internal = service as unknown as {
      managedProcesses: { configure: (path: string) => Promise<void>; dispose: () => Promise<void> };
      createRuntimeFactory: () => unknown;
      disposeRuntime: () => Promise<void>;
      projectPath: string | undefined;
    };
    const configure = vi.fn(async () => { order.push("configure"); });
    const cleanup = vi.fn(async () => { order.push("process-cleanup"); });
    const processService = { configure, dispose: cleanup };
    internal.managedProcesses = processService;
    const runtimeFactory = vi.spyOn(internal, "createRuntimeFactory").mockImplementation(() => { throw new Error("runtime unavailable"); });
    const runtimeCleanup = vi.spyOn(internal, "disposeRuntime").mockImplementation(async () => { order.push("runtime-cleanup"); });

    await expect(service.openProject(process.cwd())).rejects.toThrow("runtime unavailable");

    expect(order).toEqual(["runtime-cleanup", "configure", "runtime-cleanup", "process-cleanup"]);
    expect(configure).toHaveBeenCalledWith(process.cwd());
    expect(internal.projectPath).toBeUndefined();
    expect(internal.managedProcesses).not.toBe(processService);
    runtimeCleanup.mockRestore();
    runtimeFactory.mockRestore();
  });

  it("opens distinct new conversation files in a shared cwd without resuming the most recent session", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-ecode-shared-session-"));
    const managers: SessionManager[] = [];
    const service = new AgentService();
    const internal = service as unknown as { createRuntimeFactory: () => CreateAgentSessionRuntimeFactory };
    const recent = vi.spyOn(SessionManager, "continueRecent").mockReturnValue(SessionManager.inMemory(cwd));
    const factory = vi.spyOn(internal, "createRuntimeFactory").mockReturnValue(async ({ sessionManager }) => {
      managers.push(sessionManager);
      // Stop before model/network startup while retaining the actual SDK-created conversation identities.
      throw new Error("fixture startup boundary");
    });
    try {
      await expect(service.openProject(cwd, undefined, true)).rejects.toThrow("fixture startup boundary");
      await expect(service.openProject(cwd, undefined, true)).rejects.toThrow("fixture startup boundary");
      expect(recent).not.toHaveBeenCalled();
      expect(managers).toHaveLength(2);
      expect(managers[0]!.getSessionFile()).toBeDefined();
      expect(managers[0]!.getSessionFile()).not.toBe(managers[1]!.getSessionFile());
      expect(managers.map((manager) => manager.getCwd())).toEqual([cwd, cwd]);
    } finally {
      factory.mockRestore();
      recent.mockRestore();
      await service.dispose();
      for (const directory of new Set(managers.map((manager) => manager.getSessionDir()))) await rm(directory, { recursive: true, force: true });
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("preserves the old project and registered stop entry when configure cleanup fails", async () => {
    const service = new AgentService();
    const oldProject = "C:/old-project";
    const records = [{ id: "old-process", projectPath: oldProject, sessionId: "old-session", originToolCallId: "call",
      command: "bun run dev", status: "running" as const, pid: 123, startedAt: 1, endedAt: null,
      exitCode: null, signal: null, output: "still alive", outputTruncated: false, errorMessage: null }];
    const configure = vi.fn(async () => { throw new Error("taskkill failed"); });
    const cleanup = vi.fn(async () => { throw new Error("must not dispose"); });
    const stop = vi.fn(async () => undefined);
    const processService = { current: records, configure, dispose: cleanup, stop };
    const internal = service as unknown as {
      projectPath: string; managedProcesses: typeof processService; disposeRuntime: () => Promise<void>;
      createRuntimeFactory: () => unknown;
    };
    internal.projectPath = oldProject;
    internal.managedProcesses = processService;
    const runtimeFactory = vi.spyOn(internal, "createRuntimeFactory");
    const runtimeCleanup = vi.spyOn(internal, "disposeRuntime");

    await expect(service.openProject(process.cwd())).rejects.toThrow("taskkill failed");
    const snapshot = await service.getSnapshot();
    await service.stopManagedProcess("old-process");

    expect(runtimeCleanup).toHaveBeenCalledTimes(1);
    expect(configure).toHaveBeenCalledWith(process.cwd());
    expect(cleanup).not.toHaveBeenCalled();
    expect(runtimeFactory).not.toHaveBeenCalled();
    expect(internal.projectPath).toBe(oldProject);
    expect(internal.managedProcesses).toBe(processService);
    expect(snapshot).toMatchObject({ projectPath: oldProject, projectName: "old-project", sessionId: null, processes: records,
      error: expect.stringContaining("taskkill failed") });
    expect(stop).toHaveBeenCalledWith("old-process");
    runtimeFactory.mockRestore();
    runtimeCleanup.mockRestore();
  });

  it("keeps processes during runtime replacement and cleans them before final disposal", async () => {
    const service = new AgentService();
    const internal = service as unknown as {
      managedProcesses: { dispose: () => Promise<void> };
      disposeRuntime: () => Promise<void>;
    };
    const cleanup = vi.fn(async () => undefined);
    internal.managedProcesses = { dispose: cleanup };
    await internal.disposeRuntime();
    expect(cleanup).not.toHaveBeenCalled();
    const runtimeCleanup = vi.spyOn(internal, "disposeRuntime").mockImplementation(async () => {
      expect(cleanup).toHaveBeenCalledTimes(1);
    });
    await service.dispose();
    expect(runtimeCleanup).toHaveBeenCalledTimes(1);
    runtimeCleanup.mockRestore();
  });
});

describe("AgentService 验证进度接线", () => {
  it("forwards host progress and terminal states to main validation and renderer", () => {
    const service = new AgentService();
    const internal = service as unknown as {
      validationTool: { onValidationChanged: (state: ValidationState) => void };
    };
    const mainUpdates = vi.spyOn(internal.validationTool, "onValidationChanged");
    const events: AgentEvent[] = [];
    service.subscribe((event) => events.push(event));
    const publish = validationPublisher(service);
    const progress = { ...validationState("running", "child-run"), activeStep: "test" as const,
      steps: [{ id: "test" as const, label: "Tests", command: "npm test", status: "running" as const,
        output: "真实宿主进度", exitCode: null, durationMs: null }] };
    const failed = { ...progress, status: "failed" as const, message: "检查失败" };

    publish(progress);
    publish(failed);

    expect(mainUpdates.mock.calls).toEqual([[progress], [failed]]);
    expect(events.filter((event) => event.type === "validation")).toEqual([
      { type: "validation", validation: progress }, { type: "validation", validation: failed },
    ]);
    mainUpdates.mockRestore();
  });
});

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

describe("AgentService settled 后台刷新", () => {
  afterEach(() => vi.restoreAllMocks());

  function harness() {
    const sessionManager = SessionManager.inMemory("C:/project");
    const session = {
      sessionId: "old-session", messages: [], isStreaming: false, isCompacting: false,
      pendingMessageCount: 0, model: null, getContextUsage: () => undefined, sessionManager,
    } as unknown as AgentSession;
    const service = new AgentService();
    const history = {
      getState: vi.fn(async () => EMPTY_AGENT_SNAPSHOT.history),
      getReview: vi.fn(async () => EMPTY_AGENT_SNAPSHOT.review),
    };
    const internal = service as unknown as {
      runtime: { session: AgentSession }; projectPath: string;
      handleSessionEvent: (activeSession: AgentSession, event: AgentSessionEvent) => void;
    };
    Object.assign(service, { runtime: { session }, projectPath: "C:/project", history: {
      ...history, getSnapshot: async () => ({ history: await history.getState(), review: await history.getReview() }),
    } });
    const events: AgentEvent[] = [];
    service.subscribe((event) => events.push(event));
    return { service, session, internal, history, events };
  }

  it("catches settled history and review rejections and publishes recoverable notices", async () => {
    const { session, internal, history, events } = harness();
    history.getState.mockRejectedValue(new Error("HEAD state missing"));
    history.getReview.mockRejectedValue(new Error("HEAD review missing"));

    internal.handleSessionEvent(session, { type: "agent_settled" } as AgentSessionEvent);

    await vi.waitFor(() => expect(events.filter((event) => event.type === "notice")).toEqual([
      { type: "notice", message: "历史状态刷新失败，可稍后重试：HEAD state missing" },
      { type: "notice", message: "变更评审刷新失败，可稍后重试：HEAD review missing" },
    ]));
    expect(events.filter((event) => event.type === "history" || event.type === "review")).toEqual([]);
  });

  it.each(["runtime", "sessionId", "cwd"])("skips queued reads after %s changes", async (change) => {
    const { session, internal, history, events } = harness();
    internal.handleSessionEvent(session, { type: "agent_settled" } as AgentSessionEvent);
    if (change === "runtime") internal.runtime = { session: {} as AgentSession };
    if (change === "sessionId") Object.defineProperty(session, "sessionId", { value: "new-session" });
    if (change === "cwd") vi.spyOn(session.sessionManager, "getCwd").mockReturnValue("C:/other");
    await Promise.resolve();
    await Promise.resolve();

    expect(history.getState).not.toHaveBeenCalled();
    expect(history.getReview).not.toHaveBeenCalled();
    expect(events.filter((event) => ["sessions", "history", "review", "notice"].includes(event.type))).toEqual([]);
  });

  it.each([
    { change: "runtime", reject: false }, { change: "runtime", reject: true },
    { change: "sessionId", reject: false }, { change: "sessionId", reject: true },
    { change: "cwd", reject: false }, { change: "cwd", reject: true },
  ])("discards in-flight results or errors after $change changes (reject=$reject)", async ({ change, reject }) => {
    const { session, internal, history, events } = harness();
    let finishState!: () => void;
    let finishReview!: () => void;
    history.getState.mockImplementation(() => new Promise((resolve, fail) => {
      finishState = () => reject ? fail(new Error("old HEAD state")) : resolve(EMPTY_AGENT_SNAPSHOT.history);
    }));
    history.getReview.mockImplementation(() => new Promise((resolve, fail) => {
      finishReview = () => reject ? fail(new Error("old HEAD review")) : resolve(EMPTY_AGENT_SNAPSHOT.review);
    }));
    internal.handleSessionEvent(session, { type: "agent_settled" } as AgentSessionEvent);
    await Promise.resolve();
    expect(history.getState).toHaveBeenCalledTimes(1);
    expect(history.getReview).toHaveBeenCalledTimes(1);
    if (change === "runtime") {
      internal.runtime = { session: {} as AgentSession };
      internal.projectPath = "C:/other";
    }
    if (change === "sessionId") Object.defineProperty(session, "sessionId", { value: "new-session" });
    if (change === "cwd") vi.spyOn(session.sessionManager, "getCwd").mockReturnValue("C:/other");
    const beforeCompletion = [...events];
    finishState();
    finishReview();
    // 等待读取及后台 catch 全部完成，Vitest 同时会报告未处理的拒绝。
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(events).toEqual(beforeCompletion);
  });

  it("keeps switched-session conversation available when history returns unavailable states", async () => {
    const { service, internal, history } = harness();
    const sessionManager = SessionManager.inMemory("C:/other");
    sessionManager.appendMessage({ role: "user", content: "new conversation", timestamp: 1 });
    const session = {
      sessionId: "new-session", sessionManager, model: null,
      messages: sessionManager.buildSessionContext().messages,
      modelRuntime: { getAvailable: async () => [] },
      resourceLoader: { getAgentsFiles: () => ({ agentsFiles: [] }) },
      getContextUsage: () => undefined, getAvailableThinkingLevels: () => ["off"],
      thinkingLevel: "off", isStreaming: false, isCompacting: false, pendingMessageCount: 0,
    } as unknown as AgentSession;
    Object.assign(internal, { runtime: { session, diagnostics: [] }, projectPath: "C:/other" });
    const unavailableHistory = { ...EMPTY_AGENT_SNAPSHOT.history, message: "HEAD missing" };
    const unavailableReview = { ...EMPTY_AGENT_SNAPSHOT.review, message: "HEAD missing" };
    history.getState.mockResolvedValue(unavailableHistory);
    history.getReview.mockResolvedValue(unavailableReview);

    const snapshot = await service.getSnapshot();

    expect(snapshot.sessionId).toBe("new-session");
    expect(snapshot.timeline).toContainEqual(expect.objectContaining({
      kind: "message", message: expect.objectContaining({ text: "new conversation" }),
    }));
    expect(snapshot.history).toEqual(unavailableHistory);
    expect(snapshot.review).toEqual(unavailableReview);
    expect(snapshot.error).toBeNull();
  });
});

describe("AgentService prompt lifecycle", () => {
  afterEach(() => {
    sessionSummaryState.sessions = [];
    sessionSummaryState.pending = undefined;
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
    const session = { sessionFile: activePath, sessionManager: SessionManager.inMemory("C:/project"), isStreaming: false, isCompacting: false } as unknown as AgentSession;
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

  it("includes SDK-supported thinking levels for every snapshot model", async () => {
    const availableModels = [
      { id: "standard", reasoning: true },
      { id: "excluded", reasoning: true, thinkingLevelMap: { low: null } },
      { id: "extended", reasoning: true, thinkingLevelMap: { xhigh: "extra", max: "maximum" } },
      { id: "plain", reasoning: false, thinkingLevelMap: { xhigh: "extra", max: "maximum" } },
    ].map((model) => ({ ...model, provider: "provider", name: model.id, input: ["text"] }));
    const session = {
      sessionId: "session-models",
      model: null,
      modelRuntime: { getAvailable: async () => availableModels },
      messages: [],
      sessionManager: SessionManager.inMemory("C:/project"),
      getContextUsage: () => undefined,
      resourceLoader: { getAgentsFiles: () => ({ agentsFiles: [] }) },
      thinkingLevel: "off",
      getAvailableThinkingLevels: () => ["off"],
      isStreaming: false,
      isCompacting: false,
      pendingMessageCount: 0,
    } as unknown as AgentSession;
    const service = new AgentService();
    // 沿用现有运行时注入方式，仅隔离与模型能力无关的工作区历史读取。
    Object.assign(service, {
      projectPath: "C:/project",
      runtime: { session, diagnostics: [] },
      history: {
        getSnapshot: async () => ({ history: EMPTY_AGENT_SNAPSHOT.history, review: EMPTY_AGENT_SNAPSHOT.review }),
      },
    });

    const snapshot = await service.getSnapshot();

    expect(snapshot.models).toEqual([
      { id: "standard", provider: "provider", name: "standard", reasoning: true,
        thinkingLevels: ["off", "minimal", "low", "medium", "high"], supportsImages: false },
      { id: "excluded", provider: "provider", name: "excluded", reasoning: true,
        thinkingLevels: ["off", "minimal", "medium", "high"], supportsImages: false },
      { id: "extended", provider: "provider", name: "extended", reasoning: true,
        thinkingLevels: ["off", "minimal", "low", "medium", "high", "xhigh", "max"], supportsImages: false },
      { id: "plain", provider: "provider", name: "plain", reasoning: false,
        thinkingLevels: ["off"], supportsImages: false },
    ]);
    expect(snapshot.thinkingLevels).toEqual(["off"]);
    expect(snapshot.processes).toEqual([]);
  });

  it.each([false, true])("已初始化列表连续切换不额外扫描；未初始化仅扫描一次：%s", async (initialized) => {
    const directory = await mkdtemp(join(tmpdir(), "pi-session-switch-"));
    const path = join(directory, "selected.jsonl");
    const otherPath = join(directory, "other.jsonl");
    await writeFile(path, "session", "utf8");
    await writeFile(otherPath, "other session", "utf8");
    try {
    sessionSummaryState.sessions = [
      { path, id: "selected", title: "stale title", modifiedAt: 1, messageCount: 1 },
      { path: otherPath, id: "other", title: "other stale title", modifiedAt: 1, messageCount: 1 },
    ];
    sessionSummaryState.scans = 0;
    const session = {
      sessionId: "selected", sessionFile: path, sessionName: "current title",
      model: null, modelRuntime: { getAvailable: async () => [] }, messages: [],
      sessionManager: SessionManager.inMemory("C:/project"), getContextUsage: () => undefined,
      resourceLoader: { getAgentsFiles: () => ({ agentsFiles: [] }) },
      thinkingLevel: "off", getAvailableThinkingLevels: () => ["off"],
      isStreaming: false, isCompacting: false, pendingMessageCount: 0,
    } as unknown as AgentSession;
    const switchSession = vi.fn(async (target: string) => {
      Object.assign(session, { sessionFile: target, sessionId: target === path ? "selected" : "other",
        sessionName: target === path ? "current title" : "other current title" });
      return { cancelled: false };
    });
    const getSnapshot = vi.fn(async () => ({ history: EMPTY_AGENT_SNAPSHOT.history, review: EMPTY_AGENT_SNAPSHOT.review }));
    const service = new AgentService();
    Object.assign(service, { projectPath: "C:/project", runtime: { session, switchSession, diagnostics: [] },
      history: { getSnapshot } });
    const events: AgentEvent[] = [];
    service.subscribe((event) => events.push(event));

    if (initialized) await service.getSnapshot();
    const scansBeforeSwitch = sessionSummaryState.scans;
    const otherSnapshot = await service.switchSession(otherPath);
    const snapshot = await service.switchSession(path);

    expect(sessionSummaryState.scans - scansBeforeSwitch).toBe(initialized ? 0 : 1);
    expect(sessionSummaryState.scans).toBe(1);
    expect(switchSession.mock.calls).toEqual([[otherPath], [path]]);
    expect(otherSnapshot).toMatchObject({ sessionId: "other", sessionFile: otherPath, sessionTitle: "other current title" });
    expect(snapshot).toMatchObject({ sessionId: "selected", sessionFile: path, sessionTitle: "current title" });
    expect(getSnapshot).toHaveBeenCalledTimes(initialized ? 3 : 2);
    expect(snapshot.sessions.map((summary) => summary.title)).toEqual(["current title", "other current title"]);
    expect(events.filter((event) => event.type === "snapshot").at(-1)).toEqual({ type: "snapshot", snapshot });
    switchSession.mockClear();
    await expect(service.switchSession("C:/outside.jsonl")).rejects.toThrow("active project");
    expect(switchSession).not.toHaveBeenCalled();
    expect(getSnapshot).toHaveBeenCalledTimes(initialized ? 3 : 2);
    expect(sessionSummaryState.scans).toBe(1);
    await rm(path);
    await expect(service.switchSession(path)).rejects.toThrow();
    await mkdir(path);
    await expect(service.switchSession(path)).rejects.toThrow("not a file");
    expect(switchSession).not.toHaveBeenCalled();
    Object.assign(service, { projectPath: "C:/other-project" });
    sessionSummaryState.sessions = [];
    await expect(service.switchSession(path)).rejects.toThrow("active project");
    expect(switchSession).not.toHaveBeenCalled();
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it("旧项目或旧会话的刷新结果不能覆盖当前列表", async () => {
    const session = { sessionId: "old", sessionManager: SessionManager.inMemory("C:/old") } as unknown as AgentSession;
    const service = new AgentService();
    Object.assign(service, { projectPath: "C:/old", runtime: { session } });
    const internals = service as unknown as { refreshSessions: () => Promise<void> };
    const events: AgentEvent[] = [];
    service.subscribe((event) => events.push(event));
    for (const changeProject of [false, true]) {
      let finish = (_sessions: SessionSummary[]): void => undefined;
      sessionSummaryState.pending = new Promise<SessionSummary[]>((resolve) => { finish = resolve; });
      const oldRefresh = internals.refreshSessions();
      if (changeProject) Object.assign(service, { projectPath: "C:/new", runtime: { session: { sessionId: "new-project", sessionManager: SessionManager.inMemory("C:/new") } } });
      else Object.assign(session, { sessionId: "new-session" });
      sessionSummaryState.pending = undefined;
      sessionSummaryState.sessions = [{ path: "new.jsonl", id: "new", title: "New", modifiedAt: 1, messageCount: 1 }];
      await internals.refreshSessions();
      finish([{ path: "old.jsonl", id: "old", title: "Old", modifiedAt: 1, messageCount: 1 }]);
      await oldRefresh;
      // 从公开切换行为验证旧路径不在列表：拒绝发生在 stat/runtime 之前且不重扫。
      const scans = sessionSummaryState.scans;
      await expect(service.switchSession("old.jsonl")).rejects.toThrow("active project");
      expect(sessionSummaryState.scans).toBe(scans);
      expect(events.filter((event) => event.type === "sessions").at(-1)).toEqual({ type: "sessions", sessions: sessionSummaryState.sessions });
    }
  });

  it("取消或 SDK 报错不改目标标题，旧刷新也不覆盖新 snapshot 列表", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-session-cancel-"));
    const path = join(directory, "target.jsonl");
    await writeFile(path, "session", "utf8");
    try {
      const session = {
        sessionId: "active", sessionFile: "active.jsonl", sessionName: "active title",
        model: null, modelRuntime: { getAvailable: async () => [] }, messages: [],
        sessionManager: SessionManager.inMemory(directory), getContextUsage: () => undefined,
        resourceLoader: { getAgentsFiles: () => ({ agentsFiles: [] }) },
        thinkingLevel: "off", getAvailableThinkingLevels: () => ["off"], pendingMessageCount: 0,
      } as unknown as AgentSession;
      const switchSession = vi.fn(async () => ({ cancelled: true }));
      const service = new AgentService();
      Object.assign(service, { projectPath: directory, runtime: { session, switchSession, diagnostics: [] },
        history: { getSnapshot: async () => ({ history: EMPTY_AGENT_SNAPSHOT.history, review: EMPTY_AGENT_SNAPSHOT.review }) } });
      sessionSummaryState.sessions = [{ path, id: "target", title: "original title", modifiedAt: 1, messageCount: 1 }];
      await service.getSnapshot();
      const cancelled = await service.switchSession(path);
      expect(cancelled.sessions[0]?.title).toBe("original title");
      // 即使请求当前路径，cancelled 也必须优先，不能把当前标题写入目标摘要。
      Object.assign(session, { sessionFile: path });
      expect((await service.switchSession(path)).sessions[0]?.title).toBe("original title");
      Object.assign(session, { sessionFile: "active.jsonl" });
      switchSession.mockRejectedValueOnce(new Error("SDK failed"));
      await expect(service.switchSession(path)).rejects.toThrow("SDK failed");
      const internals = service as unknown as { refreshSessions: () => Promise<void> };
      let finish = (_sessions: SessionSummary[]): void => undefined;
      sessionSummaryState.pending = new Promise<SessionSummary[]>((resolve) => { finish = resolve; });
      const oldRefresh = internals.refreshSessions();
      sessionSummaryState.pending = undefined;
      sessionSummaryState.sessions = [{ ...sessionSummaryState.sessions[0]!, title: "fresh title" }];
      await internals.refreshSessions();
      await service.getSnapshot();
      finish([]);
      await oldRefresh;
      const scans = sessionSummaryState.scans;
      const afterFailure = await service.switchSession(path);
      expect(afterFailure.sessions[0]?.title).toBe("fresh title");
      expect(sessionSummaryState.scans).toBe(scans);
    } finally { await rm(directory, { recursive: true, force: true }); }
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
      messages: [],
      sessionManager: { getBranch: () => [{ type: "message", message: {
        role: "toolResult", toolCallId: "call-1", toolName: "bash",
        content: [{ type: "text", text: "complete output" }], isError: false,
      } }] },
    } as unknown as AgentSession;
    const service = new AgentService();
    Object.assign(service as unknown as { runtime: { session: AgentSession } }, { runtime: { session } });

    expect(service.getToolOutput("call-1")).toBe("complete output");
    expect(() => service.getToolOutput("missing")).toThrow("active session");
    expect(() => service.getToolOutput("x".repeat(201))).toThrow("Invalid tool call id");
  });

  it("reads historical images only by active-session indexes", () => {
    const session = {
      messages: [],
      sessionManager: { getBranch: () => [{ type: "message", message: { role: "user", content: [
        { type: "text", text: "Inspect" },
        { type: "image", mimeType: "image/png", data: "aGVsbG8=" },
      ] } }] },
    } as unknown as AgentSession;
    const service = new AgentService();
    Object.assign(service as unknown as { runtime: { session: AgentSession } }, { runtime: { session } });

    expect(service.getConversationImage("0:1")?.data).toEqual(Uint8Array.from([104, 101, 108, 108, 111]));
    expect(() => service.getConversationImage("../image.png")).toThrow("Invalid conversation image id");
    expect(service.getConversationImage("0:9")).toBeNull();
  });

  it("publishes current images after message_end is followed by a synchronous history append", async () => {
    const sessionManager = SessionManager.inMemory("C:/project");
    sessionManager.appendMessage({ role: "user", content: "ordinary history", timestamp: 1 });
    const oldImageId = sessionManager.appendMessage({ role: "user", content: [
      { type: "text", text: "old image" },
      { type: "image", mimeType: "image/png", data: "b2xk" },
    ], timestamp: 2 });
    sessionManager.appendCompaction("compressed history", oldImageId, 100);
    const session = {
      model: null,
      isCompacting: false,
      getContextUsage: () => undefined,
      sessionManager,
      get messages() { return sessionManager.buildSessionContext().messages; },
    } as unknown as AgentSession;
    const service = new AgentService();
    const internal = service as unknown as {
      runtime: { session: AgentSession };
      handleSessionEvent: (activeSession: AgentSession, event: AgentSessionEvent) => void;
    };
    internal.runtime = { session };
    const events: AgentEvent[] = [];
    service.subscribe((event) => events.push(event));
    const message = { role: "user" as const, content: [
      { type: "text" as const, text: "current images" },
      { type: "image" as const, mimeType: "image/png", data: "Zmlyc3Q=" },
      { type: "image" as const, mimeType: "image/jpeg", data: "c2Vjb25k" },
    ], timestamp: 3 };

    // 复现 SDK 的通知顺序：先发事件，同一调用栈再追加原消息引用。
    internal.handleSessionEvent(session, { type: "message_end", message });
    expect(events.filter((event) => event.type === "timeline-upsert")).toEqual([]);
    sessionManager.appendMessage(message);
    await Promise.resolve();

    const upserts = events.filter((event) => event.type === "timeline-upsert");
    expect(upserts).toHaveLength(1);
    const published = upserts[0];
    if (published?.type !== "timeline-upsert" || published.item.kind !== "message") {
      throw new Error("未收到本次用户消息。");
    }
    expect(published.item.message.images?.map((image) => image.sourceId)).toEqual(["3:1", "3:2"]);
    const payloads = published.item.message.images?.map((image) => {
      const sourceId = image.sourceId;
      if (sourceId === undefined) throw new Error("本次图片缺少 sourceId。");
      return service.getConversationImage(sourceId);
    });
    expect(payloads).toEqual([
      { mimeType: "image/png", data: Uint8Array.from(Buffer.from("first")) },
      { mimeType: "image/jpeg", data: Uint8Array.from(Buffer.from("second")) },
    ]);
    expect(service.getConversationImage("1:1")?.data).toEqual(Uint8Array.from(Buffer.from("old")));
    expect(session.messages).not.toContainEqual(expect.objectContaining({ content: "ordinary history" }));
    const page = service.loadOlderTimeline();
    expect(page.timeline.find((item) => item.id === published.item.id)).toEqual(published.item);
    expect(page.timeline.at(-1)).toEqual(published.item);
  });

  it("drops a deferred user upsert when the active session changes before the microtask", async () => {
    const sessionManager = SessionManager.inMemory("C:/project");
    const session = {
      model: null,
      isCompacting: false,
      getContextUsage: () => undefined,
      sessionManager,
    } as unknown as AgentSession;
    const service = new AgentService();
    const internal = service as unknown as {
      runtime: { session: AgentSession };
      handleSessionEvent: (activeSession: AgentSession, event: AgentSessionEvent) => void;
    };
    internal.runtime = { session };
    const events: AgentEvent[] = [];
    service.subscribe((event) => events.push(event));
    const message = { role: "user" as const, content: [
      { type: "image" as const, mimeType: "image/png", data: "b2xk" },
    ], timestamp: 1 };

    internal.handleSessionEvent(session, { type: "message_end", message });
    sessionManager.appendMessage(message);
    // 同一调用栈切换运行时，旧消息微任务不得向新会话发布。
    internal.runtime = { session: { sessionManager: SessionManager.inMemory("C:/other") } as unknown as AgentSession };
    const beforeMicrotask = [...events];
    await Promise.resolve();

    expect(events).toEqual(beforeMicrotask);
    expect(events.filter((event) => event.type === "timeline-upsert")).toEqual([]);
    expect(service.getConversationImage("0:0")).toBeNull();
    expect(service.loadOlderTimeline().timeline).toEqual([]);
  });

  it("pages complete conversation history after runtime compaction", () => {
    const entries = Array.from({ length: 30 }, (_, index) => ({
      type: "message", message: { role: "user", content: [{ type: "text", text: `turn-${index}` }], timestamp: index + 1 },
    }));
    const session = {
      messages: [{ role: "compactionSummary", summary: "older turns" }, entries[29]?.message],
      sessionManager: { getBranch: () => entries },
    } as unknown as AgentSession;
    const service = new AgentService();
    Object.assign(service as unknown as { runtime: { session: AgentSession } }, { runtime: { session } });

    const page = service.loadOlderTimeline();
    expect(page.timeline.filter((item) => item.kind === "message")).toHaveLength(30);
    expect(page.timeline[0]).toMatchObject({ kind: "message", message: { text: "turn-0" } });
    expect(page.timeline.at(-1)).toMatchObject({ kind: "message", message: { text: "turn-29" } });
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
    let finishPreflight: PromptOptions["preflightResult"];
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
    finishPreflight?.("started");
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

  it("rejects stale confirmation replies before SDK prompt and surfaces the error", async () => {
    const session = { isIdle: true, prompt: vi.fn(), sessionManager: { getBranch: () => [] } } as unknown as AgentSession;
    const service = new AgentService();
    Object.assign(service as unknown as { runtime: { session: AgentSession } }, { runtime: { session } });
    const events: AgentEvent[] = [];
    service.subscribe((event) => events.push(event));
    const wire = createConfirmationResponse({ requestId: "stale", title: "旧请求", message: "说明" }, true, "");
    await expect(service.prompt(wire)).rejects.toThrow("失效");
    expect(session.prompt).not.toHaveBeenCalled();
    expect(events.at(-1)).toMatchObject({ type: "error", message: expect.stringContaining("失效") });
  });

  it("honors stop requests made before agent_start", async () => {
    let finishPrompt: (() => void) | undefined;
    let finishPreflight: PromptOptions["preflightResult"];
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
    finishPreflight?.("started");
    await vi.waitFor(() => expect(session.abort).toHaveBeenCalled());
    finishPrompt?.();
    await Promise.all([promptOperation, stopOperation]);
    expect(session.clearQueue).toHaveBeenCalled();
  });
});
