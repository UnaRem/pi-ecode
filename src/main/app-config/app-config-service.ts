import { createHash, randomUUID } from "node:crypto";
import { copyFile, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { app, BrowserWindow, dialog } from "electron";
import { dirname, extname, join, resolve } from "node:path";
import type { AppConfigChangedEvent, AppConfigSnapshot } from "../../shared/app-config-contracts.js";

interface AppConfigServiceOptions {
  onChanged: (event: AppConfigChangedEvent) => void;
  onError: (message: string) => void;
}

interface AppConfigFile {
  iconPath: string | null;
}

function revision(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

/**
 * pi-ecode 自身应用级配置服务。
 * 与 pi agent 的 settings.json 解耦：管理窗口/UI 图标路径等应用外观偏好。
 * 持久化到 userData/app-config.json，图标文件复制到 userData/icons/ 下。
 */
export class AppConfigService {
  private cached: AppConfigSnapshot | null = null;

  constructor(private readonly options: AppConfigServiceOptions) {}

  get configFilePath(): string {
    return join(app.getPath("userData"), "app-config.json");
  }

  get iconsDir(): string {
    return join(app.getPath("userData"), "icons");
  }

  /**
   * 解析图标为可用于窗口 setIcon 的本地文件绝对路径；未配置时返回默认打包图标路径。
   * 在 app ready 之后调用；打包态从 resourcesPath 取，开发态从 appPath/resources 取。
   */
  resolveIconFilePath(): string | null {
    const configured = this.cached?.iconPath ?? null;
    if (configured) return resolve(app.getPath("userData"), configured);
    const fileName = process.platform === "win32" ? "ecode-icon.ico" : "ecode-icon.png";
    return app.isPackaged
      ? join(process.resourcesPath, fileName)
      : join(app.getAppPath(), "resources", fileName);
  }

  /** 渲染层可消费的图标 URL（带缓存破坏）；null 表示用默认 ./ecode-icon.png。 */
  private toSnapshot(value: AppConfigFile): AppConfigSnapshot {
    const snapshot: AppConfigSnapshot = {
      iconPath: value.iconPath ?? null,
      iconUrl: null,
    };
    if (value.iconPath) {
      // 加版本哈希作为查询参数，避免渲染层缓存旧图标。
      const absolute = resolve(app.getPath("userData"), value.iconPath);
      snapshot.iconUrl = `file:///${absolute.replace(/\\/g, "/")}?v=${revision(value.iconPath).slice(0, 8)}`;
    }
    return snapshot;
  }

  private async writeAtomic(path: string, content: string): Promise<void> {
    await mkdir(dirname(path), { recursive: true });
    const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporaryPath, content, { encoding: "utf8", mode: 0o600 });
      await rename(temporaryPath, path);
    } finally {
      await rm(temporaryPath, { force: true });
    }
  }

  private async readConfig(): Promise<AppConfigFile> {
    try {
      const content = await readFile(this.configFilePath, "utf8");
      const parsed: unknown = JSON.parse(content);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { iconPath: null };
      const candidate = parsed as Partial<AppConfigFile>;
      return { iconPath: typeof candidate.iconPath === "string" ? candidate.iconPath : null };
    } catch (error) {
      const code = error && typeof error === "object" && "code" in error ? (error as NodeJS.ErrnoException).code : undefined;
      if (code === "ENOENT") return { iconPath: null };
      throw error;
    }
  }

  private async writeConfig(value: AppConfigFile): Promise<void> {
    await this.writeAtomic(this.configFilePath, `${JSON.stringify(value, null, 2)}\n`);
  }

  private emit(snapshot: AppConfigSnapshot): void {
    this.cached = snapshot;
    this.options.onChanged({ type: "app-config-changed", snapshot });
  }

  async load(): Promise<AppConfigSnapshot> {
    const value = await this.readConfig();
    const snapshot = this.toSnapshot(value);
    this.cached = snapshot;
    return snapshot;
  }

  async getSnapshot(): Promise<AppConfigSnapshot> {
    if (this.cached) return this.cached;
    return this.load();
  }

  /**
   * 弹出文件选择器，让用户选一个 .ico/.png，复制到 userData/icons/ 下，写入配置，
   * 然后对所有窗口热更新 setIcon 并广播事件。
   */
  async chooseIcon(): Promise<AppConfigSnapshot> {
    const owner = BrowserWindow.getFocusedWindow() ?? undefined;
    const extensions = process.platform === "win32" ? ["ico", "png"] : ["png", "ico"];
    const result = owner
      ? await dialog.showOpenDialog(owner, {
          title: "选择应用图标",
          filters: [{ name: "图标", extensions }],
          properties: ["openFile"],
        })
      : await dialog.showOpenDialog({
          title: "选择应用图标",
          filters: [{ name: "图标", extensions }],
          properties: ["openFile"],
        });
    if (result.canceled || !result.filePaths[0]) return this.getSnapshot();

    const source = result.filePaths[0];
    const ext = extname(source).toLowerCase() || ".png";
    const destName = `app-icon-${revision(source).slice(0, 12)}${ext}`;
    await mkdir(this.iconsDir, { recursive: true });
    const dest = join(this.iconsDir, destName);
    await copyFile(source, dest);

    const config = await this.readConfig();
    const oldValue = config.iconPath;
    config.iconPath = `icons/${destName}`;
    await this.writeConfig(config);

    // 清理上一个自定义图标文件（默认图标不删）。
    if (oldValue && oldValue !== config.iconPath) {
      const oldAbs = resolve(app.getPath("userData"), oldValue);
      if (oldAbs.startsWith(this.iconsDir)) await rm(oldAbs, { force: true });
    }

    const snapshot = this.toSnapshot(config);
    this.emit(snapshot);
    this.applyToAllWindows();
    return snapshot;
  }

  async clearIcon(): Promise<AppConfigSnapshot> {
    const config = await this.readConfig();
    const oldValue = config.iconPath;
    config.iconPath = null;
    await this.writeConfig(config);

    if (oldValue) {
      const oldAbs = resolve(app.getPath("userData"), oldValue);
      if (oldAbs.startsWith(this.iconsDir)) await rm(oldAbs, { force: true });
    }

    const snapshot = this.toSnapshot(config);
    this.emit(snapshot);
    this.applyToAllWindows();
    return snapshot;
  }

  /** 启动时对已存在的窗口应用当前图标（供 index.ts 在 createWindow 后调用）。 */
  applyToAllWindows(): void {
    const iconPath = this.resolveIconFilePath();
    if (!iconPath) return;
    for (const window of BrowserWindow.getAllWindows()) {
      if (window.isDestroyed()) continue;
      try {
        window.setIcon(iconPath);
        if (process.platform === "win32") {
          window.setAppDetails({ appId: "com.piecode.desktop", appIconPath: iconPath, appIconIndex: 0 });
        }
      } catch {
        // 某些平台窗口销毁竞态下会抛错，忽略不影响主流程。
      }
    }
  }
}
