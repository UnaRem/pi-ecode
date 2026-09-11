import { join } from "node:path";
import { app, BrowserWindow, screen, shell } from "electron";
import { AgentService } from "./agent/agent-service.js";
import { AppConfigService } from "./app-config/app-config-service.js";
import { registerIpc } from "./ipc/register-ipc.js";
import { SettingsService } from "./settings/settings-service.js";
import { IPC_CHANNELS } from "../shared/contracts.js";

const APP_ID = "com.piecode.desktop";
if (process.platform === "win32") app.setAppUserModelId(APP_ID);

const service = new AgentService(
  (url) => shell.openExternal(url),
  (path) => shell.trashItem(path),
);
const settings = new SettingsService({
  agentDir: service.agentDirectory,
  getProjectPath: () => service.activeProjectPath,
  getProviderStatuses: () => service.getProviderStatuses(),
  isFffLoaded: () => service.fffExtensionLoaded,
  isProjectTrusted: () => service.projectSettingsTrusted,
  isRuntimeBusy: () => service.runtimeBusy,
  applyRuntimeChanges: () => service.reloadRuntimeConfiguration(),
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

function focusMainWindow(): void {
  const window = BrowserWindow.getAllWindows()[0];
  if (!window) return;
  if (window.isMinimized()) window.restore();
  window.show();
  window.focus();
}

function createWindow(): void {
  const iconFileName = process.platform === "win32" ? "ecode-icon.ico" : "ecode-icon.png";
  const fallbackIconPath = app.isPackaged
    ? join(process.resourcesPath, iconFileName)
    : join(app.getAppPath(), "resources", iconFileName);
  // 优先使用用户自定义图标，未配置时回退默认打包图标。
  const iconPath = appConfig.resolveIconFilePath() ?? fallbackIconPath;
  const initialWidth = Math.min(1440, screen.getPrimaryDisplay().workAreaSize.width);
  const window = new BrowserWindow({
    width: initialWidth,
    height: 780,
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

  window.setMenuBarVisibility(false);
  if (process.platform === "win32") window.setAppDetails({ appId: APP_ID, appIconPath: iconPath, appIconIndex: 0 });
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
    await service.initialize();
    await settings.start();
    await appConfig.load();
    unsubscribeAgent = service.subscribe((event) => {
      if (event.type === "state" && event.patch.isStreaming === false) void settings.applyPendingIfIdle();
    });
    unregisterAuth = service.subscribeAuth((event) => {
      for (const window of BrowserWindow.getAllWindows()) {
        if (!window.isDestroyed()) window.webContents.send(IPC_CHANNELS.settingsEvent, event);
      }
    });
    unregisterIpc = registerIpc(service, settings, appConfig);
    createWindow();
    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
      else focusMainWindow();
    });
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });

  app.on("before-quit", () => {
    unregisterIpc?.();
    unsubscribeAgent?.();
    unsubscribeAuth?.();
    void settings.dispose();
    void service.dispose();
  });
}
