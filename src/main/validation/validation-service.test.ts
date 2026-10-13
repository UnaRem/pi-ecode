import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ValidationState } from "../../shared/contracts.js";
import { ValidationService } from "./validation-service.js";

const temporaryPaths: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function project(manifest: object): Promise<string> {
  const cwd = await mkdtemp(join(tmpdir(), "pi-ecode-validation-"));
  temporaryPaths.push(cwd);
  await writeFile(join(cwd, "package.json"), JSON.stringify(manifest), "utf8");
  return cwd;
}

describe("ValidationService", () => {
  it("runs the fixed self-hosting pipeline in order", async () => {
    const cwd = await project({
      name: "pi-ecode",
      scripts: {
        typecheck: "node -e \"console.log('types ok')\"",
        test: "node -e \"console.log('tests ok')\"",
        build: "node -e \"console.log('build ok')\"",
      },
    });
    const updates: ValidationState[] = [];
    const service = new ValidationService((state) => updates.push(state));
    await service.configure(cwd);
    const result = await service.run();

    expect(result.isSelfProject).toBe(true);
    expect(result.status).toBe("passed");
    expect(result.steps.map((step) => step.status)).toEqual(["passed", "passed", "passed"]);
    expect(result.steps.map((step) => step.output)).toEqual([
      expect.stringContaining("types ok"),
      expect.stringContaining("tests ok"),
      expect.stringContaining("build ok"),
    ]);
    expect(updates.some((state) => state.activeStep === "test")).toBe(true);

    service.invalidate();
    expect(service.getState().status).toBe("stale");
    expect(service.getState().verifiedAt).toBeNull();
    await service.dispose();
  });

  it("uses Bun's package script runner and resets to npm for the next project", async () => {
    const cwd = await project({ packageManager: "bun@1.3.14", scripts: {
      typecheck: "node -e \"console.log('bun types ok')\"",
      test: "node -e \"console.log('existing test script')\"",
      build: "node -e \"console.log('bun build ok')\"",
    } });
    const service = new ValidationService(() => undefined);
    try {
      await service.configure(cwd);
      const result = await service.run();
      expect(result.status).toBe("passed");
      expect(result.steps.map((step) => step.command)).toEqual(["bun run typecheck", "bun run test", "bun run build"]);
      expect(result.steps[1]?.output).toContain("existing test script");
      const npmProject = await project({ packageManager: "npm@11", scripts: { test: "node -e \"console.log('npm ok')\"" } });
      await service.configure(npmProject);
      const npmResult = await service.run();
      expect(npmResult.status).toBe("passed");
      expect(npmResult.steps[1]?.command).toBe("npm run test");
      expect(npmResult.steps[1]?.output).toContain("npm ok");
    } finally { await service.dispose(); }
  });

  it("does not execute an arbitrary packageManager value", async () => {
    const cwd = await project({ packageManager: "arbitrary-command", scripts: { test: "node -e \"process.exit(0)\"" } });
    const service = new ValidationService(() => undefined);
    try {
      await service.configure(cwd);
      expect((await service.run()).status).toBe("passed");
      expect(service.getState().steps[1]?.command).toBe("npm run test");
    } finally { await service.dispose(); }
  });

  it("binds a passed result to the verified source revision", async () => {
    const cwd = await project({ scripts: { typecheck: "node -e \"process.exit(0)\"" } });
    const service = new ValidationService(() => undefined);
    await service.configure(cwd);

    const result = await service.run({ sourceRevision: "tree-a", readSourceRevision: async () => "tree-a" });

    expect(result.status).toBe("passed");
    expect(result.sourceRevision).toBe("tree-a");
    await service.dispose();
  });

  it("ignores TypeScript build metadata written during validation", async () => {
    const cwd = await project({
      scripts: { typecheck: "node -e \"require('node:fs').writeFileSync('tsconfig.node.tsbuildinfo', 'cache')\"" },
    });
    const service = new ValidationService(() => undefined);
    await service.configure(cwd);

    const result = await service.run({ sourceRevision: "tree-a", readSourceRevision: async () => "tree-a" });

    expect(result.status).toBe("passed");
    await service.dispose();
  });

  it("marks a successful pipeline stale when the source revision changes", async () => {
    const cwd = await project({ scripts: { typecheck: "node -e \"process.exit(0)\"" } });
    const service = new ValidationService(() => undefined);
    await service.configure(cwd);

    const result = await service.run({ sourceRevision: "tree-a", readSourceRevision: async () => "tree-b" });

    expect(result.status).toBe("stale");
    expect(result.sourceRevision).toBeNull();
    expect(result.verifiedAt).toBeNull();
    await service.dispose();
  });

  it("remains stale when source changes and later returns to the same revision", async () => {
    const cwd = await project({ scripts: { typecheck: "node -e \"setTimeout(() => {}, 150)\"" } });
    let invalidated = false;
    const service = new ValidationService((state) => {
      if (!invalidated && state.activeStep === "typecheck") {
        invalidated = true;
        service.invalidate();
      }
    });
    await service.configure(cwd);

    const result = await service.run({ sourceRevision: "tree-a", readSourceRevision: async () => "tree-a" });

    expect(result.status).toBe("stale");
    await service.dispose();
  });

  it("stops after the first failed check", async () => {
    const cwd = await project({
      scripts: {
        typecheck: "node -e \"console.error('type failure'); process.exit(2)\"",
        test: "node -e \"console.log('should not run')\"",
        build: "node -e \"console.log('should not run')\"",
      },
    });
    const service = new ValidationService(() => undefined);
    await service.configure(cwd);
    const result = await service.run();

    expect(result.status).toBe("failed");
    expect(result.steps[0]).toMatchObject({ status: "failed", exitCode: 2 });
    expect(result.steps[0]?.output).toContain("type failure");
    expect(result.steps[1]?.status).toBe("pending");
    expect(result.steps[2]?.status).toBe("pending");
    await service.dispose();
  });

  it("stops an active validation process tree", async () => {
    const cwd = await project({
      scripts: { typecheck: "node -e \"setTimeout(() => {}, 10000)\"" },
    });
    let markRunning: (() => void) | undefined;
    const running = new Promise<void>((resolve) => { markRunning = resolve; });
    const service = new ValidationService((state) => {
      if (state.activeStep === "typecheck") markRunning?.();
    });
    await service.configure(cwd);
    const resultPromise = service.run();
    await running;
    await service.stop();
    const result = await resultPromise;

    expect(result.status).toBe("cancelled");
    expect(result.steps[0]?.status).toBe("cancelled");
    await service.dispose();
  });

  it("honors cancellation requested between validation steps", async () => {
    const cwd = await project({
      scripts: {
        typecheck: "node -e \"process.exit(0)\"",
        test: "node -e \"console.log('should not run')\"",
      },
    });
    let stopRequested = false;
    const service = new ValidationService((state) => {
      if (!stopRequested && state.steps[0]?.status === "passed") {
        stopRequested = true;
        void service.stop();
      }
    });
    await service.configure(cwd);

    const result = await service.run();

    expect(result.status).toBe("cancelled");
    expect(result.steps[1]?.status).toBe("pending");
    await service.dispose();
  });

  it("marks unavailable scripts as skipped", async () => {
    const cwd = await project({ scripts: { test: "node -e \"process.exit(0)\"" } });
    const service = new ValidationService(() => undefined);
    await service.configure(cwd);

    expect(service.getState().supported).toBe(true);
    expect(service.getState().steps.map((step) => step.status)).toEqual(["skipped", "pending", "skipped"]);
    await service.dispose();
  });

  it("keeps a passed result when only the CodeGraph index changes", async () => {
    const cwd = await project({ scripts: { typecheck: "node -e \"process.exit(0)\"" } });
    const service = new ValidationService(() => undefined);
    await service.configure(cwd);
    await service.run();
    expect(service.getState().status).toBe("passed");

    await mkdir(join(cwd, ".codegraph"), { recursive: true });
    await writeFile(join(cwd, ".codegraph", "codegraph.db"), "index\n", "utf8");
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    expect(service.getState().status).toBe("passed");

    // watcher 仍然在监视真实源码：证明上面的 passed 不是 watcher 失效导致的假阳性。
    await writeFile(join(cwd, "changed.ts"), "export {};\n", "utf8");
    await vi.waitFor(() => expect(service.getState().status).toBe("stale"), { timeout: 2_000 });
    await service.dispose();
  });

  it("剪枝子包依赖树，依赖变化保留通过结果而同包源码变化使结果过期", async () => {
    const cwd = await project({ scripts: { typecheck: "node -e \"process.exit(0)\"" } });
    const packageRoot = join(cwd, "packages", "app");
    const dependencyRoot = join(packageRoot, "node_modules", "dependency");
    const sourcePath = join(packageRoot, "source.ts");
    await mkdir(dependencyRoot, { recursive: true });
    await writeFile(join(dependencyRoot, "index.js"), "original dependency\n", "utf8");
    await writeFile(sourcePath, "export const original = true;\n", "utf8");
    const service = new ValidationService(() => undefined);
    try {
      await service.configure(cwd);
      expect((await service.run()).status).toBe("passed");
      // getWatched 来自真实 chokidar watcher；确认依赖目录在 ready 前已剪枝。
      const { watcher } = service as unknown as { watcher: { getWatched: () => Record<string, string[]> } };
      const watched = watcher.getWatched();
      expect(Object.keys(watched).some((path) => path.replaceAll("\\", "/").split("/").includes("node_modules"))).toBe(false);
      expect(watched[packageRoot]).toContain("source.ts");

      await writeFile(join(dependencyRoot, "index.js"), "changed dependency\n", "utf8");
      await new Promise((resolve) => setTimeout(resolve, 1_500));
      expect(service.getState().status).toBe("passed");

      await writeFile(sourcePath, "export const changed = true;\n", "utf8");
      await vi.waitFor(() => expect(service.getState().status).toBe("stale"), { timeout: 2_000 });
    } finally {
      await service.dispose();
    }
  });

  it("ignores a CodeGraph index written while validation runs", async () => {
    const cwd = await project({
      scripts: {
        typecheck:
          "node -e \"require('node:fs').mkdirSync('.codegraph', { recursive: true });"
          + " require('node:fs').writeFileSync('.codegraph/codegraph.db', 'index')\"",
      },
    });
    const service = new ValidationService(() => undefined);
    await service.configure(cwd);

    const result = await service.run({ sourceRevision: "tree-a", readSourceRevision: async () => "tree-a" });

    expect(result.status).toBe("passed");
    expect(service.getState().status).toBe("passed");
    expect(result.sourceRevision).toBe("tree-a");
    await service.dispose();
  });

  it("marks a passed result stale after an external file change", async () => {
    const cwd = await project({ scripts: { typecheck: "node -e \"process.exit(0)\"" } });
    const service = new ValidationService(() => undefined);
    await service.configure(cwd);
    await service.run();
    expect(service.getState().status).toBe("passed");

    await writeFile(join(cwd, "changed.ts"), "export {};\n", "utf8");
    await vi.waitFor(() => expect(service.getState().status).toBe("stale"), { timeout: 2_000 });
    await service.dispose();
  });
});
