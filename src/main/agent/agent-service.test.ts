import { describe, expect, it, vi } from "vitest";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { AgentEvent } from "../../shared/contracts.js";
import { AgentService } from "./agent-service.js";

interface PromptOptions {
  preflightResult?: (accepted: boolean) => void;
}

describe("AgentService prompt lifecycle", () => {
  it("shows work immediately and steers messages submitted during preflight", async () => {
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
    expect(events.at(-1)).toEqual({ type: "state", patch: { isStreaming: true, pendingCount: 0, error: null } });
    const steeringPrompt = service.prompt("continue");

    expect(session.prompt).toHaveBeenCalledTimes(1);
    expect(session.steer).not.toHaveBeenCalled();
    finishPreflight?.(true);
    await steeringPrompt;
    expect(session.steer).toHaveBeenCalledWith("continue", []);
    finishPrompt?.();
    await firstPrompt;
    expect(events.at(-1)).toEqual({ type: "state", patch: { isStreaming: false, pendingCount: 0 } });
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
