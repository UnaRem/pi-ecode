import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readProjectProfile } from "./project-profile.js";

describe("local project profile", () => {
  it("derives recommendations from the current project's documents and manifest", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-ecode-profile-"));
    try {
      await Promise.all([
        writeFile(join(cwd, "README.md"), "Local sessions with MCP integration."),
        writeFile(join(cwd, "AGENTS.md"), "Workspace checkpoints support undo and redo."),
        writeFile(join(cwd, "package.json"), JSON.stringify({
          description: "A local desktop client", dependencies: { electron: "44", react: "19" },
          devDependencies: { typescript: "5", vitest: "4" }, scripts: { test: "vitest run" },
        })),
      ]);
      expect(await readProjectProfile(cwd)).toEqual({
        description: "A local desktop client", technologies: ["electron", "react", "typescript", "vitest"],
        features: ["sessions", "mcp", "history"], hasTests: true,
      });
    } finally { await rm(cwd, { recursive: true, force: true }); }
  });

  it("bounds optional document reads and supports projects without metadata", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-ecode-profile-limit-"));
    try {
      expect(await readProjectProfile(cwd)).toEqual({ description: null, technologies: [], features: [], hasTests: false });
      await writeFile(join(cwd, "README.md"), `${" ".repeat(16 * 1024)}MCP sessions checkpoints`);
      await writeFile(join(cwd, "package.json"), "incomplete JSON");
      expect((await readProjectProfile(cwd)).features).toEqual([]);
    } finally { await rm(cwd, { recursive: true, force: true }); }
  });
});
