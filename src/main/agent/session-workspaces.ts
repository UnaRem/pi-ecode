import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, realpath, rename, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { promisify } from "node:util";

const executeFile = promisify(execFile);
export interface SessionWorkspace { id: string; relativePath: string; baseCommit: string }
type GitRunner = (cwd: string, args: string[]) => Promise<string>;

const runGit: GitRunner = async (cwd, args) => {
  const result = await executeFile("git", args, { cwd, windowsHide: true, timeout: 60_000,
    maxBuffer: 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
  return result.stdout.trim();
};

function validWorkspace(value: unknown): value is SessionWorkspace {
  if (!value || typeof value !== "object") return false;
  const entry = value as Record<string, unknown>;
  return typeof entry.id === "string" && /^[0-9a-f-]{36}$/u.test(entry.id)
    && typeof entry.baseCommit === "string" && /^[0-9a-f]{40,64}$/u.test(entry.baseCommit)
    && typeof entry.relativePath === "string" && !isAbsolute(entry.relativePath)
    && !entry.relativePath.split(/[\\/]/u).includes("..");
}

export class SessionWorkspaceRegistry {
  private projectPath: string | undefined;
  private directory: string | undefined;
  private entries: SessionWorkspace[] = [];
  private supported = false;

  get canCreate(): boolean { return this.supported; }

  constructor(private readonly storageRoot: string, private readonly execute: GitRunner = runGit) {}

  get current(): Array<SessionWorkspace & { cwd: string }> {
    return this.entries.map((entry) => ({ ...entry, cwd: join(this.directory!, entry.id, entry.relativePath) }));
  }

  async configure(projectPath: string): Promise<void> {
    // A failed project change must never reuse the preceding project's worktree registry.
    this.projectPath = undefined;
    this.directory = undefined;
    this.entries = [];
    this.supported = false;
    const project = await realpath(resolve(projectPath));
    const workspaceKey = createHash("sha256").update(process.platform === "win32" ? project.toLowerCase() : project).digest("hex");
    const directory = join(this.storageRoot, workspaceKey);
    let entries: SessionWorkspace[] = [];
    try {
      const parsed: unknown = JSON.parse(await readFile(join(directory, "ledger.json"), "utf8"));
      if (!parsed || typeof parsed !== "object") throw new Error("Invalid session workspace ledger.");
      const ledger = parsed as { version?: unknown; workspaces?: unknown };
      if (ledger.version !== 1 || !Array.isArray(ledger.workspaces) || !ledger.workspaces.every(validWorkspace)) throw new Error("Invalid session workspace ledger.");
      entries = ledger.workspaces;
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    const supported = await this.execute(project, ["rev-parse", "--verify", "HEAD"]).then(() => true, (error: unknown) => {
      if (/not a git repository|unknown revision|ambiguous argument.*HEAD|Needed a single revision/iu.test(String(error))) return false;
      throw error;
    });
    this.projectPath = project;
    this.supported = supported;
    this.directory = directory;
    this.entries = entries;
  }

  async create(): Promise<string> {
    if (!this.projectPath || !this.directory) throw new Error("No project selected.");
    const root = await this.execute(this.projectPath, ["rev-parse", "--show-toplevel"]).catch((error: unknown) => {
      if (/not a git repository/iu.test(String(error))) throw new Error("非 Git 项目保持单会话执行，无法创建独立工作目录。");
      throw error;
    });
    const baseCommit = await this.execute(this.projectPath, ["rev-parse", "HEAD"]);
    const relativePath = relative(await realpath(root), this.projectPath);
    if (isAbsolute(relativePath) || relativePath.split(/[\\/]/u).includes("..")) throw new Error("Selected project is outside its Git worktree.");
    const entry = { id: randomUUID(), relativePath, baseCommit };
    const worktreePath = join(this.directory, entry.id);
    await mkdir(dirname(worktreePath), { recursive: true });
    await this.execute(this.projectPath, ["worktree", "add", "--detach", "--", worktreePath, baseCommit]);
    this.entries.push(entry);
    // Retain the worktree on any later failure: it may already contain session-owned changes.
    const ledger = join(this.directory, "ledger.json");
    await writeFile(`${ledger}.tmp`, JSON.stringify({ version: 1, workspaces: this.entries }), "utf8");
    await rename(`${ledger}.tmp`, ledger);
    return join(worktreePath, relativePath);
  }
}
