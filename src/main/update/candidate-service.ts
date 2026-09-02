import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { cp, mkdir, readFile, readdir, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { app } from "electron";
import type { CandidateState, UpdateRecord } from "../../shared/contracts.js";

const MAX_RETAINED_CANDIDATES = 3;
const MAX_LEDGER_RECORDS = 30;

interface CandidateMetadata {
  id: string;
  path: string;
  sourceRoot: string;
  preparedAt: number;
}

export const SUPERVISOR_SOURCE = String.raw`
const { spawn } = require("node:child_process");
const { existsSync, writeFileSync } = require("node:fs");
const [candidatePath, fallbackPath, electronPath, healthPath, resultPath, parentPid] = process.argv.slice(2);
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const cleanEnv = () => {
  const env = { ...process.env };
  delete env.ELECTRON_RENDERER_URL;
  delete env.ELECTRON_RUN_AS_NODE;
  return env;
};
const killTree = async (child) => {
  if (!child || child.exitCode !== null) return;
  if (process.platform === "win32" && child.pid) {
    const killer = spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], { windowsHide: true, stdio: "ignore" });
    await new Promise((resolve) => killer.once("close", resolve));
  } else {
    child.kill("SIGTERM");
  }
};
const sourceRootFor = (target) => {
  try {
    return JSON.parse(require("node:fs").readFileSync(require("node:path").join(target, "package.json"), "utf8")).piEcodeSourceRoot;
  } catch { return undefined; }
};
const launch = (target, extraEnv = {}, detached = false) => spawn(electronPath, [target], {
  env: { ...cleanEnv(), ...(sourceRootFor(target) ? { PI_ECODE_SOURCE_ROOT: sourceRootFor(target) } : {}), ...extraEnv },
  detached,
  windowsHide: false,
  stdio: "ignore",
});
(async () => {
  await delay(900);
  const candidate = launch(candidatePath, { PI_ECODE_HEALTH_FILE: healthPath });
  let exited = false;
  candidate.once("exit", () => { exited = true; });
  const deadline = Date.now() + 25_000;
  while (!exited && Date.now() < deadline && !existsSync(healthPath)) await delay(250);
  if (existsSync(healthPath) && !exited) {
    writeFileSync(resultPath, JSON.stringify({ status: "active", at: Date.now(), parentPid }), "utf8");
    candidate.unref();
    process.exit(0);
  }
  await killTree(candidate);
  writeFileSync(resultPath, JSON.stringify({ status: "failed", at: Date.now(), parentPid }), "utf8");
  const fallback = launch(fallbackPath, { PI_ECODE_RECOVERED: "1" }, true);
  fallback.unref();
  process.exit(1);
})().catch(() => process.exit(2));
`;

function idleState(history: UpdateRecord[] = []): CandidateState {
  return {
    status: "idle",
    candidateId: null,
    candidatePath: null,
    preparedAt: null,
    message: null,
    history,
  };
}

export class CandidateService {
  private sourceRoot: string | undefined;
  private currentRuntimePath: string | undefined;
  private readonly recoveredAtStartup = process.env.PI_ECODE_RECOVERED === "1";
  private ledger: UpdateRecord[] = [];
  private state = idleState();

  constructor(
    private readonly updateRoot: string,
    private readonly onChange: (state: CandidateState) => void,
  ) {}

  async initialize(): Promise<void> {
    await mkdir(this.updateRoot, { recursive: true });
    this.ledger = await this.readLedger();
    await this.reconcileSupervisorResults();
    if (process.env.PI_ECODE_HEALTH_FILE) {
      this.currentRuntimePath = app.getAppPath();
    } else {
      const stablePath = join(this.updateRoot, "stable");
      await this.stageRuntime(app.getAppPath(), stablePath);
      this.currentRuntimePath = stablePath;
    }
  }

  async discoverSourceRoot(): Promise<string | undefined> {
    const fromEnvironment = process.env.PI_ECODE_SOURCE_ROOT?.trim();
    if (fromEnvironment) return resolve(fromEnvironment);
    try {
      const manifest = JSON.parse(await readFile(join(app.getAppPath(), "package.json"), "utf8")) as {
        name?: string;
        piEcodeSourceRoot?: string;
      };
      if (manifest.piEcodeSourceRoot) return resolve(manifest.piEcodeSourceRoot);
      if (manifest.name === "pi-ecode") {
        await readFile(join(app.getAppPath(), "src", "main", "index.ts"), "utf8");
        return resolve(app.getAppPath());
      }
    } catch {
      return undefined;
    }
    return undefined;
  }

  configure(sourceRoot: string): void {
    this.sourceRoot = resolve(sourceRoot);
    this.state = this.recoveredAtStartup
      ? { ...idleState(this.ledger), status: "failed", message: "The candidate failed its health check. Previous runtime restored." }
      : idleState(this.ledger);
    this.publish();
  }

  getState(): CandidateState {
    return { ...this.state, history: this.state.history.map((record) => ({ ...record })) };
  }

  invalidate(message = "Source changed after the candidate was prepared."): void {
    if (this.state.status !== "ready") return;
    this.state = { ...idleState(this.ledger), message };
    this.publish();
  }

  async prepare(): Promise<CandidateState> {
    if (!this.sourceRoot) throw new Error("Open the pi-ecode source project before preparing an update.");
    if (app.isPackaged) throw new Error("Candidate activation currently requires an unpackaged development runtime.");
    this.state = { ...idleState(this.ledger), status: "preparing", message: "Staging verified build…" };
    this.publish();
    try {
      if (!this.currentRuntimePath) throw new Error("The current runtime fallback is not initialized.");
      const id = `${Date.now()}-${randomUUID().slice(0, 8)}`;
      const candidatePath = join(this.updateRoot, "candidates", id);
      await this.stageRuntime(this.sourceRoot, candidatePath);
      const metadata: CandidateMetadata = {
        id,
        path: candidatePath,
        sourceRoot: this.sourceRoot,
        preparedAt: Date.now(),
      };
      await writeFile(join(candidatePath, "candidate.json"), JSON.stringify(metadata, null, 2), "utf8");
      await this.upsertRecord({
        id,
        status: "prepared",
        path: candidatePath,
        sourceRoot: this.sourceRoot,
        preparedAt: metadata.preparedAt,
        updatedAt: metadata.preparedAt,
        message: null,
      });
      await this.cleanupCandidates(new Set([candidatePath, this.currentRuntimePath]));
      this.state = {
        status: "ready",
        candidateId: id,
        candidatePath,
        preparedAt: metadata.preparedAt,
        message: "Candidate is staged and ready for a guarded restart.",
        history: this.ledger,
      };
      this.publish();
      return this.getState();
    } catch (error) {
      this.state = {
        ...idleState(this.ledger),
        status: "failed",
        message: error instanceof Error ? error.message : String(error),
      };
      this.publish();
      throw error;
    }
  }

  async activate(): Promise<void> {
    if (this.state.status !== "ready" || !this.state.candidatePath || !this.state.candidateId || !this.currentRuntimePath) {
      throw new Error("Prepare a verified candidate before restarting.");
    }
    const candidatePath = this.state.candidatePath;
    const fallbackPath = this.currentRuntimePath;
    const supervisorPath = join(this.updateRoot, "supervisor.cjs");
    const healthPath = join(this.updateRoot, `health-${this.state.candidateId}.json`);
    const resultPath = join(this.updateRoot, `result-${this.state.candidateId}.json`);
    await Promise.all([
      writeFile(supervisorPath, SUPERVISOR_SOURCE, "utf8"),
      rm(healthPath, { force: true }),
      rm(resultPath, { force: true }),
    ]);
    await this.upsertRecord({
      id: this.state.candidateId,
      status: "activating",
      path: candidatePath,
      sourceRoot: this.sourceRoot ?? "",
      preparedAt: this.state.preparedAt ?? Date.now(),
      updatedAt: Date.now(),
      message: null,
    });
    const env = { ...process.env, ELECTRON_RUN_AS_NODE: "1" };
    const supervisor = spawn(process.execPath, [
      supervisorPath,
      candidatePath,
      fallbackPath,
      process.execPath,
      healthPath,
      resultPath,
      String(process.pid),
    ], {
      env,
      detached: true,
      windowsHide: true,
      stdio: "ignore",
    });
    supervisor.unref();
    this.state = { ...this.state, status: "activating", message: "Restarting into candidate…", history: this.ledger };
    this.publish();
    setTimeout(() => app.quit(), 250);
  }

  async rendererReady(): Promise<void> {
    const healthPath = process.env.PI_ECODE_HEALTH_FILE;
    if (!healthPath) return;
    await writeFile(healthPath, JSON.stringify({
      status: "healthy",
      pid: process.pid,
      at: Date.now(),
      appPath: app.getAppPath(),
    }, null, 2), "utf8");
    setTimeout(() => {
      void this.reconcileSupervisorResults().then(() => {
        this.state = { ...this.state, history: this.ledger };
        this.publish();
      });
    }, 1_000);
  }

  private ledgerPath(): string {
    return join(this.updateRoot, "ledger.json");
  }

  private async readLedger(): Promise<UpdateRecord[]> {
    try {
      const parsed: unknown = JSON.parse(await readFile(this.ledgerPath(), "utf8"));
      if (!Array.isArray(parsed)) return [];
      return parsed.filter((item): item is UpdateRecord => (
        typeof item === "object" && item !== null &&
        "id" in item && typeof item.id === "string" &&
        "status" in item && typeof item.status === "string" &&
        "path" in item && typeof item.path === "string" &&
        "sourceRoot" in item && typeof item.sourceRoot === "string" &&
        "preparedAt" in item && typeof item.preparedAt === "number" &&
        "updatedAt" in item && typeof item.updatedAt === "number"
      )).slice(0, MAX_LEDGER_RECORDS);
    } catch {
      return [];
    }
  }

  private async writeLedger(): Promise<void> {
    const temporaryPath = `${this.ledgerPath()}.tmp-${process.pid}`;
    await writeFile(temporaryPath, JSON.stringify(this.ledger.slice(0, MAX_LEDGER_RECORDS), null, 2), "utf8");
    await rename(temporaryPath, this.ledgerPath());
  }

  private async upsertRecord(record: UpdateRecord): Promise<void> {
    this.ledger = [record, ...this.ledger.filter((item) => item.id !== record.id)].slice(0, MAX_LEDGER_RECORDS);
    await this.writeLedger();
  }

  private async reconcileSupervisorResults(): Promise<void> {
    let names: string[] = [];
    try {
      names = await readdir(this.updateRoot);
    } catch {
      return;
    }
    let changed = false;
    for (const name of names.filter((item) => item.startsWith("result-") && item.endsWith(".json"))) {
      const id = name.slice("result-".length, -".json".length);
      const existing = this.ledger.find((record) => record.id === id);
      if (!existing) continue;
      try {
        const result = JSON.parse(await readFile(join(this.updateRoot, name), "utf8")) as { status?: string; at?: number };
        const status = result.status === "active" ? "active" : result.status === "failed" ? "failed" : undefined;
        if (!status || (existing.status === status && existing.updatedAt === result.at)) continue;
        this.ledger = this.ledger.map((record) => record.id === id ? {
          ...record,
          status,
          updatedAt: result.at ?? Date.now(),
          message: status === "failed" ? "Candidate failed health check; previous runtime restored." : null,
        } : record);
        changed = true;
      } catch {
        // An incomplete result file is ignored until the next startup.
      }
    }
    if (changed) await this.writeLedger();
  }

  private async cleanupCandidates(protectedPaths: Set<string | undefined>): Promise<void> {
    const candidates = this.ledger
      .filter((record) => record.status !== "discarded" && record.status !== "activating" && !protectedPaths.has(record.path))
      .sort((left, right) => right.preparedAt - left.preparedAt);
    const stale = candidates.slice(MAX_RETAINED_CANDIDATES - 1);
    if (stale.length === 0) return;
    const staleIds = new Set(stale.map((record) => record.id));
    await Promise.all(stale.map((record) => rm(record.path, { recursive: true, force: true })));
    this.ledger = this.ledger.map((record) => staleIds.has(record.id) ? {
      ...record,
      status: "discarded",
      updatedAt: Date.now(),
      message: "Candidate artifacts removed by retention policy.",
    } : record);
    await this.writeLedger();
  }

  private async stageRuntime(sourceRoot: string, targetRoot: string): Promise<void> {
    if (resolve(sourceRoot) === resolve(targetRoot)) return;
    const sourceOut = join(sourceRoot, "out");
    const sourceModules = await realpath(join(sourceRoot, "node_modules"));
    await readFile(join(sourceOut, "main", "index.js"), "utf8");
    await readFile(join(sourceOut, "renderer", "index.html"), "utf8");
    await rm(targetRoot, { recursive: true, force: true });
    await mkdir(targetRoot, { recursive: true });
    await cp(sourceOut, join(targetRoot, "out"), { recursive: true });
    await symlink(sourceModules, join(targetRoot, "node_modules"), "junction");
    await writeFile(join(targetRoot, "package.json"), JSON.stringify({
      name: "pi-ecode",
      version: "0.1.0-candidate",
      private: true,
      type: "module",
      main: "out/main/index.js",
      piEcodeSourceRoot: sourceRoot,
    }, null, 2), "utf8");
  }

  private publish(): void {
    this.onChange(this.getState());
  }
}
