import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentService } from "../agent/agent-service.js";
import type { AppConfigService } from "../app-config/app-config-service.js";
import type { SettingsService } from "../settings/settings-service.js";
import type { DesktopApi } from "../../shared/contracts.js";
import { IPC_CHANNELS } from "../../shared/contracts.js";
import { registerIpc } from "./register-ipc.js";

const harness = vi.hoisted(() => ({
  handlers: new Map<string, (_event: unknown, input: unknown) => unknown>(),
  removeHandler: vi.fn(),
  invoke: vi.fn(),
  expose: vi.fn(),
  showMessageBox: vi.fn(),
  focus: vi.fn(),
  isFocused: vi.fn(),
  isDestroyed: vi.fn(),
  fromWebContents: vi.fn(),
}));
vi.mock("electron", () => ({
  BrowserWindow: { getAllWindows: () => [], fromWebContents: harness.fromWebContents },
  Notification: {},
  dialog: { showMessageBox: harness.showMessageBox },
  ipcMain: {
    handle: (channel: string, handler: (_event: unknown, input: unknown) => unknown) => harness.handlers.set(channel, handler),
    removeHandler: harness.removeHandler,
  },
  contextBridge: { exposeInMainWorld: harness.expose },
  ipcRenderer: { invoke: harness.invoke },
}));

beforeEach(() => {
  harness.handlers.clear();
  harness.removeHandler.mockReset();
  harness.invoke.mockReset().mockResolvedValue(undefined);
  harness.expose.mockReset();
  harness.showMessageBox.mockReset().mockResolvedValue({ response: 1 });
  harness.focus.mockReset();
  harness.isFocused.mockReset().mockReturnValue(true);
  harness.isDestroyed.mockReset().mockReturnValue(false);
  harness.fromWebContents.mockReset().mockReturnValue({
    isDestroyed: harness.isDestroyed, isFocused: harness.isFocused, webContents: { focus: harness.focus },
  });
});

function register(stopManagedProcess = vi.fn().mockResolvedValue(undefined)) {
  const unsubscribe = vi.fn();
  const service = { stopManagedProcess, subscribe: () => unsubscribe } as unknown as AgentService;
  const unregister = registerIpc(service, {} as SettingsService, {} as AppConfigService);
  const stop = (input: unknown) => harness.handlers.get(IPC_CHANNELS.stopManagedProcess)!(undefined, input);
  return { stopManagedProcess, stop, unregister, unsubscribe };
}

describe("所属窗口确认框", () => {
  const request = { message: "恢复文件？", confirmLabel: "确认", cancelLabel: "取消" };
  function confirm(input: unknown) {
    register();
    return harness.handlers.get(IPC_CHANNELS.showConfirmation)!({ sender: {} }, input);
  }
  it.each([null, {}, { ...request, message: "" }, { ...request, message: "x".repeat(2_001) }, { ...request, cancelLabel: 12 }])("拒绝越界请求 %j", async (input) => {
    await expect(confirm(input)).rejects.toThrow("Invalid confirmation");
    expect(harness.showMessageBox).not.toHaveBeenCalled();
  });
  it("使用默认取消并在所属窗口仍活跃时恢复键盘焦点", async () => {
    await expect(confirm(request)).resolves.toBe(true);
    expect(harness.showMessageBox).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      buttons: ["取消", "确认"], defaultId: 0, cancelId: 0,
    }));
    expect(harness.focus).toHaveBeenCalledOnce();
    harness.isFocused.mockReturnValue(false);
    harness.showMessageBox.mockResolvedValue({ response: 0 });
    await expect(confirm(request)).resolves.toBe(false);
    expect(harness.focus).toHaveBeenCalledOnce();
  });
});

describe("托管进程窄停止接口", () => {
  it.each([undefined, null, 123, {}, { pid: 123 }, { command: "taskkill" }, [], "", " \t\n", "x".repeat(201)])("拒绝无效输入 %j 且不调用 service", (input) => {
    const test = register();
    try {
      expect(() => test.stop(input)).toThrow("托管进程 ID 无效");
      expect(test.stopManagedProcess).not.toHaveBeenCalled();
    } finally { test.unregister(); }
  });

  it("最多 200 字符的 ID 原样交给主 service 做登记/项目校验并传播失败", async () => {
    const stopManagedProcess = vi.fn().mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error("当前项目无此登记 ID"));
    const test = register(stopManagedProcess);
    try {
      await expect(test.stop("x".repeat(200))).resolves.toBeUndefined();
      expect(stopManagedProcess).toHaveBeenNthCalledWith(1, "x".repeat(200));
      await expect(test.stop("old-project-id")).rejects.toThrow("当前项目无此登记 ID");
      expect(stopManagedProcess).toHaveBeenNthCalledWith(2, "old-project-id");
    } finally { test.unregister(); }
    expect(test.unsubscribe).toHaveBeenCalledOnce();
    expect(harness.removeHandler).toHaveBeenCalledWith("process:stop");
  });

  it("preload 暴露类型化方法，仅 invoke 停止 channel 与 ID", async () => {
    await import("../../preload/index.js");
    const api = harness.expose.mock.calls[0]?.[1] as DesktopApi;
    expect(harness.expose.mock.calls[0]?.[0]).toBe("piDesktop");
    await expect(api.stopManagedProcess("registered-id")).resolves.toBeUndefined();
    expect(harness.invoke).toHaveBeenCalledExactlyOnceWith("process:stop", "registered-id");
  });
});
