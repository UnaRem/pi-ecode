import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import chokidar, { type FSWatcher } from "chokidar";
import type {
  AuthType,
  ConfigDocument,
  ConfigTarget,
  InstructionFileDocument,
  InstructionFileTarget,
  JsonObject,
  JsonValue,
  ProviderStatus,
  SaveConfigRequest,
  SaveInstructionFileRequest,
  SettingsSnapshot,
} from "../../shared/settings-contracts.js";
import { REDACTED_CONFIG_VALUE } from "../../shared/settings-contracts.js";
import { validateConfig } from "./settings-validation.js";

interface SettingsServiceOptions {
  agentDir: string;
  getProjectPath: () => string | undefined;
  getProviderStatuses: () => Promise<ProviderStatus[]>;
  isFffLoaded: () => boolean;
  isProjectTrusted: () => boolean;
  isRuntimeBusy: () => boolean;
  applyRuntimeChanges: () => Promise<void>;
  onChanged: (snapshot: SettingsSnapshot, source: "save" | "external" | "runtime") => void;
  onError: (message: string) => void;
}

interface LoadedDocument extends ConfigDocument {
  rawValue: JsonObject;
}

const SENSITIVE_KEYS = /^(apiKey|authorization|x-api-key|x-auth-token)$/i;
const MAX_INSTRUCTION_FILE_BYTES = 1_000_000;

function isObject(value: JsonValue | undefined): value is JsonObject {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function revision(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function mergeObjects(base: JsonObject, override: JsonObject): JsonObject {
  const merged = structuredClone(base);
  for (const [key, value] of Object.entries(override)) {
    const existing = merged[key];
    merged[key] = isObject(existing) && isObject(value) ? mergeObjects(existing, value) : structuredClone(value);
  }
  return merged;
}

function shouldMask(key: string, value: string, insideHeaders: boolean): boolean {
  if (!insideHeaders && !SENSITIVE_KEYS.test(key)) return false;
  return !value.startsWith("$") && !value.startsWith("!");
}

function maskSensitive(value: JsonValue, key = "", insideHeaders = false): JsonValue {
  if (typeof value === "string") return shouldMask(key, value, insideHeaders) ? REDACTED_CONFIG_VALUE : value;
  if (Array.isArray(value)) return value.map((item) => maskSensitive(item, "", insideHeaders));
  if (!isObject(value)) return value;
  const childInsideHeaders = insideHeaders || key.toLowerCase() === "headers";
  return Object.fromEntries(Object.entries(value).map(([childKey, childValue]) => (
    [childKey, maskSensitive(childValue, childKey, childInsideHeaders)]
  )));
}

function restoreSensitive(next: JsonValue, current: JsonValue | undefined): JsonValue {
  if (next === REDACTED_CONFIG_VALUE) {
    if (current === undefined) throw new Error("A hidden credential cannot be created from a redacted value.");
    return structuredClone(current);
  }
  if (Array.isArray(next)) {
    const currentItems = Array.isArray(current) ? current : [];
    return next.map((item, index) => restoreSensitive(item, currentItems[index]));
  }
  if (!isObject(next)) return next;
  const currentObject = isObject(current) ? current : {};
  return Object.fromEntries(Object.entries(next).map(([childKey, childValue]) => [childKey, restoreSensitive(childValue, currentObject[childKey])]));
}

function parseJsonObject(content: string, path: string): JsonObject {
  const parsed: unknown = JSON.parse(content);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(`${path} must contain a JSON object.`);
  return parsed as JsonObject;
}

export class SettingsService {
  private watcher: FSWatcher | undefined;
  private pendingReload = false;
  private suppressWatchUntil = 0;
  private reloadTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly options: SettingsServiceOptions) {}

  async start(): Promise<void> {
    await this.restartWatcher();
  }

  async projectChanged(): Promise<void> {
    await this.restartWatcher();
  }

  async dispose(): Promise<void> {
    if (this.reloadTimer) clearTimeout(this.reloadTimer);
    await this.watcher?.close();
    this.watcher = undefined;
  }

  async getSnapshot(): Promise<SettingsSnapshot> {
    const paths = this.paths();
    const [globalSettings, projectSettings, models, fff, globalAppendSystem, projectAgents, providers] = await Promise.all([
      this.loadDocument(paths.globalSettings, false),
      this.loadDocument(paths.projectSettings, false),
      this.loadDocument(paths.models, true),
      this.loadDocument(paths.fff, false),
      this.loadInstructionFile(paths.globalAppendSystem),
      this.loadInstructionFile(paths.projectAgents),
      this.providerStatuses(),
    ]);
    const snapshot: SettingsSnapshot = {
      globalSettings: this.publicDocument(globalSettings),
      projectSettings: this.publicDocument(projectSettings),
      effectiveSettings: mergeObjects(globalSettings.rawValue, projectSettings.rawValue),
      models: this.publicDocument(models),
      fff: this.publicDocument(fff),
      instructionFiles: {
        "global-append-system": globalAppendSystem,
        "project-agents": projectAgents,
      },
      fffLoaded: this.options.isFffLoaded(),
      projectTrusted: this.options.isProjectTrusted(),
      providers,
      pendingReload: this.pendingReload,
      error: null,
    };
    snapshot.error = this.snapshotError(snapshot);
    return snapshot;
  }

  async save(request: SaveConfigRequest): Promise<SettingsSnapshot> {
    const path = this.pathFor(request.target);
    if (request.target === "project-settings" && !this.options.isProjectTrusted()) {
      throw new Error("Project settings are read-only until the project is trusted by pi.");
    }
    validateConfig(request.target, request.value);
    const current = await this.loadDocument(path, request.target === "models");
    if (current.revision !== request.expectedRevision) throw new Error("The configuration changed on disk. Reload it before saving.");
    const restored = restoreSensitive(request.value, current.rawValue);
    if (!isObject(restored)) throw new Error("Configuration root must be an object.");
    await this.writeAtomic(path, restored);
    const diskSnapshot = await this.getSnapshot();
    this.assertSnapshotValid(diskSnapshot);
    await this.requestRuntimeApply();
    const snapshot = await this.getSnapshot();
    this.options.onChanged(snapshot, "save");
    return snapshot;
  }

  async saveInstructionFile(request: SaveInstructionFileRequest): Promise<SettingsSnapshot> {
    if (Buffer.byteLength(request.content, "utf8") > MAX_INSTRUCTION_FILE_BYTES) {
      throw new Error("Instruction files must not exceed 1 MB.");
    }
    const path = this.pathForInstructionFile(request.target);
    const current = await this.loadInstructionFile(path);
    if (current.revision !== request.expectedRevision) throw new Error("The instruction file changed on disk. Reload it before saving.");
    await this.writeContentAtomic(path, request.content, request.target === "global-append-system" ? 0o600 : 0o644);
    const diskSnapshot = await this.getSnapshot();
    this.assertSnapshotValid(diskSnapshot);
    await this.requestRuntimeApply();
    const snapshot = await this.getSnapshot();
    this.options.onChanged(snapshot, "save");
    return snapshot;
  }

  async reload(): Promise<SettingsSnapshot> {
    const snapshot = await this.getSnapshot();
    this.assertSnapshotValid(snapshot);
    await this.requestRuntimeApply();
    return this.runtimeStateChanged();
  }

  async runtimeStateChanged(): Promise<SettingsSnapshot> {
    const snapshot = await this.getSnapshot();
    this.options.onChanged(snapshot, "runtime");
    return snapshot;
  }

  async applyPendingIfIdle(): Promise<void> {
    if (!this.pendingReload || this.options.isRuntimeBusy()) return;
    const snapshot = await this.getSnapshot();
    try {
      this.assertSnapshotValid(snapshot);
      await this.applyRuntimeChanges();
      this.options.onChanged(await this.getSnapshot(), "runtime");
    } catch (error) {
      this.pendingReload = false;
      this.options.onChanged(snapshot, "runtime");
      this.options.onError(error instanceof Error ? error.message : String(error));
    }
  }

  private paths(): Record<"globalSettings" | "projectSettings" | "models" | "fff" | "globalAppendSystem" | "projectAgents", string> {
    const projectPath = this.options.getProjectPath();
    return {
      globalSettings: join(this.options.agentDir, "settings.json"),
      projectSettings: projectPath ? join(projectPath, ".pi", "settings.json") : join(this.options.agentDir, "missing-project-settings.json"),
      models: join(this.options.agentDir, "models.json"),
      fff: join(this.options.agentDir, "pi-fff.json"),
      globalAppendSystem: join(this.options.agentDir, "APPEND_SYSTEM.md"),
      projectAgents: projectPath ? join(projectPath, "AGENTS.md") : join(this.options.agentDir, "missing-project-agents.md"),
    };
  }

  private pathFor(target: ConfigTarget): string {
    const paths = this.paths();
    if (target === "global-settings") return paths.globalSettings;
    if (target === "project-settings") return paths.projectSettings;
    return target === "models" ? paths.models : paths.fff;
  }

  private pathForInstructionFile(target: InstructionFileTarget): string {
    const paths = this.paths();
    return target === "global-append-system" ? paths.globalAppendSystem : paths.projectAgents;
  }

  private async loadDocument(path: string, redact: boolean): Promise<LoadedDocument> {
    try {
      const content = await readFile(path, "utf8");
      const rawValue = parseJsonObject(content, path);
      return { path, exists: true, revision: revision(content), value: redact ? maskSensitive(rawValue) as JsonObject : rawValue, rawValue, error: null };
    } catch (error) {
      const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
      if (code === "ENOENT") return { path, exists: false, revision: null, value: {}, rawValue: {}, error: null };
      return { path, exists: true, revision: null, value: {}, rawValue: {}, error: error instanceof Error ? error.message : String(error) };
    }
  }

  private async loadInstructionFile(path: string): Promise<InstructionFileDocument> {
    try {
      const content = await readFile(path, "utf8");
      return { path, exists: true, revision: revision(content), content, error: null };
    } catch (error) {
      const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
      if (code === "ENOENT") return { path, exists: false, revision: null, content: "", error: null };
      return { path, exists: true, revision: null, content: "", error: error instanceof Error ? error.message : String(error) };
    }
  }

  private publicDocument(document: LoadedDocument): ConfigDocument {
    const { rawValue: _rawValue, ...publicDocument } = document;
    return publicDocument;
  }

  private writeAtomic(path: string, value: JsonObject): Promise<void> {
    return this.writeContentAtomic(path, `${JSON.stringify(value, null, 2)}\n`, 0o600);
  }

  private async writeContentAtomic(path: string, content: string, mode: number): Promise<void> {
    await mkdir(dirname(path), { recursive: true });
    const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporaryPath, content, { encoding: "utf8", mode });
      this.suppressWatchUntil = Date.now() + 750;
      await rename(temporaryPath, path);
    } finally {
      await rm(temporaryPath, { force: true });
    }
  }

  private async providerStatuses(): Promise<ProviderStatus[]> {
    return this.options.getProviderStatuses().catch(() => []);
  }

  private async restartWatcher(): Promise<void> {
    await this.watcher?.close();
    const targetPaths = Object.values(this.paths()).map((path) => resolve(path));
    const projectPath = this.options.getProjectPath();
    const roots = [resolve(this.options.agentDir), ...(projectPath ? [resolve(projectPath)] : [])];
    const isTargetOrAncestor = (path: string): boolean => {
      const candidate = resolve(path);
      return targetPaths.some((target) => target === candidate || target.startsWith(`${candidate}${sep}`));
    };
    const watcher = chokidar.watch([...new Set(roots)], {
      depth: 1,
      ignoreInitial: true,
      ignored: (path) => !isTargetOrAncestor(path),
      awaitWriteFinish: { stabilityThreshold: 300, pollInterval: 80 },
    });
    this.watcher = watcher;
    watcher.on("all", (_event, path) => {
      if (targetPaths.includes(resolve(path))) this.onExternalChange();
    });
    await new Promise<void>((ready) => watcher.once("ready", ready));
  }

  private onExternalChange(): void {
    if (Date.now() < this.suppressWatchUntil) return;
    if (this.reloadTimer) clearTimeout(this.reloadTimer);
    this.reloadTimer = setTimeout(() => {
      void this.handleExternalChange();
    }, 250);
  }

  private async handleExternalChange(): Promise<void> {
    let snapshot: SettingsSnapshot | undefined;
    try {
      snapshot = await this.getSnapshot();
      this.assertSnapshotValid(snapshot);
      await this.requestRuntimeApply();
      this.options.onChanged(await this.getSnapshot(), "external");
    } catch (error) {
      if (snapshot) this.options.onChanged(snapshot, "external");
      this.options.onError(error instanceof Error ? error.message : String(error));
    }
  }

  private snapshotError(snapshot: SettingsSnapshot): string | null {
    const documents: Array<[ConfigTarget, ConfigDocument]> = [
      ["global-settings", snapshot.globalSettings],
      ["project-settings", snapshot.projectSettings],
      ["models", snapshot.models],
      ["pi-fff", snapshot.fff],
    ];
    try {
      for (const [target, document] of documents) {
        if (document.error) throw new Error(`${document.path}: ${document.error}`);
        validateConfig(target, document.value);
      }
      for (const document of Object.values(snapshot.instructionFiles)) {
        if (document.error) throw new Error(`${document.path}: ${document.error}`);
      }
      return null;
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  }

  private assertSnapshotValid(snapshot: SettingsSnapshot): void {
    if (snapshot.error) throw new Error(snapshot.error);
  }

  private async requestRuntimeApply(): Promise<void> {
    if (this.options.isRuntimeBusy()) {
      this.pendingReload = true;
      return;
    }
    await this.applyRuntimeChanges();
  }

  private async applyRuntimeChanges(): Promise<void> {
    try {
      await this.options.applyRuntimeChanges();
      this.pendingReload = false;
    } catch (error) {
      this.pendingReload = false;
      throw error;
    }
  }
}
