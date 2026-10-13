import { join } from "node:path";
import { app, BrowserWindow, dialog, screen, shell } from "electron";
import { ProjectSessionService } from "./agent/project-session-service.js";
import { AgentService } from "./agent/agent-service.js";
import { AppConfigService } from "./app-config/app-config-service.js";
import { registerIpc } from "./ipc/register-ipc.js";
import { SettingsService } from "./settings/settings-service.js";
import { cleanupSubagentHistory } from "./history/subagent-history-cleanup.js";
import { IPC_CHANNELS } from "../shared/contracts.js";

const APP_ID = "com.piecode.desktop";
const IS_BRANDED_DEVELOPMENT_RUNTIME = process.env.PI_ECODE_DEVELOPMENT_RUNTIME === "1";
if (process.platform === "win32" && !IS_BRANDED_DEVELOPMENT_RUNTIME) app.setAppUserModelId(APP_ID);

const service = new AgentService(
  (url) => shell.openExternal(url),
  (path) => shell.trashItem(path),
);
const projectSessions = new ProjectSessionService({
  root: service,
  createService: () => new AgentService((url) => shell.openExternal(url), (path) => shell.trashItem(path), { allowSelfUpdate: false }),
});
const settings = new SettingsService({
  agentDir: service.agentDirectory,
  getProjectPath: () => service.activeProjectPath,
  getProviderStatuses: () => projectSessions.activeService.getProviderStatuses(),
  isFffLoaded: () => projectSessions.activeService.fffExtensionLoaded,
  isProjectTrusted: () => service.projectSettingsTrusted,
  isRuntimeBusy: () => projectSessions.runtimeBusy,
  applyRuntimeChanges: () => projectSessions.reloadRuntimeConfiguration(),
  onChanged: (snapshot, source) => {
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) window.webContents.send(IPC_CHANNELS.settingsEvent, { type: "settings-changed", snapshot, source });
    }
  },
  onError: (message) => service.reportError(message),
});
const appConfig = new AppConfigService({
  onChanged: (event) => {
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) window.webContents.send(IPC_CHANNELS.appConfigEvent, event);
    }
  },
  onError: (message) => service.reportError(message),
});
const hasSingleInstanceLock = app.requestSingleInstanceLock();
let unregisterIpc: (() => void) | undefined;
let unsubscribeAgent: (() => void) | undefined;
let unregisterAuth: (() => void) | undefined;
let unsubscribeAuth: (() => void) | undefined;
let shutdown: Promise<void> | undefined;
let cleanupComplete = false;

function focusMainWindow(): void {
  const window = BrowserWindow.getAllWindows()[0];
  if (!window) return;
  if (window.isMinimized()) window.restore();
  window.show();
  window.focus();
}

function createWindow(): void {
  const iconFileName = process.platform === "win32" ? "ecode-icon.ico" : "ecode-icon.png";
  // 窗口/任务栏图标固定为 PiECode 品牌图标（打包资源），不可配置。
  // Windows 任务栏图标在打包态无法通过运行时 setIcon 可靠变更，属平台固有限制。
  // 品牌开发可执行文件也会使 isPackaged 为 true，但图标仍位于项目资源目录。
  const isPackagedRuntime = app.isPackaged && !IS_BRANDED_DEVELOPMENT_RUNTIME;
  const iconPath = isPackagedRuntime
    ? join(process.resourcesPath, iconFileName)
    : join(app.getAppPath(), "resources", iconFileName);
  const primaryWorkArea = screen.getPrimaryDisplay().workArea;
  const initialWidth = Math.min(1440, primaryWorkArea.width);
  const window = new BrowserWindow({
    width: initialWidth,
    height: primaryWorkArea.height,
    y: primaryWorkArea.y,
    minWidth: 820,
    minHeight: 560,
    title: "PiECode",
    icon: iconPath,
    backgroundColor: "#f7f7f5",
    show: false,
    paintWhenInitiallyHidden: false,
    autoHideMenuBar: true,
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "default",
    webPreferences: {
      preload: join(__dirname, "../preload/index.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  window.on("close", (event) => {
    if (process.platform === "darwin" || cleanupComplete) return;
    // 保留窗口直到清理成功，失败消息仍可显示，用户也能再次关闭重试。
    event.preventDefault();
    app.quit();
  });
  window.setMenuBarVisibility(false);
  // The branded development executable already embeds the icon; an unregistered AppUserModelID makes Windows fall back to a generic taskbar icon.
  if (process.platform === "win32" && !IS_BRANDED_DEVELOPMENT_RUNTIME) {
    window.setAppDetails({ appId: APP_ID, appIconPath: iconPath, appIconIndex: 0 });
  }
  window.webContents.once("did-finish-load", () => {
    window.show();
    // Hand keyboard focus to the renderer after showing the initially hidden window.
    window.focus();
    window.webContents.focus();
  });
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("https://") || url.startsWith("http://")) void shell.openExternal(url);
    return { action: "deny" };
  });

  if (process.env.ELECTRON_RENDERER_URL) {
    void window.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    void window.loadFile(join(__dirname, "../renderer/index.html"));
  }
}

if (!hasSingleInstanceLock) {
  app.quit();
} else {
  app.on("second-instance", () => focusMainWindow());

  void app.whenReady().then(async () => {
    // Run before SessionManager loads anything, so no active runtime can rewrite cleaned history from memory.
    const cleanup = await cleanupSubagentHistory({
      agentDir: service.agentDirectory,
      catalogDirectory: join(app.getPath("userData"), "agents"),
    });
    if (cleanup.failures.length) {
      dialog.showErrorBox("子代理历史清理未完成", cleanup.failures.map((failure) => `${failure.path}\n${failure.message}`).join("\n\n"));
    }
    await service.initialize();
    await projectSessions.initialize();
    await settings.start();
    await appConfig.load();
    unsubscribeAgent = projectSessions.subscribe((event) => {
      if (!shutdown && ((event.type === "state" && event.patch.isStreaming === false)
        || (event.type === "parallel" && event.parallel.runningCount === 0)
        || (event.type === "snapshot" && event.snapshot.parallel?.runningCount === 0))) void settings.applyPendingIfIdle();
    });
    unregisterAuth = projectSessions.subscribeAuth((event) => {
      for (const window of BrowserWindow.getAllWindows()) {
        if (!window.isDestroyed()) window.webContents.send(IPC_CHANNELS.settingsEvent, event);
      }
    });
    unregisterIpc = registerIpc(projectSessions, settings, appConfig);
    createWindow();
    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
      else focusMainWindow();
    });
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });

  app.on("before-quit", (event) => {
    if (cleanupComplete) return;
    event.preventDefault();
    if (shutdown) return;
    // 重入退出必须等待同一次清理；失败保留 IPC/订阅用于报告与再次尝试。
    shutdown = (async () => {
      const results = await Promise.allSettled([
        Promise.resolve().then(() => settings.dispose()),
        Promise.resolve().then(() => projectSessions.dispose()),
      ]);
      const failures = results.filter((result): result is PromiseRejectedResult => result.status === "rejected");
      if (failures.length) throw new AggregateError(failures.map((failure) => failure.reason), "退出清理失败");
      unregisterIpc?.();
      unsubscribeAgent?.();
      unsubscribeAuth?.();
      cleanupComplete = true;
      app.quit();
    })().catch((error: unknown) => {
      const reasons = error instanceof AggregateError ? error.errors : [error];
      service.reportError(`退出清理失败，请重试退出：${reasons.map((reason: unknown) => reason instanceof Error ? reason.message : String(reason)).join("；")}`);
    }).finally(() => { shutdown = undefined; });
  });
}
