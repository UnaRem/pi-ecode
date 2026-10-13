import { beforeEach, describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => ({
  listeners: new Map<string, (event: { preventDefault: () => void }) => void>(),
  hasLock: true,
  ready: false,
  windows: [] as { listeners: Map<string, (event: { preventDefault: () => void }) => void>; visible: boolean; destroyed: boolean }[],
  unregisterIpc: vi.fn(),
  settingsDispose: vi.fn<() => Promise<void>>(),
  serviceDispose: vi.fn<() => Promise<void>>(),
  reportError: vi.fn(),
  quit: vi.fn(),
}));

vi.mock("electron", () => ({
  app: {
    setAppUserModelId: vi.fn(),
    getPath: () => "test-user-data",
    requestSingleInstanceLock: () => harness.hasLock,
    // 窗口用例放行实际 createWindow；其余用例只执行退出门。
    whenReady: () => harness.ready ? Promise.resolve() : new Promise<void>(() => undefined),
    getAppPath: () => "test-app",
    on: (name: string, listener: (event: { preventDefault: () => void }) => void) => harness.listeners.set(name, listener),
    quit: harness.quit,
  },
  BrowserWindow: class {
    static getAllWindows() { return harness.windows.filter((window) => !window.destroyed); }
    listeners = new Map<string, (event: { preventDefault: () => void }) => void>();
    visible = false;
    destroyed = false;
    webContents = {
      once: (_name: string, callback: () => void) => callback(),
      focus: vi.fn(),
      setWindowOpenHandler: vi.fn(),
      send: vi.fn(),
    };
    constructor() { harness.windows.push(this); }
    on(name: string, listener: (event: { preventDefault: () => void }) => void) { this.listeners.set(name, listener); }
    show() { this.visible = true; }
    focus() {}
    isDestroyed() { return this.destroyed; }
    setMenuBarVisibility() {}
    setAppDetails() {}
    loadFile() { return Promise.resolve(); }
    loadURL() { return Promise.resolve(); }
  },
  screen: { getPrimaryDisplay: () => ({ workArea: { width: 1100, height: 720, y: 0 } }) },
  shell: {},
}));
vi.mock("./agent/agent-service.js", async () => {
  const { EMPTY_AGENT_SNAPSHOT } = await import("./agent/empty-agent-snapshot.js");
  return { AgentService: class {
    agentDirectory = "test-agents";
    initialize() { return Promise.resolve(); }
    getSnapshot() { return Promise.resolve({ ...EMPTY_AGENT_SNAPSHOT }); }
    subscribe() { return () => undefined; }
    subscribeAuth() { return () => undefined; }
    dispose = harness.serviceDispose;
    reportError = harness.reportError;
  } };
});
vi.mock("./settings/settings-service.js", () => ({
  SettingsService: class {
    start() { return Promise.resolve(); }
    dispose = harness.settingsDispose;
  },
}));
vi.mock("./app-config/app-config-service.js", () => ({ AppConfigService: class { load() { return Promise.resolve(); } } }));
vi.mock("./ipc/register-ipc.js", () => ({ registerIpc: () => harness.unregisterIpc }));

function deferred() {
  let resolve = (): void => undefined;
  let reject = (_error: Error): void => undefined;
  const promise = new Promise<void>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function beforeQuit() {
  const event = { preventDefault: vi.fn() };
  harness.listeners.get("before-quit")?.(event);
  return event;
}

function closeWindow() {
  const window = harness.windows[0]!;
  const event = { preventDefault: vi.fn() };
  window.listeners.get("close")?.(event);
  if (!event.preventDefault.mock.calls.length) {
    window.destroyed = true;
    window.visible = false;
  }
  return event;
}

async function openWindow() {
  harness.ready = true;
  harness.quit.mockImplementation(() => {
    // 模拟 Electron 的退出顺序：before-quit 放行后才关闭窗口。
    if (!beforeQuit().preventDefault.mock.calls.length) closeWindow();
  });
  await import("./index.js");
  await vi.waitFor(() => expect(harness.windows).toHaveLength(1));
  expect(harness.windows[0]?.visible).toBe(true);
}

beforeEach(() => {
  vi.resetModules();
  harness.listeners.clear();
  harness.hasLock = true;
  harness.ready = false;
  harness.windows.length = 0;
  harness.unregisterIpc.mockReset();
  harness.settingsDispose.mockReset().mockResolvedValue(undefined);
  harness.serviceDispose.mockReset().mockResolvedValue(undefined);
  harness.reportError.mockReset();
  harness.quit.mockReset();
});

describe("应用退出清理门", () => {
  it("等待两项真实清理 Promise，重复退出不并发，成功后放行再次 quit", async () => {
    const settings = deferred();
    const service = deferred();
    harness.settingsDispose.mockReturnValue(settings.promise);
    harness.serviceDispose.mockReturnValue(service.promise);
    let finalEvent: ReturnType<typeof beforeQuit> | undefined;
    harness.quit.mockImplementation(() => { finalEvent = beforeQuit(); });
    await import("./index.js");
    expect(beforeQuit().preventDefault).toHaveBeenCalledOnce();
    expect(beforeQuit().preventDefault).toHaveBeenCalledOnce();
    await vi.waitFor(() => expect(harness.serviceDispose).toHaveBeenCalledOnce());
    settings.resolve();
    await Promise.resolve();
    expect(harness.quit).not.toHaveBeenCalled();
    expect(beforeQuit().preventDefault).toHaveBeenCalledOnce();
    service.resolve();
    await vi.waitFor(() => expect(harness.quit).toHaveBeenCalledOnce());
    expect(harness.settingsDispose).toHaveBeenCalledOnce();
    expect(harness.serviceDispose).toHaveBeenCalledOnce();
    expect(finalEvent?.preventDefault).not.toHaveBeenCalled();
    expect(harness.reportError).not.toHaveBeenCalled();
  });

  it.each(["settings", "service"] as const)("%s 清理失败也等待另一项，报告错误并允许重试", async (failed) => {
    const settings = deferred();
    const service = deferred();
    harness.settingsDispose.mockReturnValueOnce(settings.promise);
    harness.serviceDispose.mockReturnValueOnce(service.promise);
    await import("./index.js");
    beforeQuit();
    await vi.waitFor(() => expect(harness.serviceDispose).toHaveBeenCalledOnce());
    const failing = failed === "settings" ? settings : service;
    const pending = failed === "settings" ? service : settings;
    failing.reject(new Error("可恢复清理错误"));
    await Promise.resolve();
    expect(harness.reportError).not.toHaveBeenCalled();
    expect(harness.quit).not.toHaveBeenCalled();
    beforeQuit();
    expect(harness.serviceDispose).toHaveBeenCalledOnce();
    pending.resolve();
    await vi.waitFor(() => expect(harness.reportError).toHaveBeenCalledWith(expect.stringContaining("可恢复清理错误")));
    expect(harness.quit).not.toHaveBeenCalled();
    expect(beforeQuit().preventDefault).toHaveBeenCalledOnce();
    await vi.waitFor(() => expect(harness.quit).toHaveBeenCalledOnce());
    expect(harness.settingsDispose).toHaveBeenCalledTimes(2);
    expect(harness.serviceDispose).toHaveBeenCalledTimes(2);
  });

  it.skipIf(process.platform === "darwin")("实际 createWindow 首次 close 阻止，清理期间重复 close 不并发，成功后放行", async () => {
    const settings = deferred();
    const service = deferred();
    harness.settingsDispose.mockReturnValue(settings.promise);
    harness.serviceDispose.mockReturnValue(service.promise);
    await openWindow();
    expect(closeWindow().preventDefault).toHaveBeenCalledOnce();
    expect(closeWindow().preventDefault).toHaveBeenCalledOnce();
    await vi.waitFor(() => expect(harness.serviceDispose).toHaveBeenCalledOnce());
    expect(harness.settingsDispose).toHaveBeenCalledOnce();
    expect(harness.windows[0]).toMatchObject({ visible: true, destroyed: false });
    expect(harness.unregisterIpc).not.toHaveBeenCalled();
    settings.resolve();
    await Promise.resolve();
    expect(closeWindow().preventDefault).toHaveBeenCalledOnce();
    expect(harness.serviceDispose).toHaveBeenCalledOnce();
    service.resolve();
    await vi.waitFor(() => expect(harness.windows[0]?.destroyed).toBe(true));
    expect(harness.unregisterIpc).toHaveBeenCalledOnce();
    expect(closeWindow().preventDefault).not.toHaveBeenCalled();
    expect(harness.reportError).not.toHaveBeenCalled();
  });

  it.skipIf(process.platform === "darwin")("实际窗口 close 清理失败保留可见窗口及 IPC，再次关闭可重试成功", async () => {
    const failed = deferred();
    harness.serviceDispose.mockReturnValueOnce(failed.promise);
    await openWindow();
    expect(closeWindow().preventDefault).toHaveBeenCalledOnce();
    await vi.waitFor(() => expect(harness.serviceDispose).toHaveBeenCalledOnce());
    failed.reject(new Error("托管进程停止失败"));
    await vi.waitFor(() => expect(harness.reportError).toHaveBeenCalledWith(expect.stringContaining("托管进程停止失败")));
    expect(harness.windows[0]).toMatchObject({ visible: true, destroyed: false });
    expect(harness.unregisterIpc).not.toHaveBeenCalled();
    expect(harness.quit).toHaveBeenCalledOnce();
    expect(closeWindow().preventDefault).toHaveBeenCalledOnce();
    await vi.waitFor(() => expect(harness.windows[0]?.destroyed).toBe(true));
    expect(harness.serviceDispose).toHaveBeenCalledTimes(2);
    expect(harness.settingsDispose).toHaveBeenCalledTimes(2);
    expect(harness.unregisterIpc).toHaveBeenCalledOnce();
    expect(closeWindow().preventDefault).not.toHaveBeenCalled();
  });

  it("无单实例锁仍直接退出，不注册异步退出门", async () => {
    harness.hasLock = false;
    await import("./index.js");
    expect(harness.quit).toHaveBeenCalledOnce();
    expect(harness.listeners.has("before-quit")).toBe(false);
    expect(harness.serviceDispose).not.toHaveBeenCalled();
    expect(harness.settingsDispose).not.toHaveBeenCalled();
  });
});
