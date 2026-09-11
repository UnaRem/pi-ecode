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
 * pi-ecode 应用级配置服务：仅管理 UI 内 logo（选择项目按钮图标、启动屏图标）的自定义路径。
 * 不触碰 Electron 窗口/任务栏图标——后者由打包资源固定为 PiECode 品牌图标
 * （Windows 任务栏图标在打包态无法通过运行时 setIcon 可靠变更，属平台固有限制）。
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
   * 然后广播事件让渲染层刷新 UI logo。不影响窗口/任务栏图标。
   */
  async chooseIcon(): Promise<AppConfigSnapshot> {
    const owner = BrowserWindow.getFocusedWindow() ?? undefined;
    const extensions = ["png", "ico"];
    const result = owner
      ? await dialog.showOpenDialog(owner, {
          title: "选择图标",
          filters: [{ name: "图标", extensions }],
          properties: ["openFile"],
        })
      : await dialog.showOpenDialog({
          title: "选择图标",
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
    return snapshot;
  }
}
