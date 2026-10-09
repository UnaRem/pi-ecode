import { describe, expect, it, vi } from "vitest";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { ManagedProcess } from "../../shared/process-contracts.js";
import { ManagedProcessToolService } from "./managed-process-tool.js";

function harness() {
  let tool: ToolDefinition | undefined;
  const record: ManagedProcess = { id: "registered", projectPath: "C:/project", sessionId: "session", originToolCallId: "call",
    command: "bun run dev", status: "running", pid: 123, startedAt: 1, endedAt: null, exitCode: null,
    signal: null, output: "", outputTruncated: false, errorMessage: null };
  const start = vi.fn(async () => record);
  const stop = vi.fn(async () => undefined);
  const isCurrent = vi.fn(() => true);
  const service = new ManagedProcessToolService({ start, stop, isCurrent });
  const extension = service.asExtension();
  const pi = { registerTool: (definition: ToolDefinition) => { tool = definition; } } as unknown as ExtensionAPI;
  void (typeof extension === "function" ? extension(pi) : extension.factory(pi));
  const ctx = { cwd: "C:/project", sessionManager: { getSessionId: () => "session" } } as unknown as ExtensionContext;
  return { start, stop, isCurrent, record, execute: (command = "bun run dev", signal?: AbortSignal) => {
    if (!tool) throw new Error("未注册工具。");
    return tool.execute("call", { command }, signal, undefined, ctx);
  } };
}

describe("ManagedProcessToolService", () => {
  it("injects project, session and call identity and distinguishes spawn from readiness", async () => {
    const test = harness();
    test.record.output = "服务初始化日志";
    const result = await test.execute();
    expect(test.start).toHaveBeenCalledWith({ command: "bun run dev", projectPath: "C:/project", sessionId: "session", originToolCallId: "call" });
    expect(result.details).toEqual(test.record);
    expect(result.content).toContainEqual(expect.objectContaining({ text: expect.stringContaining("不代表服务已就绪") }));
    const text = result.content.find((block) => block.type === "text");
    if (text?.type !== "text") throw new Error("启动结果缺少文本。");
    expect(text.text).toContain("ID：registered");
    expect(text.text).toContain("PID：123");
    expect(text.text).toContain("命令：bun run dev");
    expect(text.text).toContain("服务初始化日志");
  });
  it("bounds startup output to its latest 8000 characters", async () => {
    const test = harness();
    test.record.output = "discarded-prefix" + "x".repeat(8_000);
    const result = await test.execute();
    const text = result.content.find((block) => block.type === "text");
    if (text?.type !== "text") throw new Error("启动结果缺少文本。");
    expect(text.text).not.toContain("discarded-prefix");
    expect(text.text).toContain("x".repeat(8_000));
  });
  it.each(["", "  ", "x\0y", "x".repeat(16_001)])("rejects invalid command boundaries", async (command) => {
    const test = harness();
    await expect(test.execute(command)).rejects.toThrow("Invalid managed process command");
    expect(test.start).not.toHaveBeenCalled();
  });
  it("rejects stale context and cancellation before startup", async () => {
    const test = harness();
    test.isCurrent.mockReturnValue(false);
    await expect(test.execute()).rejects.toThrow("active project session");
    const controller = new AbortController();
    controller.abort();
    await expect(test.execute("bun run dev", controller.signal)).rejects.toThrow();
    expect(test.start).not.toHaveBeenCalled();
  });
  it("stops the registered id when cancelled during startup", async () => {
    const test = harness();
    const controller = new AbortController();
    test.start.mockImplementation(async () => { controller.abort(); return test.record; });
    await expect(test.execute("bun run dev", controller.signal)).rejects.toThrow();
    expect(test.stop).toHaveBeenCalledWith("registered");
  });
  it("stops startup results if the session changed", async () => {
    const test = harness();
    test.isCurrent.mockReturnValueOnce(true).mockReturnValue(false);
    await expect(test.execute()).rejects.toThrow("changed during startup");
    expect(test.stop).toHaveBeenCalledWith("registered");
  });
});
