import { join } from "node:path";
import { app, BrowserWindow, shell } from "electron";
import { AgentService } from "./agent/agent-service.js";
import { registerIpc } from "./ipc/register-ipc.js";
import { SettingsService } from "./settings/settings-service.js";
import { IPC_CHANNELS } from "../shared/contracts.js";

if (process.platform === "win32") app.setAppUserModelId("com.pi-ecode.desktop");

const service = new AgentService((url) => shell.openExternal(url));
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
const hasSingleInstanceLock = app.requestSingleInstanceLock();
let unregisterIpc: (() => void) | undefined;
let unsubscribeAgent: (() => void) | undefined;
let unsubscribeAuth: (() => void) | undefined;

function focusMainWindow(): void {
  const window = BrowserWindow.getAllWindows()[0];
  if (!window) return;
  if (window.isMinimized()) window.restore();
  window.show();
  window.focus();
}

function createWindow(): void {
  const window = new BrowserWindow({
    width: 1180,
    height: 780,
    minWidth: 820,
    minHeight: 560,
    title: "PiECode",
    icon: join(app.getAppPath(), "resources", "ecode-icon.png"),
    backgroundColor: "#f7f7f5",
    show: false,
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
  window.once("ready-to-show", () => window.show());
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
    unsubscribeAgent = service.subscribe((event) => {
      if (event.type === "state" && event.patch.isStreaming === false) void settings.applyPendingIfIdle();
    });
    unsubscribeAuth = service.subscribeAuth((event) => {
      for (const window of BrowserWindow.getAllWindows()) {
        if (!window.isDestroyed()) window.webContents.send(IPC_CHANNELS.settingsEvent, event);
      }
    });
    unregisterIpc = registerIpc(service, settings);
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
