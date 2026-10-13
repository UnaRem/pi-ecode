import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";

export interface SessionWorkspace { id: string; relativePath: string; baseCommit: string }

function validWorkspace(value: unknown): value is SessionWorkspace {
  if (!value || typeof value !== "object") return false;
  const entry = value as Record<string, unknown>;
  return typeof entry.id === "string" && /^[0-9a-f-]{36}$/u.test(entry.id)
    && typeof entry.baseCommit === "string" && /^[0-9a-f]{40,64}$/u.test(entry.baseCommit)
    && typeof entry.relativePath === "string" && !isAbsolute(entry.relativePath)
    && !entry.relativePath.split(/[\\/]/u).includes("..");
}

// Read the retained ledger only to discover historical conversations; new conversations share the selected cwd.
export class SessionWorkspaceRegistry {
  private directory: string | undefined;
  private entries: SessionWorkspace[] = [];

  constructor(private readonly storageRoot: string) {}

  get current(): Array<SessionWorkspace & { cwd: string }> {
    return this.entries.map((entry) => ({ ...entry, cwd: join(this.directory!, entry.id, entry.relativePath) }));
  }

  async configure(projectPath: string): Promise<void> {
    // A failed project change must never reuse the preceding project's registry.
    this.directory = undefined;
    this.entries = [];
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
    this.directory = directory;
    this.entries = entries;
  }
}
