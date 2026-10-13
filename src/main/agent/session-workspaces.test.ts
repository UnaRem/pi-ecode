import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SessionWorkspaceRegistry } from "./session-workspaces.js";

describe("retained session workspace discovery", () => {
  it("reads the existing ledger without changing either project or retained workspace files", async () => {
    const project = await mkdtemp(join(tmpdir(), "pi-ecode-legacy-source-"));
    const storage = await mkdtemp(join(tmpdir(), "pi-ecode-legacy-store-"));
    try {
      const canonicalProject = await realpath(project);
      const key = createHash("sha256").update(process.platform === "win32" ? canonicalProject.toLowerCase() : canonicalProject).digest("hex");
      const directory = join(storage, key);
      const entry = { id: "62b88312-808d-40aa-9f60-9d8004ebd9cc", relativePath: "", baseCommit: "a".repeat(40) };
      const retained = join(directory, entry.id);
      await mkdir(retained, { recursive: true });
      await writeFile(join(project, "source.txt"), "project changes");
      await writeFile(join(retained, "source.txt"), "retained changes");
      const ledger = join(directory, "ledger.json");
      const contents = JSON.stringify({ version: 1, workspaces: [entry] });
      await writeFile(ledger, contents);
      const registry = new SessionWorkspaceRegistry(storage);
      await registry.configure(project);
      expect(registry.current).toEqual([{ ...entry, cwd: retained }]);
      expect(await readFile(join(project, "source.txt"), "utf8")).toBe("project changes");
      expect(await readFile(join(retained, "source.txt"), "utf8")).toBe("retained changes");
      expect(await readFile(ledger, "utf8")).toBe(contents);
      expect((await readdir(directory)).sort()).toEqual([entry.id, "ledger.json"].sort());
      await writeFile(ledger, "damaged ledger");
      await expect(registry.configure(project)).rejects.toThrow(SyntaxError);
      expect(registry.current).toEqual([]);
      expect(await readFile(ledger, "utf8")).toBe("damaged ledger");
    } finally {
      await rm(project, { recursive: true, force: true });
      await rm(storage, { recursive: true, force: true });
    }
  });

  it.each([false, true])("supports an unregistered project without requiring Git HEAD (git metadata: %s)", async (hasGitDirectory) => {
    const project = await mkdtemp(join(tmpdir(), "pi-ecode-no-head-"));
    const storage = await mkdtemp(join(tmpdir(), "pi-ecode-no-head-store-"));
    try {
      if (hasGitDirectory) await mkdir(join(project, ".git"));
      const registry = new SessionWorkspaceRegistry(storage);
      await registry.configure(project);
      expect(registry.current).toEqual([]);
      expect(await readdir(storage)).toEqual([]);
    } finally {
      await rm(project, { recursive: true, force: true });
      await rm(storage, { recursive: true, force: true });
    }
  });
});
