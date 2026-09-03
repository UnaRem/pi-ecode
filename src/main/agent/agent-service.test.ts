import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { AgentEvent } from "../../shared/contracts.js";
import { AgentService } from "./agent-service.js";

interface PromptOptions {
  preflightResult?: (accepted: boolean) => void;
}

describe("AgentService prompt lifecycle", () => {
  afterEach(() => vi.restoreAllMocks());

  it("normalizes and persists a renamed session", () => {
    const session = { setSessionName: vi.fn() } as unknown as AgentSession;
    const service = new AgentService();
    Object.assign(service as unknown as { runtime: { session: AgentSession } }, { runtime: { session } });

    service.renameSession(`  Renamed\nconversation ${"x".repeat(90)}  `);

    const savedTitle = vi.mocked(session.setSessionName).mock.calls[0]?.[0] ?? "";
    expect(savedTitle).toBe("Renamed conversation " + "x".repeat(59));
    expect(savedTitle).toHaveLength(80);
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
