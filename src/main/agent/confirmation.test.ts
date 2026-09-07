import type { ExtensionAPI, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { CONFIRMATION_TOOL_NAME, ConfirmationService } from "./confirmation.js";

type ToolCallHandler = (
  event: { toolName: string },
  context: ExtensionContext,
) => { block: true; terminate: true; reason: string } | undefined;

type ConfirmationTool = {
  name: string;
  executionMode: string;
  promptGuidelines: string[];
  execute: (
    id: string,
    params: { title: string; message: string },
    signal: AbortSignal,
    onUpdate: undefined,
    context: ExtensionContext,
  ) => Promise<{ content: Array<{ type: string; text: string }>; details: { confirmed: boolean } }>;
};

function harness() {
  let tool: ConfirmationTool | undefined;
  let toolCallHandler: ToolCallHandler | undefined;
  const pi = {
    on: (name: string, handler: ToolCallHandler) => {
      if (name === "tool_call") toolCallHandler = handler;
    },
    registerTool: (definition: ConfirmationTool) => { tool = definition; },
  } as unknown as ExtensionAPI;
  const extension = new ConfirmationService().asExtension();
  void (typeof extension === "function" ? extension(pi) : extension.factory(pi));
  if (!tool || !toolCallHandler) throw new Error("Confirmation extension was not registered.");
  return { tool, toolCallHandler };
}

function contextWithBranch(branch: SessionEntry[], confirm = vi.fn()): ExtensionContext {
  return {
    sessionManager: { getBranch: () => branch },
    ui: { confirm },
  } as unknown as ExtensionContext;
}

describe("ConfirmationService", () => {
  it("opens a blocking confirmation dialog and reports the response", async () => {
    const test = harness();
    const confirm = vi.fn().mockResolvedValue(true);
    const context = contextWithBranch([], confirm);

    const result = await test.tool.execute(
      "call-confirm",
      { title: "Apply changes?", message: "Update two files." },
      new AbortController().signal,
      undefined,
      context,
    );

    expect(test.tool.executionMode).toBe("sequential");
    expect(test.tool.promptGuidelines.join(" ")).toContain("only tool");
    expect(confirm).toHaveBeenCalledWith("Apply changes?", "Update two files.");
    expect(result).toMatchObject({ details: { confirmed: true } });
    expect(result.content[0]?.text).toContain("user confirmed");
  });

  it("reports cancellation without authorizing the proposed action", async () => {
    const test = harness();
    const context = contextWithBranch([], vi.fn().mockResolvedValue(false));

    const result = await test.tool.execute(
      "call-confirm",
      { title: "Apply changes?", message: "Update two files." },
      new AbortController().signal,
      undefined,
      context,
    );

    expect(result).toMatchObject({ details: { confirmed: false } });
    expect(result.content[0]?.text).toContain("Do not perform it");
  });

  it("blocks sibling tools when a response requests confirmation", () => {
    const test = harness();
    const branch = [{
      type: "message",
      id: "assistant-entry",
      parentId: null,
      timestamp: new Date().toISOString(),
      message: {
        role: "assistant",
        content: [
          { type: "toolCall", id: "confirm", name: CONFIRMATION_TOOL_NAME, arguments: {} },
          { type: "toolCall", id: "edit", name: "edit", arguments: {} },
        ],
        stopReason: "toolUse",
        timestamp: 1,
      },
    }] as unknown as SessionEntry[];
    const context = contextWithBranch(branch);

    expect(test.toolCallHandler({ toolName: CONFIRMATION_TOOL_NAME }, context)).toBeUndefined();
    expect(test.toolCallHandler({ toolName: "edit" }, context)).toMatchObject({
      block: true,
      terminate: true,
    });
  });
});
