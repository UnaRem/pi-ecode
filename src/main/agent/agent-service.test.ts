import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentSession, AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import type { AgentEvent, SessionSummary } from "../../shared/contracts.js";

const sessionSummaryState = vi.hoisted(() => ({ sessions: [] as SessionSummary[] }));
vi.mock("./session-summaries.js", () => ({
  listSessionSummaries: async () => sessionSummaryState.sessions,
}));

import { AgentService } from "./agent-service.js";

interface PromptOptions {
  preflightResult?: (accepted: boolean) => void;
}

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
