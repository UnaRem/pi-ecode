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
}));
vi.mock("electron", () => ({
  BrowserWindow: { getAllWindows: () => [] },
  Notification: {},
  dialog: {},
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
});

function register(stopManagedProcess = vi.fn().mockResolvedValue(undefined)) {
  const unsubscribe = vi.fn();
  const service = { stopManagedProcess, subscribe: () => unsubscribe } as unknown as AgentService;
  const unregister = registerIpc(service, {} as SettingsService, {} as AppConfigService);
  const stop = (input: unknown) => harness.handlers.get(IPC_CHANNELS.stopManagedProcess)!(undefined, input);
  return { stopManagedProcess, stop, unregister, unsubscribe };
}

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
