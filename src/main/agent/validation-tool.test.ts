import { describe, expect, it, vi } from "vitest";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { ValidationState } from "../../shared/contracts.js";
import { ValidationToolService } from "./validation-tool.js";

function state(patch: Partial<ValidationState> = {}): ValidationState {
  return {
    supported: true,
    isSelfProject: false,
    status: "idle",
    runId: null,
    activeStep: null,
    steps: [],
    sourceRevision: null,
    originToolCallId: null,
    startedAt: null,
    verifiedAt: null,
    message: null,
    ...patch,
  };
}

function harness(initial = state()) {
  let current = initial;
  let tool: ToolDefinition | undefined;
  const start = vi.fn();
  const sent: Array<{ message: unknown; options: unknown }> = [];
  const service = new ValidationToolService({ getState: () => current, start });
  const pi = {
    registerTool: (definition: ToolDefinition) => { tool = definition; },
    sendMessage: (message: unknown, options: unknown) => sent.push({ message, options }),
  } as unknown as ExtensionAPI;
  const extension = service.asExtension();
  void (typeof extension === "function" ? extension(pi) : extension.factory(pi));
  return {
    service,
    start,
    sent,
    setState: (next: ValidationState) => { current = next; },
    execute: async () => {
      if (!tool) throw new Error("Validation tool was not registered.");
      return tool.execute("validation-call", {}, undefined, undefined, {} as ExtensionContext);
    },
  };
}

describe("ValidationToolService", () => {
  it("starts the fixed background validation without accepting commands", async () => {
    const test = harness();

    const result = await test.execute();

    expect(test.start).toHaveBeenCalledWith("validation-call");
    expect(result.content).toEqual([expect.objectContaining({ text: expect.stringContaining("background") })]);
  });

  it("rejects unsupported and duplicate validation runs", async () => {
    await expect(harness(state({ supported: false })).execute()).rejects.toThrow("no configured");
    await expect(harness(state({ status: "running" })).execute()).rejects.toThrow("already running");
  });

  it("delivers one hidden terminal result and preserves its follow-up turn", () => {
    const test = harness();
    const completed = state({
      status: "passed",
      runId: "run-1",
      originToolCallId: "validation-call",
      sourceRevision: "tree-a",
      verifiedAt: 2,
      message: "All configured checks passed.",
    });

    test.service.onValidationChanged(completed);
    test.service.onValidationChanged(completed);

    expect(test.sent).toHaveLength(1);
    expect(test.sent[0]?.options).toEqual({ triggerTurn: true, deliverAs: "followUp" });
    expect(test.service.consumePreservedAgentStart()).toBe(true);
    expect(test.service.consumePreservedAgentStart()).toBe(false);
  });

  it("does not notify the model for manual validation", () => {
    const test = harness();
    test.service.onValidationChanged(state({ status: "failed", runId: "manual", originToolCallId: null }));
    expect(test.sent).toHaveLength(0);
  });
});
