import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { SessionWorkspaceRegistry } from "./session-workspaces.js";

const execute = promisify(execFile);

describe("session workspaces", () => {
  it("creates independent worktrees from HEAD and restores their ledger without touching dirty source files", async () => {
    const project = await mkdtemp(join(tmpdir(), "pi-ecode-worktree-source-"));
    const storage = await mkdtemp(join(tmpdir(), "pi-ecode-worktree-store-"));
    const worktrees: string[] = [];
    try {
      await execute("git", ["init"], { cwd: project });
      await writeFile(join(project, "source.txt"), "committed");
      await execute("git", ["add", "source.txt"], { cwd: project });
      await execute("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "fixture"], { cwd: project });
      await writeFile(join(project, "source.txt"), "original dirty change");
      const registry = new SessionWorkspaceRegistry(storage);
      await registry.configure(project);
      expect(registry.canCreate).toBe(true);
      const first = await registry.create();
      worktrees.push(first);
      await writeFile(join(first, "source.txt"), "first session change");
      const second = await registry.create();
      worktrees.push(second);
      expect(await readFile(join(second, "source.txt"), "utf8")).toBe("committed");
      expect(await readFile(join(first, "source.txt"), "utf8")).toBe("first session change");
      expect(await readFile(join(project, "source.txt"), "utf8")).toBe("original dirty change");
      const restored = new SessionWorkspaceRegistry(storage);
      await restored.configure(project);
      expect(restored.current.map((entry) => entry.cwd)).toEqual(worktrees);
      const ledger = join(dirname(first), "ledger.json");
      await writeFile(ledger, "damaged ledger");
      await expect(restored.configure(project)).rejects.toThrow();
      expect(restored.canCreate).toBe(false);
      expect(restored.current).toEqual([]);
      expect(await readFile(ledger, "utf8")).toBe("damaged ledger");
    } finally {
      for (const path of worktrees) await execute("git", ["worktree", "remove", "--force", path], { cwd: project });
      await rm(project, { recursive: true, force: true });
      await rm(storage, { recursive: true, force: true });
    }
  });

  it("keeps non-Git projects in single-session mode", async () => {
    const project = await mkdtemp(join(tmpdir(), "pi-ecode-non-git-"));
    const storage = await mkdtemp(join(tmpdir(), "pi-ecode-non-git-store-"));
    try {
      const registry = new SessionWorkspaceRegistry(storage);
      await registry.configure(project);
      expect(registry.canCreate).toBe(false);
      await expect(registry.create()).rejects.toThrow("非 Git 项目");
    } finally { await rm(project, { recursive: true, force: true }); await rm(storage, { recursive: true, force: true }); }
  });
});
