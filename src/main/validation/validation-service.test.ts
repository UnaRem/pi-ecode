import { mkdtemp, rm, writeFile } from "node:fs/promises";
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

  it("marks unavailable scripts as skipped", async () => {
    const cwd = await project({ scripts: { test: "node -e \"process.exit(0)\"" } });
    const service = new ValidationService(() => undefined);
    await service.configure(cwd);

    expect(service.getState().supported).toBe(true);
    expect(service.getState().steps.map((step) => step.status)).toEqual(["skipped", "pending", "skipped"]);
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
