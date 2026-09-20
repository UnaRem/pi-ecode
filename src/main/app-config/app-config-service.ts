import { createHash, randomUUID } from "node:crypto";
import { copyFile, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { app, BrowserWindow, dialog } from "electron";
import { dirname, extname, join, resolve } from "node:path";
import {
  DEFAULT_CONVERSATION_NICKNAMES,
  type AppConfigChangedEvent,
  type AppConfigSnapshot,
  type AppThemeColors,
  type ConversationIdentityRole,
  type ConversationNicknameUpdate,
} from "../../shared/app-config-contracts.js";
import {
  defaultWorkAnimator,
  isPresetFrame,
  WORK_ANIMATOR_DEFAULT_DURATION,
  type WorkAnimatorFrame,
  type WorkAnimatorPreset,
  type WorkAnimatorStatus,
  type WorkAnimatorUpdate,
} from "../../shared/work-animator.js";

interface AppConfigServiceOptions {
  onChanged: (event: AppConfigChangedEvent) => void;
  onError: (message: string) => void;
}

interface StoredConversationIdentity {
  assistantNickname: string;
  userNickname: string;
  assistantAvatarPath: string | null;
  userAvatarPath: string | null;
}

type StoredWorkAnimator = Record<WorkAnimatorStatus, {
  preset: WorkAnimatorPreset;
  frames: Array<Pick<WorkAnimatorFrame, "id" | "durationMs">>;
}>;

interface AppConfigFile {
  iconPath: string | null;
  theme: AppThemeColors | null;
  backgroundImagePath: string | null;
  conversationIdentity: StoredConversationIdentity;
  workAnimator: StoredWorkAnimator;
}

const IMAGE_EXTENSIONS = ["png", "jpg", "jpeg", "webp", "gif"];
const AVATAR_EXTENSIONS = ["png", "jpg", "jpeg", "webp"];
const ICON_EXTENSIONS = ["png", "ico"];

function defaultConversationIdentity(): StoredConversationIdentity {
  return {
    assistantNickname: DEFAULT_CONVERSATION_NICKNAMES.assistant,
    userNickname: DEFAULT_CONVERSATION_NICKNAMES.user,
    assistantAvatarPath: null,
    userAvatarPath: null,
  };
}

function defaultStoredWorkAnimator(): StoredWorkAnimator {
  const defaults = defaultWorkAnimator();
  return {
    idle: { preset: "shiro", frames: defaults.idle.frames.map(({ id, durationMs }) => ({ id, durationMs })) },
    working: { preset: "shiro", frames: defaults.working.frames.map(({ id, durationMs }) => ({ id, durationMs })) },
  };
}

function emptyConfig(): AppConfigFile {
  return { iconPath: null, theme: null, backgroundImagePath: null, conversationIdentity: defaultConversationIdentity(), workAnimator: defaultStoredWorkAnimator() };
}

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

function normalizeNickname(value: unknown, fallback: string): string {
  if (typeof value !== "string") return fallback;
  return value.trim().slice(0, 40) || fallback;
}

function normalizeConversationIdentity(value: unknown): StoredConversationIdentity {
  if (!value || typeof value !== "object" || Array.isArray(value)) return defaultConversationIdentity();
  const candidate = value as Record<string, unknown>;
  return {
    assistantNickname: normalizeNickname(candidate.assistantNickname, DEFAULT_CONVERSATION_NICKNAMES.assistant),
    userNickname: normalizeNickname(candidate.userNickname, DEFAULT_CONVERSATION_NICKNAMES.user),
    assistantAvatarPath: typeof candidate.assistantAvatarPath === "string" ? candidate.assistantAvatarPath : null,
    userAvatarPath: typeof candidate.userAvatarPath === "string" ? candidate.userAvatarPath : null,
  };
}

function isWorkAsset(id: string, status: WorkAnimatorStatus): boolean {
  return new RegExp(`^assets/work-${status}-[a-f0-9-]+\\.(png|jpg|jpeg|webp)$`).test(id);
}

function isBuiltInFrame(status: WorkAnimatorStatus, id: string): boolean {
  return isPresetFrame(status, "shiro", id) || isPresetFrame(status, "silence_wang", id);
}

function validDuration(value: unknown): value is number {
  return Number.isInteger(value) && typeof value === "number" && value >= 50 && value <= 10_000;
}

function normalizeWorkAnimator(value: unknown): StoredWorkAnimator {
  const defaults = defaultStoredWorkAnimator();
  if (!value || typeof value !== "object" || Array.isArray(value)) return defaults;
  const states = value as Record<string, unknown>;
  for (const status of ["idle", "working"] as const) {
    const candidate = states[status];
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) continue;
    const state = candidate as Record<string, unknown>;
    if (state.preset !== "shiro" && state.preset !== "silence_wang" && state.preset !== "custom") continue;
    if (!Array.isArray(state.frames) || !state.frames.length) continue;
    const frames: Array<Pick<WorkAnimatorFrame, "id" | "durationMs">> = [];
    for (const item of state.frames) {
      if (!item || typeof item !== "object") break;
      const frame = item as Partial<WorkAnimatorFrame>;
      if (typeof frame.id !== "string" || !validDuration(frame.durationMs)) break;
      if (state.preset === "custom" ? !isWorkAsset(frame.id, status) && !isBuiltInFrame(status, frame.id) : !isPresetFrame(status, state.preset, frame.id)) break;
      if (frames.some((entry) => entry.id === frame.id)) break;
      frames.push({ id: frame.id, durationMs: frame.durationMs });
    }
    if (frames.length === state.frames.length) defaults[status] = { preset: state.preset, frames };
  }
  return defaults;
}

function toFileUrl(absolutePath: string, seed: string): string {
  return `file:///${absolutePath.replace(/\\/g, "/")}?v=${revision(seed).slice(0, 8)}`;
}

/**
 * pi-ecode 应用级配置服务：管理 UI 内 logo、会话身份、侧栏人物与背景图。
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
      workAnimator: { idle: { preset: value.workAnimator.idle.preset, frames: [] }, working: { preset: value.workAnimator.working.preset, frames: [] } },
      conversationIdentity: {
        assistant: {
          nickname: value.conversationIdentity.assistantNickname,
          avatarPath: value.conversationIdentity.assistantAvatarPath,
          avatarUrl: null,
        },
        user: {
          nickname: value.conversationIdentity.userNickname,
          avatarPath: value.conversationIdentity.userAvatarPath,
          avatarUrl: null,
        },
      },
    };
    if (value.iconPath) {
      const absolute = resolve(app.getPath("userData"), value.iconPath);
      snapshot.iconUrl = toFileUrl(absolute, value.iconPath);
    }
    if (value.backgroundImagePath) {
      const absolute = resolve(app.getPath("userData"), value.backgroundImagePath);
      snapshot.backgroundImageUrl = toFileUrl(absolute, value.backgroundImagePath);
    }
    for (const role of ["assistant", "user"] as const) {
      const avatarPath = snapshot.conversationIdentity[role].avatarPath;
      if (avatarPath) {
        const absolute = resolve(app.getPath("userData"), avatarPath);
        snapshot.conversationIdentity[role].avatarUrl = toFileUrl(absolute, avatarPath);
      }
    }
    for (const status of ["idle", "working"] as const) {
      snapshot.workAnimator[status].frames = value.workAnimator[status].frames.map((frame) => ({
        ...frame,
        url: isWorkAsset(frame.id, status)
          ? toFileUrl(resolve(app.getPath("userData"), frame.id), frame.id)
          : `./${frame.id}`,
      }));
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
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return emptyConfig();
      const candidate = parsed as Partial<AppConfigFile>;
      return {
        iconPath: typeof candidate.iconPath === "string" ? candidate.iconPath : null,
        theme: normalizeTheme(candidate.theme),
        backgroundImagePath: typeof candidate.backgroundImagePath === "string" ? candidate.backgroundImagePath : null,
        conversationIdentity: normalizeConversationIdentity(candidate.conversationIdentity),
        workAnimator: normalizeWorkAnimator(candidate.workAnimator),
      };
    } catch (error) {
      const code = error && typeof error === "object" && "code" in error ? (error as NodeJS.ErrnoException).code : undefined;
      if (code === "ENOENT") return emptyConfig();
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

  async chooseConversationAvatar(role: ConversationIdentityRole): Promise<AppConfigSnapshot> {
    const source = await this.pickImage(AVATAR_EXTENSIONS, role === "assistant" ? "选择模型头像" : "选择用户头像");
    if (!source) return this.getSnapshot();

    const relative = await this.copyToAssets(source, `${role}-avatar`);
    const config = await this.readConfig();
    const field = role === "assistant" ? "assistantAvatarPath" : "userAvatarPath";
    const oldValue = config.conversationIdentity[field];
    config.conversationIdentity[field] = relative;
    await this.writeConfig(config);
    await this.removeAsset(oldValue && oldValue !== relative ? oldValue : null);

    const snapshot = this.toSnapshot(config);
    this.emit(snapshot);
    return snapshot;
  }

  async clearConversationAvatar(role: ConversationIdentityRole): Promise<AppConfigSnapshot> {
    const config = await this.readConfig();
    const field = role === "assistant" ? "assistantAvatarPath" : "userAvatarPath";
    const oldValue = config.conversationIdentity[field];
    config.conversationIdentity[field] = null;
    await this.writeConfig(config);
    await this.removeAsset(oldValue);

    const snapshot = this.toSnapshot(config);
    this.emit(snapshot);
    return snapshot;
  }

  async saveConversationNicknames(value: ConversationNicknameUpdate): Promise<AppConfigSnapshot> {
    const config = await this.readConfig();
    config.conversationIdentity.assistantNickname = normalizeNickname(value.assistant, DEFAULT_CONVERSATION_NICKNAMES.assistant);
    config.conversationIdentity.userNickname = normalizeNickname(value.user, DEFAULT_CONVERSATION_NICKNAMES.user);
    await this.writeConfig(config);

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

  async saveWorkAnimator(status: WorkAnimatorStatus, update: WorkAnimatorUpdate): Promise<AppConfigSnapshot> {
    const config = await this.readConfig();
    const previous = config.workAnimator[status];
    const { preset, frames } = update;
    if (preset !== "shiro" && preset !== "silence_wang" && preset !== "custom") throw new Error("Invalid animator preset.");
    if (!Array.isArray(frames) || !frames.length || frames.length > 100) throw new Error("Invalid animator frames.");
    const seen = new Set<string>();
    for (const frame of frames) {
      if (!frame || typeof frame.id !== "string" || !validDuration(frame.durationMs) || seen.has(frame.id)) {
        throw new Error("Invalid animator frame or duration (50–10000 ms).");
      }
      seen.add(frame.id);
      const allowed = preset === "custom"
        ? isBuiltInFrame(status, frame.id) || (isWorkAsset(frame.id, status) && previous.frames.some((entry) => entry.id === frame.id))
        : isPresetFrame(status, preset, frame.id);
      if (!allowed) throw new Error("Animator frame does not belong to this state.");
    }
    config.workAnimator[status] = { preset, frames: frames.map(({ id, durationMs }) => ({ id, durationMs })) };
    await this.writeConfig(config);
    // Only delete files after the new configuration is durable; built-in frames are never removed.
    const snapshot = this.toSnapshot(config);
    this.emit(snapshot);
    for (const frame of previous.frames) {
      if (!isWorkAsset(frame.id, status) || seen.has(frame.id)) continue;
      try {
        await this.removeAsset(frame.id);
      } catch (error) {
        this.options.onError(`Saved animator settings, but could not remove ${frame.id}: ${String(error)}`);
      }
    }
    return snapshot;
  }

  async addWorkAnimatorImages(status: WorkAnimatorStatus): Promise<AppConfigSnapshot> {
    const owner = BrowserWindow.getFocusedWindow() ?? undefined;
    const options = {
      title: status === "idle" ? "添加空闲状态图片" : "添加工作状态图片",
      filters: [{ name: "图片", extensions: AVATAR_EXTENSIONS }],
      properties: ["openFile", "multiSelections"] as Array<"openFile" | "multiSelections">,
    };
    const result = owner ? await dialog.showOpenDialog(owner, options) : await dialog.showOpenDialog(options);
    if (result.canceled || !result.filePaths.length) return this.getSnapshot();
    const config = await this.readConfig();
    const previous = config.workAnimator[status];
    if (previous.frames.length + result.filePaths.length > 100) throw new Error("A state can have at most 100 images.");
    if (result.filePaths.some((path) => !AVATAR_EXTENSIONS.includes(extname(path).slice(1).toLowerCase()))) {
      throw new Error("Only PNG, JPG and WebP images can be added.");
    }
    const added: string[] = [];
    try {
      for (const source of result.filePaths) {
        const id = await this.copyToAssets(source, `work-${status}-${randomUUID()}`);
        added.push(id);
      }
      const frames = added.map((id) => ({ id, durationMs: WORK_ANIMATOR_DEFAULT_DURATION[status] }));
      config.workAnimator[status] = { preset: "custom", frames: [...previous.frames, ...frames] };
      await this.writeConfig(config);
    } catch (error) {
      await Promise.all(added.map((id) => this.removeAsset(id)));
      throw error;
    }
    const snapshot = this.toSnapshot(config);
    this.emit(snapshot);
    return snapshot;
  }
}
