import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import chokidar, { type FSWatcher } from "chokidar";
import { basename, join } from "node:path";
import type {
  ValidationState,
  ValidationStep,
  ValidationStepId,
} from "../../shared/contracts.js";

const MAX_STEP_OUTPUT = 160_000;
const WATCH_IGNORES = new Set([
  ".git",
  ".pi",
  "node_modules",
  "out",
  "dist",
  "build",
  "release",
  "coverage",
  ".cache",
  ".next",
  ".turbo",
]);
const STEP_DEFINITIONS: ReadonlyArray<{ id: ValidationStepId; label: string }> = [
  { id: "typecheck", label: "Type check" },
  { id: "test", label: "Tests" },
  { id: "build", label: "Production build" },
];

interface PackageManifest {
  name?: string;
  scripts?: Record<string, string>;
}

function emptySteps(): ValidationStep[] {
  return STEP_DEFINITIONS.map(({ id, label }) => ({
    id,
    label,
    command: `npm run ${id}`,
    status: "pending",
    output: "",
    exitCode: null,
    durationMs: null,
  }));
}

function emptyState(): ValidationState {
  return {
    supported: false,
    isSelfProject: false,
    status: "idle",
    runId: null,
    activeStep: null,
    steps: emptySteps(),
    verifiedAt: null,
    message: null,
  };
}

function stripTerminalCodes(value: string): string {
  return value.replaceAll(/\u001b\[[0-?]*[ -/]*[@-~]/gu, "");
}

export class ValidationService {
  private cwd: string | undefined;
  private scripts = new Set<string>();
  private state = emptyState();
  private activeProcess: ChildProcessWithoutNullStreams | undefined;
  private cancellationRequested = false;
  private watcher: FSWatcher | undefined;

  constructor(private readonly onChange: (state: ValidationState) => void) {}

  async configure(cwd: string): Promise<void> {
    await this.stop();
    this.watcher?.close();
    this.watcher = undefined;
    this.cwd = cwd;
    let manifest: PackageManifest = {};
    try {
      manifest = JSON.parse(await readFile(join(cwd, "package.json"), "utf8")) as PackageManifest;
    } catch {
      // A non-Node project simply has no supported MVP validation scripts.
    }
    this.scripts = new Set(Object.keys(manifest.scripts ?? {}));
    const steps = emptySteps().map((step) => (
      this.scripts.has(step.id) ? step : { ...step, status: "skipped" as const }
    ));
    this.state = {
      ...emptyState(),
      supported: steps.some((step) => step.status !== "skipped"),
      isSelfProject: manifest.name === "pi-ecode",
      steps,
      message: steps.some((step) => step.status !== "skipped")
        ? null
        : `No validation scripts found in ${basename(cwd)}.`,
    };
    this.publish();
    await this.startWatcher(cwd);
  }

  getState(): ValidationState {
    return structuredClone(this.state);
  }

  invalidate(message = "Source changed after the last verification."): void {
    if (this.state.status === "running" || this.state.status === "idle" || this.state.status === "stale") return;
    this.state = { ...this.state, status: "stale", verifiedAt: null, message };
    this.publish();
  }

  async run(): Promise<ValidationState> {
    if (!this.cwd) throw new Error("Choose a project before running validation.");
    if (!this.state.supported) throw new Error("This project has no typecheck, test, or build scripts.");
    if (this.state.status === "running") throw new Error("Validation is already running.");

    this.cancellationRequested = false;
    this.state = {
      ...this.state,
      status: "running",
      runId: randomUUID(),
      activeStep: null,
      verifiedAt: null,
      message: null,
      steps: emptySteps().map((step) => (
        this.scripts.has(step.id) ? step : { ...step, status: "skipped" as const }
      )),
    };
    this.publish();

    let infrastructureError: string | undefined;
    try {
      for (const definition of STEP_DEFINITIONS) {
        if (!this.scripts.has(definition.id)) continue;
        if (this.cancellationRequested) break;
        const exitCode = await this.runStep(definition.id);
        if (this.cancellationRequested || exitCode !== 0) break;
      }
    } catch (error) {
      infrastructureError = error instanceof Error ? error.message : String(error);
      if (this.state.activeStep) {
        const current = this.state.steps.find((step) => step.id === this.state.activeStep);
        this.updateStep(this.state.activeStep, {
          status: "failed",
          output: `${current?.output ?? ""}\n${infrastructureError}`.trim(),
        });
      }
    }

    const failedStep = this.state.steps.find((step) => step.status === "failed");
    const status = this.cancellationRequested ? "cancelled" : failedStep || infrastructureError ? "failed" : "passed";
    if (status === "passed") {
      await this.watcher?.close();
      this.watcher = undefined;
      await this.startWatcher(this.cwd);
    }
    this.state = {
      ...this.state,
      status,
      activeStep: null,
      verifiedAt: status === "passed" ? Date.now() : null,
      message: status === "passed"
        ? "All configured checks passed."
        : status === "cancelled"
          ? "Validation stopped."
          : infrastructureError ?? `${failedStep?.label ?? "Validation"} failed.`,
    };
    this.publish();
    return this.getState();
  }

  async dispose(): Promise<void> {
    await this.stop();
    this.watcher?.close();
    this.watcher = undefined;
  }

  async stop(): Promise<void> {
    if (!this.activeProcess) return;
    this.cancellationRequested = true;
    const processToStop = this.activeProcess;
    const closed = new Promise<void>((resolve) => processToStop.once("close", () => resolve()));
    if (process.platform === "win32" && processToStop.pid) {
      const killer = spawn("taskkill", ["/pid", String(processToStop.pid), "/t", "/f"], {
        windowsHide: true,
        stdio: "ignore",
      });
      await new Promise<void>((resolve) => killer.once("close", () => resolve()));
    } else {
      processToStop.kill("SIGTERM");
    }
    await closed;
  }

  private async startWatcher(cwd: string): Promise<void> {
    const watcher = chokidar.watch(cwd, {
      ignoreInitial: true,
      usePolling: process.platform === "win32",
      interval: 600,
      ignored: (path) => {
        const relativePath = path.slice(cwd.length).replaceAll("\\", "/").replace(/^\/+/, "");
        const firstSegment = relativePath.split("/")[0];
        return Boolean(firstSegment && WATCH_IGNORES.has(firstSegment));
      },
    });
    this.watcher = watcher;
    watcher.on("all", () => {
      if (this.state.status === "passed") {
        this.invalidate("Project files changed after the last verification.");
      }
    });
    await new Promise<void>((resolve) => {
      watcher.once("ready", () => resolve());
      watcher.once("error", () => resolve());
    });
  }

  private async runStep(id: ValidationStepId): Promise<number | null> {
    const cwd = this.cwd;
    if (!cwd) return null;
    const startedAt = Date.now();
    this.updateStep(id, { status: "running", output: "", exitCode: null, durationMs: null });
    this.state = { ...this.state, activeStep: id };

    const executable = process.platform === "win32" ? (process.env.ComSpec ?? "cmd.exe") : "npm";
    const args = process.platform === "win32"
      ? ["/d", "/s", "/c", `npm run ${id}`]
      : ["run", id];
    const child = spawn(executable, args, {
      cwd,
      env: { ...process.env, NO_COLOR: "1" },
      windowsHide: true,
      stdio: "pipe",
    });
    this.activeProcess = child;
    this.publish();
    const append = (chunk: Buffer): void => {
      const text = stripTerminalCodes(chunk.toString("utf8"));
      const current = this.state.steps.find((step) => step.id === id)?.output ?? "";
      const combined = current + text;
      this.updateStep(id, { output: combined.slice(Math.max(0, combined.length - MAX_STEP_OUTPUT)) });
      this.publish();
    };
    child.stdout.on("data", append);
    child.stderr.on("data", append);

    const exitCode = await new Promise<number | null>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code) => resolve(code));
    }).finally(() => {
      if (this.activeProcess === child) this.activeProcess = undefined;
    });
    this.updateStep(id, {
      status: this.cancellationRequested ? "cancelled" : exitCode === 0 ? "passed" : "failed",
      exitCode,
      durationMs: Date.now() - startedAt,
    });
    this.publish();
    return exitCode;
  }

  private updateStep(id: ValidationStepId, patch: Partial<ValidationStep>): void {
    this.state = {
      ...this.state,
      steps: this.state.steps.map((step) => step.id === id ? { ...step, ...patch } : step),
    };
  }

  private publish(): void {
    this.onChange(this.getState());
  }
}
