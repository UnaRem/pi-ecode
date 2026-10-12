import { describe, expect, it, vi } from "vitest";
import type { AgentSession, PromptOptions } from "@earendil-works/pi-coding-agent";
import { PromptLifecycle } from "./prompt-lifecycle.js";

type PromptDisposition = Parameters<NonNullable<PromptOptions["preflightResult"]>>[0];

function deferred() {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((accept, fail) => { resolve = accept; reject = fail; });
  return { promise, resolve, reject };
}

function harness() {
  const requests: Array<{ text: string; options: PromptOptions; completion: ReturnType<typeof deferred> }> = [];
  const session = {
    isStreaming: false,
    prompt: vi.fn((text: string, options: PromptOptions) => {
      const completion = deferred();
      requests.push({ text, options, completion });
      return completion.promise;
    }),
    steer: vi.fn(async () => undefined),
    clearQueue: vi.fn(),
    abort: vi.fn(async () => undefined),
  };
  const agentSession = session as unknown as AgentSession;
  const changed = vi.fn();
  const lifecycle = new PromptLifecycle(changed);
  return { session, agentSession, requests, changed, lifecycle,
    send: (text: string) => lifecycle.prompt(agentSession, text, []),
    preflight: (index: number, disposition: PromptDisposition) => requests[index]!.options.preflightResult?.(disposition),
  };
}

describe("PromptLifecycle", () => {
  it.each(["started", "queued"] as const)("steers pending messages after %s", async (disposition) => {
    const test = harness();
    const first = test.send("first");
    const second = test.send("second");
    const third = test.send("third");
    test.preflight(0, disposition);
    await Promise.all([second, third]);
    expect(test.session.steer.mock.calls).toEqual([["second", []], ["third", []]]);
    expect(test.lifecycle.isActive(test.agentSession)).toBe(disposition === "started");
    test.requests[0]!.completion.resolve();
    await first;
    expect(test.lifecycle.isActive(test.agentSession)).toBe(false);
  });

  it("replays handled prompts and retains the new owner when the old request finishes", async () => {
    const test = harness();
    const first = test.send("command");
    const second = test.send("second");
    const third = test.send("third");
    test.preflight(0, "handled");
    expect(test.requests.map((request) => request.text)).toEqual(["command", "second"]);
    test.requests[0]!.completion.resolve();
    await first;
    expect(test.lifecycle.isActive(test.agentSession)).toBe(true);
    expect(test.lifecycle.workingStartedAt).not.toBeNull();
    test.preflight(1, "started");
    await third;
    expect(test.session.steer).toHaveBeenCalledWith("third", []);
    test.requests[1]!.completion.resolve();
    await second;
    expect(test.lifecycle.isActive(test.agentSession)).toBe(false);
  });

  it("rejects all pending messages when asynchronous preflight fails", async () => {
    const test = harness();
    const first = test.send("first");
    const second = test.send("second");
    const third = test.send("third");
    const settled = Promise.allSettled([first, second, third]);
    const failure = new Error("preflight failed");
    test.requests[0]!.completion.reject(failure);
    expect(await settled).toEqual([
      { status: "rejected", reason: failure },
      { status: "rejected", reason: failure },
      { status: "rejected", reason: failure },
    ]);
    expect(test.lifecycle.isActive(test.agentSession)).toBe(false);
  });

  it("does not let a handled request failure reject the new owner's pending messages", async () => {
    const test = harness();
    const first = test.send("command");
    const firstResult = first.catch((error: unknown) => error);
    const second = test.send("second");
    const third = test.send("third");
    test.preflight(0, "handled");
    const failure = new Error("old command failed");
    test.requests[0]!.completion.reject(failure);
    expect(await firstResult).toBe(failure);
    test.preflight(1, "started");
    await third;
    test.requests[1]!.completion.resolve();
    await second;
  });

  it.each(["started", "queued", "handled"] as const)("supports synchronous %s callbacks", async (disposition) => {
    const test = harness();
    const completion = deferred();
    test.session.prompt.mockImplementation((_text, options) => {
      options.preflightResult?.(disposition);
      return completion.promise;
    });
    const operation = test.send("first");
    expect(test.lifecycle.isActive(test.agentSession)).toBe(disposition === "started");
    completion.resolve();
    await operation;
    expect(test.lifecycle.isActive(test.agentSession)).toBe(false);
  });

  it("cleans up a synchronous prompt failure", async () => {
    const test = harness();
    test.session.prompt.mockImplementation(() => { throw new Error("synchronous failure"); });
    await expect(test.send("first")).rejects.toThrow("synchronous failure");
    expect(test.lifecycle.isActive(test.agentSession)).toBe(false);
    expect(test.lifecycle.workingStartedAt).toBeNull();
  });

  it.each(["started", "queued", "handled"] as const)("resolves pending work and does not replay after stop with %s", async (disposition) => {
    const test = harness();
    const first = test.send("first");
    const second = test.send("second");
    const stopping = test.lifecycle.stop(test.agentSession);
    await second;
    await expect(test.send("blocked")).rejects.toThrow("stopping");
    test.preflight(0, disposition);
    await Promise.resolve();
    expect(test.session.prompt).toHaveBeenCalledTimes(1);
    expect(test.session.steer).not.toHaveBeenCalled();
    expect(test.session.clearQueue).toHaveBeenCalledTimes(2);
    expect(test.session.abort).toHaveBeenCalledTimes(disposition === "started" ? 1 : 0);
    test.requests[0]!.completion.resolve();
    await Promise.all([first, stopping]);
    expect(test.lifecycle.isActive(test.agentSession)).toBe(false);
  });

  it("retains a new prompt after reset when the old request settles", async () => {
    const test = harness();
    const first = test.send("first");
    const pending = test.send("pending");
    test.lifecycle.reset();
    await pending;
    const next = test.send("next");
    test.requests[0]!.completion.resolve();
    await first;
    expect(test.lifecycle.isActive(test.agentSession)).toBe(true);
    test.preflight(1, "started");
    test.requests[1]!.completion.resolve();
    await next;
    expect(test.lifecycle.isActive(test.agentSession)).toBe(false);
  });
});
