import { createHash, randomUUID } from "node:crypto";
import { copyFile, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { app, BrowserWindow, dialog } from "electron";
import { dirname, extname, join, resolve } from "node:path";
import type { AppConfigChangedEvent, AppConfigSnapshot, AppThemeColors } from "../../shared/app-config-contracts.js";

interface AppConfigServiceOptions {
  onChanged: (event: AppConfigChangedEvent) => void;
  onError: (message: string) => void;
}

interface AppConfigFile {
  iconPath: string | null;
  theme: AppThemeColors | null;
  backgroundImagePath: string | null;
}

const IMAGE_EXTENSIONS = ["png", "jpg", "jpeg", "webp", "gif"];
const ICON_EXTENSIONS = ["png", "ico"];

function revision(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function normalizeColor(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return /^#[0-9a-fA-F]{6}$/.test(trimmed) ? trimmed.toLowerCase() : null;
}

function normalizeTheme(value: unknown): AppThemeColors | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  const colors: AppThemeColors = {
    accent: normalizeColor(candidate.accent),
    accentSoft: normalizeColor(candidate.accentSoft),
    danger: normalizeColor(candidate.danger),
    background: normalizeColor(candidate.background),
  };
  return Object.values(colors).some(Boolean) ? colors : null;
}

function toFileUrl(absolutePath: string, seed: string): string {
  return `file:///${absolutePath.replace(/\\/g, "/")}?v=${revision(seed).slice(0, 8)}`;
}

/**
 * pi-ecode 应用级配置服务：管理 UI 内 logo、主题色与会话区背景图。
 * 不触碰 Electron 窗口/任务栏图标——后者由打包资源固定为 PiECode 品牌图标
 * （Windows 任务栏图标在打包态无法通过运行时 setIcon 可靠变更，属平台固有限制）。
 * 持久化到 userData/app-config.json，图片文件复制到 userData/ 下。
 */
export class AppConfigService {
  private cached: AppConfigSnapshot | null = null;

  constructor(private readonly options: AppConfigServiceOptions) {}

  get configFilePath(): string {
    return join(app.getPath("userData"), "app-config.json");
  }

  get assetsDir(): string {
    return join(app.getPath("userData"), "assets");
  }

  private toSnapshot(value: AppConfigFile): AppConfigSnapshot {
    const snapshot: AppConfigSnapshot = {
      iconPath: value.iconPath ?? null,
      iconUrl: null,
      theme: value.theme ?? { accent: null, accentSoft: null, danger: null, background: null },
      backgroundImagePath: value.backgroundImagePath ?? null,
      backgroundImageUrl: null,
    };
    if (value.iconPath) {
      const absolute = resolve(app.getPath("userData"), value.iconPath);
      snapshot.iconUrl = toFileUrl(absolute, value.iconPath);
    }
    if (value.backgroundImagePath) {
      const absolute = resolve(app.getPath("userData"), value.backgroundImagePath);
      snapshot.backgroundImageUrl = toFileUrl(absolute, value.backgroundImagePath);
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
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        return { iconPath: null, theme: null, backgroundImagePath: null };
      }
      const candidate = parsed as Partial<AppConfigFile>;
      return {
        iconPath: typeof candidate.iconPath === "string" ? candidate.iconPath : null,
        theme: normalizeTheme(candidate.theme),
        backgroundImagePath: typeof candidate.backgroundImagePath === "string" ? candidate.backgroundImagePath : null,
      };
    } catch (error) {
      const code = error && typeof error === "object" && "code" in error ? (error as NodeJS.ErrnoException).code : undefined;
      if (code === "ENOENT") return { iconPath: null, theme: null, backgroundImagePath: null };
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

  private async pickImage(extensions: string[], title: string): Promise<string | null> {
    const owner = BrowserWindow.getFocusedWindow() ?? undefined;
    const result = owner
      ? await dialog.showOpenDialog(owner, {
          title,
          filters: [{ name: "图片", extensions }],
          properties: ["openFile"],
        })
      : await dialog.showOpenDialog({
          title,
          filters: [{ name: "图片", extensions }],
          properties: ["openFile"],
        });
    if (result.canceled || !result.filePaths[0]) return null;
    return result.filePaths[0];
  }

  private async copyToAssets(source: string, prefix: string): Promise<string> {
    const ext = extname(source).toLowerCase() || ".png";
    const destName = `${prefix}-${revision(source).slice(0, 12)}${ext}`;
    await mkdir(this.assetsDir, { recursive: true });
    const dest = join(this.assetsDir, destName);
    await copyFile(source, dest);
    return `assets/${destName}`;
  }

  private async removeAsset(relativePath: string | null | undefined): Promise<void> {
    if (!relativePath) return;
    const absolute = resolve(app.getPath("userData"), relativePath);
    if (absolute.startsWith(this.assetsDir)) await rm(absolute, { force: true });
  }

  /** 选择本地图标文件并复制到应用数据目录，广播事件让渲染层刷新 UI logo。 */
  async chooseIcon(): Promise<AppConfigSnapshot> {
    const source = await this.pickImage(ICON_EXTENSIONS, "选择图标");
    if (!source) return this.getSnapshot();

    const relative = await this.copyToAssets(source, "app-icon");
    const config = await this.readConfig();
    const oldValue = config.iconPath;
    config.iconPath = relative;
    await this.writeConfig(config);
    await this.removeAsset(oldValue && oldValue !== relative ? oldValue : null);

    const snapshot = this.toSnapshot(config);
    this.emit(snapshot);
    return snapshot;
  }

  async clearIcon(): Promise<AppConfigSnapshot> {
    const config = await this.readConfig();
    const oldValue = config.iconPath;
    config.iconPath = null;
    await this.writeConfig(config);
    await this.removeAsset(oldValue);

    const snapshot = this.toSnapshot(config);
    this.emit(snapshot);
    return snapshot;
  }

  /** 保存主题色（null 项恢复默认）。 */
  async saveTheme(colors: AppThemeColors): Promise<AppConfigSnapshot> {
    const config = await this.readConfig();
    config.theme = normalizeTheme(colors);
    await this.writeConfig(config);

    const snapshot = this.toSnapshot(config);
    this.emit(snapshot);
    return snapshot;
  }

  /** 选择本地图片作为会话区背景，复制到应用数据目录。 */
  async chooseBackgroundImage(): Promise<AppConfigSnapshot> {
    const source = await this.pickImage(IMAGE_EXTENSIONS, "选择会话区背景图");
    if (!source) return this.getSnapshot();

    const relative = await this.copyToAssets(source, "background");
    const config = await this.readConfig();
    const oldValue = config.backgroundImagePath;
    config.backgroundImagePath = relative;
    await this.writeConfig(config);
    await this.removeAsset(oldValue && oldValue !== relative ? oldValue : null);

    const snapshot = this.toSnapshot(config);
    this.emit(snapshot);
    return snapshot;
  }

  async clearBackgroundImage(): Promise<AppConfigSnapshot> {
    const config = await this.readConfig();
    const oldValue = config.backgroundImagePath;
    config.backgroundImagePath = null;
    await this.writeConfig(config);
    await this.removeAsset(oldValue);

    const snapshot = this.toSnapshot(config);
    this.emit(snapshot);
    return snapshot;
  }
}
