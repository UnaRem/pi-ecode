import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import type {
  AgentSession,
  ExtensionAPI,
  InlineExtension,
  SessionEntry,
} from "@earendil-works/pi-coding-agent";
import type { ChangeReview, ChangedFile } from "../../shared/contracts.js";

const execFileAsync = promisify(execFile);
const TURN_ENTRY = "pi-ecode.workspace-turn";
const CHECKPOINT_ENTRY = "pi-ecode.workspace-checkpoint";
const MAX_PATCH_LENGTH = 400_000;
const DEFAULT_EXCLUDES = [
  ".git/",
  ".pi/workspace-history/",
  "node_modules/",
  "out/",
  "dist/",
  "build/",
  "release/",
  "coverage/",
  ".cache/",
  ".next/",
  ".turbo/",
  ".env",
  ".env.*",
  "*.log",
];

interface TurnRecord {
  version: 1;
  beforeCommit: string;
  afterCommit: string;
  userEntryId: string;
  assistantEntryId: string;
  prompt: string;
  createdAt: string;
}

interface CheckpointRecord {
  version: 1;
  commit: string;
  label: string;
  createdAt: string;
}

interface RedoRecord {
  targetEntryId: string;
  commit: string;
  createdAt: string;
}

interface PendingTurn {
  beforeCommit: string;
  userEntryId: string;
  prompt: string;
}

export interface WorkspaceHistoryState {
  available: boolean;
  canUndo: boolean;
  canRedo: boolean;
  isBusy: boolean;
  message: string | null;
}

export interface HistoryOperationResult {
  editorText?: string;
  message: string;
}

function isCustomEntry<T>(entry: SessionEntry, customType: string): entry is SessionEntry & { type: "custom"; data?: T } {
  return entry.type === "custom" && entry.customType === customType;
}

function messageText(entry: SessionEntry | undefined): string {
  if (entry?.type !== "message" || entry.message.role !== "user") return "";
  const content = entry.message.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((block): block is { type: "text"; text: string } => (
      typeof block === "object" && block !== null && block.type === "text" && "text" in block && typeof block.text === "string"
    ))
    .map((block) => block.text)
    .join("\n");
}

function latestEntryId(session: AgentSession): string | undefined {
  return session.sessionManager.getLeafId() ?? undefined;
}

function latestUserEntry(session: AgentSession): SessionEntry | undefined {
  return [...session.sessionManager.getBranch()].reverse().find(
    (entry) => entry.type === "message" && entry.message.role === "user",
  );
}

function latestAssistantEntry(session: AgentSession): SessionEntry | undefined {
  return [...session.sessionManager.getBranch()].reverse().find(
    (entry) => entry.type === "message" && entry.message.role === "assistant",
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class WorkspaceHistory {
  private readonly pendingBySession = new Map<string, PendingTurn>();
  private readonly checkpointBySession = new Map<string, Promise<HistoryOperationResult>>();
  private busy = false;
  private statusMessage: string | null = null;

  constructor(private readonly storageRoot: string) {}

  asExtension(): InlineExtension {
    return {
      name: "pi-ecode-workspace-history",
      factory: (pi) => this.registerExtension(pi),
    };
  }

  private registerExtension(pi: ExtensionAPI): void {
    pi.on("before_agent_start", async (event, ctx) => {
      const userEntry = [...ctx.sessionManager.getBranch()].reverse().find(
        (entry) => entry.type === "message" && entry.message.role === "user",
      );
      if (!userEntry) return;
      const beforeCommit = await this.snapshot(ctx.cwd, ctx.sessionManager.getSessionId(), "before agent turn");
      this.pendingBySession.set(ctx.sessionManager.getSessionId(), {
        beforeCommit,
        userEntryId: userEntry.id,
        prompt: event.prompt,
      });
    });

    pi.on("turn_end", async (_event, ctx) => {
      const sessionId = ctx.sessionManager.getSessionId();
      const pending = this.pendingBySession.get(sessionId);
      if (!pending) return;
      const assistantEntry = [...ctx.sessionManager.getBranch()].reverse().find(
        (entry) => entry.type === "message" && entry.message.role === "assistant",
      );
      if (!assistantEntry) return;
      const afterCommit = await this.snapshot(ctx.cwd, sessionId, "after agent turn");
      const record: TurnRecord = {
        version: 1,
        beforeCommit: pending.beforeCommit,
        afterCommit,
        userEntryId: pending.userEntryId,
        assistantEntryId: assistantEntry.id,
        prompt: pending.prompt,
        createdAt: new Date().toISOString(),
      };
      pi.appendEntry<TurnRecord>(TURN_ENTRY, record);
      await this.writeRedo(ctx.cwd, sessionId, undefined);
    });

    pi.on("agent_end", (_event, ctx) => {
      this.pendingBySession.delete(ctx.sessionManager.getSessionId());
    });

    pi.on("session_shutdown", (_event, ctx) => {
      this.pendingBySession.delete(ctx.sessionManager.getSessionId());
    });
  }

  async getReview(session: AgentSession): Promise<ChangeReview> {
    const record = this.findUndoRecord(session);
    if (!record) {
      return {
        available: false,
        baseCommit: null,
        headCommit: null,
        files: [],
        patch: "",
        truncated: false,
        message: "No completed agent turn is available for review.",
      };
    }
    await this.ensureRepo(session.sessionManager.getCwd(), session.sessionId);
    const headCommit = (await this.execGit(
      session.sessionManager.getCwd(),
      session.sessionId,
      ["rev-parse", "HEAD"],
    )).trim();
    const [nameStatus, numStat, rawPatch] = await Promise.all([
      this.execGit(session.sessionManager.getCwd(), session.sessionId, [
        "diff", "--name-status", "--find-renames", record.beforeCommit, headCommit,
      ]),
      this.execGit(session.sessionManager.getCwd(), session.sessionId, [
        "diff", "--numstat", "--find-renames", record.beforeCommit, headCommit,
      ]),
      this.execGit(session.sessionManager.getCwd(), session.sessionId, [
        "diff", "--no-ext-diff", "--unified=3", "--find-renames", record.beforeCommit, headCommit,
      ]),
    ]);
    const counts = new Map<string, { additions: number | null; deletions: number | null }>();
    for (const line of numStat.split("\n")) {
      const [added, deleted, ...pathParts] = line.split("\t");
      const path = pathParts.at(-1);
      if (!path) continue;
      counts.set(path, {
        additions: added === "-" ? null : Number.parseInt(added ?? "", 10),
        deletions: deleted === "-" ? null : Number.parseInt(deleted ?? "", 10),
      });
    }
    const files: ChangedFile[] = nameStatus.split("\n").filter(Boolean).map((line) => {
      const [code = "", ...paths] = line.split("\t");
      const path = paths.at(-1) ?? "unknown";
      const previousPath = code.startsWith("R") ? paths.at(0) : undefined;
      const count = counts.get(path) ?? { additions: null, deletions: null };
      const status: ChangedFile["status"] = code.startsWith("A")
        ? "added"
        : code.startsWith("M")
          ? "modified"
          : code.startsWith("D")
            ? "deleted"
            : code.startsWith("R")
              ? "renamed"
              : "unknown";
      return { path, ...(previousPath && previousPath !== path ? { previousPath } : {}), status, ...count };
    });
    const truncated = rawPatch.length > MAX_PATCH_LENGTH;
    return {
      available: files.length > 0,
      baseCommit: record.beforeCommit,
      headCommit,
      files,
      patch: truncated ? `${rawPatch.slice(0, MAX_PATCH_LENGTH)}\n\n[Patch truncated]` : rawPatch,
      truncated,
      message: files.length > 0 ? null : "The latest agent turn did not change tracked workspace files.",
    };
  }

  async rejectFile(session: AgentSession, requestedPath: string): Promise<ChangeReview> {
    return this.runExclusive(async () => {
      await session.waitForIdle();
      const review = await this.getReview(session);
      const file = review.files.find((item) => item.path === requestedPath);
      if (!file || !review.baseCommit) throw new Error("The requested path is not part of the current change review.");
      const cwd = session.sessionManager.getCwd();
      const absoluteTarget = resolve(cwd, file.path);
      const workspaceRelative = relative(cwd, absoluteTarget);
      if (!workspaceRelative || workspaceRelative.startsWith("..") || resolve(cwd, workspaceRelative) !== absoluteTarget) {
        throw new Error("Review path resolves outside the active workspace.");
      }

      if (file.status === "added") {
        await rm(absoluteTarget, { recursive: true, force: true });
      } else if (file.status === "renamed" && file.previousPath) {
        const absolutePrevious = resolve(cwd, file.previousPath);
        const previousRelative = relative(cwd, absolutePrevious);
        if (!previousRelative || previousRelative.startsWith("..")) throw new Error("Rename source resolves outside the workspace.");
        await rm(absoluteTarget, { recursive: true, force: true });
        await this.execGit(cwd, session.sessionId, ["checkout", review.baseCommit, "--", file.previousPath]);
      } else {
        await this.execGit(cwd, session.sessionId, ["checkout", review.baseCommit, "--", file.path]);
      }

      await this.snapshot(cwd, session.sessionId, `reject review file ${file.path}`);
      return this.getReview(session);
    });
  }

  async getState(session: AgentSession | undefined): Promise<WorkspaceHistoryState> {
    if (!session) {
      return { available: false, canUndo: false, canRedo: false, isBusy: this.busy, message: this.statusMessage };
    }
    const canUndo = this.findUndoRecord(session) !== undefined;
    const redo = await this.readRedo(session.sessionManager.getCwd(), session.sessionId);
    return { available: true, canUndo, canRedo: redo !== undefined, isBusy: this.busy, message: this.statusMessage };
  }

  checkpoint(session: AgentSession, label: string): Promise<HistoryOperationResult> {
    const existing = this.checkpointBySession.get(session.sessionId);
    if (existing) return existing;

    const operation = this.runExclusive(async () => {
      await session.waitForIdle();
      const normalizedLabel = label.trim() || "manual checkpoint";
      const commit = await this.snapshot(session.sessionManager.getCwd(), session.sessionId, normalizedLabel);
      const record: CheckpointRecord = {
        version: 1,
        commit,
        label: normalizedLabel,
        createdAt: new Date().toISOString(),
      };
      session.sessionManager.appendCustomEntry(CHECKPOINT_ENTRY, record);
      await this.writeRedo(session.sessionManager.getCwd(), session.sessionId, undefined);
      return { message: `Checkpoint saved: ${normalizedLabel}` };
    });
    this.checkpointBySession.set(session.sessionId, operation);
    void operation.finally(() => {
      if (this.checkpointBySession.get(session.sessionId) === operation) {
        this.checkpointBySession.delete(session.sessionId);
      }
    }).catch(() => undefined);
    return operation;
  }

  async undo(session: AgentSession): Promise<HistoryOperationResult> {
    return this.runExclusive(async () => {
      await session.waitForIdle();
      const record = this.findUndoRecord(session);
      if (!record) throw new Error("Nothing to undo in this conversation.");
      await this.assertClean(session.sessionManager.getCwd(), session.sessionId);
      const currentEntryId = latestEntryId(session);
      if (!currentEntryId) throw new Error("The current conversation has no restorable entry.");
      const currentCommit = (await this.execGit(
        session.sessionManager.getCwd(),
        session.sessionId,
        ["rev-parse", "HEAD"],
      )).trim();

      await this.restore(session.sessionManager.getCwd(), session.sessionId, record.beforeCommit);
      try {
        const result = await session.navigateTree(record.userEntryId, { summarize: false });
        if (result.cancelled) throw new Error("Undo was cancelled by a session extension.");
      } catch (error) {
        await this.restore(session.sessionManager.getCwd(), session.sessionId, currentCommit);
        throw error;
      }
      await this.writeRedo(session.sessionManager.getCwd(), session.sessionId, {
        targetEntryId: currentEntryId,
        commit: currentCommit,
        createdAt: new Date().toISOString(),
      });
      return { editorText: record.prompt || messageText(session.sessionManager.getEntry(record.userEntryId)), message: "Workspace and conversation restored." };
    });
  }

  async redo(session: AgentSession): Promise<HistoryOperationResult> {
    return this.runExclusive(async () => {
      await session.waitForIdle();
      const redo = await this.readRedo(session.sessionManager.getCwd(), session.sessionId);
      if (!redo) throw new Error("Nothing to redo.");
      await this.assertClean(session.sessionManager.getCwd(), session.sessionId);
      const currentCommit = (await this.execGit(
        session.sessionManager.getCwd(),
        session.sessionId,
        ["rev-parse", "HEAD"],
      )).trim();
      await this.restore(session.sessionManager.getCwd(), session.sessionId, redo.commit);
      try {
        const result = await session.navigateTree(redo.targetEntryId, { summarize: false });
        if (result.cancelled) throw new Error("Redo was cancelled by a session extension.");
      } catch (error) {
        await this.restore(session.sessionManager.getCwd(), session.sessionId, currentCommit);
        throw error;
      }
      await this.writeRedo(session.sessionManager.getCwd(), session.sessionId, undefined);
      return { message: "Workspace and conversation restored." };
    });
  }

  private findUndoRecord(session: AgentSession): TurnRecord | undefined {
    for (const entry of [...session.sessionManager.getBranch()].reverse()) {
      if (!isCustomEntry<TurnRecord>(entry, TURN_ENTRY)) continue;
      const data = entry.data;
      if (data?.version === 1 && data.beforeCommit && data.afterCommit && data.userEntryId) return data;
    }
    return undefined;
  }

  private async runExclusive<T>(operation: () => Promise<T>): Promise<T> {
    if (this.busy) throw new Error("Workspace history is already working.");
    this.busy = true;
    this.statusMessage = null;
    try {
      return await operation();
    } catch (error) {
      this.statusMessage = errorMessage(error);
      throw error;
    } finally {
      this.busy = false;
    }
  }

  private sessionRoot(cwd: string, sessionId: string): string {
    const workspaceId = createHash("sha256").update(cwd.toLowerCase()).digest("hex").slice(0, 24);
    return join(this.storageRoot, workspaceId, sessionId);
  }

  private gitDir(cwd: string, sessionId: string): string {
    return join(this.sessionRoot(cwd, sessionId), "repo", ".git");
  }

  private async ensureRepo(cwd: string, sessionId: string): Promise<void> {
    const root = join(this.sessionRoot(cwd, sessionId), "repo");
    const gitDir = join(root, ".git");
    await mkdir(root, { recursive: true });
    try {
      await readFile(join(gitDir, "HEAD"), "utf8");
    } catch {
      await this.execGitRaw(["init", "--initial-branch=main", root], cwd);
      await this.execGit(cwd, sessionId, ["config", "user.name", "pi ecode"]);
      await this.execGit(cwd, sessionId, ["config", "user.email", "workspace-history@local"]);
      await this.execGit(cwd, sessionId, ["config", "core.autocrlf", "false"]);
      await mkdir(join(gitDir, "info"), { recursive: true });
      await writeFile(join(gitDir, "info", "exclude"), `${DEFAULT_EXCLUDES.join("\n")}\n`, "utf8");
    }
  }

  private async snapshot(cwd: string, sessionId: string, label: string): Promise<string> {
    await this.ensureRepo(cwd, sessionId);
    await this.execGit(cwd, sessionId, ["add", "-A", "--", "."]);
    const hasHead = await this.gitSucceeds(cwd, sessionId, ["rev-parse", "--verify", "HEAD"]);
    const changed = !hasHead || !(await this.gitSucceeds(cwd, sessionId, ["diff", "--cached", "--quiet"]));
    if (changed) {
      await this.execGit(cwd, sessionId, ["commit", "--no-gpg-sign", "-m", label]);
    }
    return (await this.execGit(cwd, sessionId, ["rev-parse", "HEAD"])).trim();
  }

  private async assertClean(cwd: string, sessionId: string): Promise<void> {
    await this.ensureRepo(cwd, sessionId);
    const status = await this.execGit(cwd, sessionId, ["status", "--porcelain=v1", "--untracked-files=all"]);
    if (status.trim()) {
      throw new Error("Workspace has changes that are not in history. Create a checkpoint before undo or redo.");
    }
  }

  private async restore(cwd: string, sessionId: string, commit: string): Promise<void> {
    await this.ensureRepo(cwd, sessionId);
    await this.execGit(cwd, sessionId, ["reset", "--hard", commit]);
  }

  private async execGit(cwd: string, sessionId: string, args: string[]): Promise<string> {
    return this.execGitRaw([`--git-dir=${this.gitDir(cwd, sessionId)}`, `--work-tree=${cwd}`, ...args], cwd);
  }

  private async execGitRaw(args: string[], cwd: string): Promise<string> {
    const result = await execFileAsync("git", args, {
      cwd,
      windowsHide: true,
      timeout: 60_000,
      maxBuffer: 10 * 1024 * 1024,
    });
    return result.stdout;
  }

  private async gitSucceeds(cwd: string, sessionId: string, args: string[]): Promise<boolean> {
    try {
      await this.execGit(cwd, sessionId, args);
      return true;
    } catch {
      return false;
    }
  }

  private redoPath(cwd: string, sessionId: string): string {
    return join(this.sessionRoot(cwd, sessionId), "redo.json");
  }

  private async readRedo(cwd: string, sessionId: string): Promise<RedoRecord | undefined> {
    try {
      const parsed: unknown = JSON.parse(await readFile(this.redoPath(cwd, sessionId), "utf8"));
      if (typeof parsed !== "object" || parsed === null) return undefined;
      const record = parsed as Partial<RedoRecord>;
      if (!record.targetEntryId || !record.commit || !record.createdAt) return undefined;
      return record as RedoRecord;
    } catch {
      return undefined;
    }
  }

  private async writeRedo(cwd: string, sessionId: string, record: RedoRecord | undefined): Promise<void> {
    const root = this.sessionRoot(cwd, sessionId);
    await mkdir(root, { recursive: true });
    await writeFile(this.redoPath(cwd, sessionId), record ? JSON.stringify(record, null, 2) : "", "utf8");
  }
}
