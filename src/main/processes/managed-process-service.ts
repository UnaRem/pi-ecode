import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { isAbsolute, join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import type { ManagedProcess, StartManagedProcessRequest } from "../../shared/process-contracts.js";

const MAX_OUTPUT = 160_000;
const MAX_EXITED = 32;
const PUBLISH_INTERVAL = 33;

interface ProcessEntry {
  record: ManagedProcess;
  child: ChildProcess;
  closed: Promise<void>;
  didClose: boolean;
}

export class ManagedProcessService {
  private projectPath: string | null = null;
  private readonly entries = new Map<string, ProcessEntry>();
  private readonly stops = new Map<string, Promise<void>>();
  private operations: Promise<unknown> = Promise.resolve();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private disposed = false;

  constructor(private readonly onChange: (processes: ManagedProcess[]) => void) {}

  get current(): ManagedProcess[] {
    return structuredClone([...this.entries.values()].map((entry) => entry.record));
  }

  configure(projectPath: string): Promise<void> {
    return this.serialize(async () => {
      if (this.disposed) throw new Error("Managed process service is disposed.");
      if (!isAbsolute(projectPath)) throw new Error("Project path must be absolute.");
      if (this.projectPath === projectPath) return;
      await this.stopAll();
      this.entries.clear();
      this.projectPath = projectPath;
      this.publish();
    });
  }

  start(request: StartManagedProcessRequest): Promise<ManagedProcess> {
    request = { ...request };
    return this.serialize(async () => {
      if (this.disposed) throw new Error("Managed process service is disposed.");
      if (!this.projectPath || request.projectPath !== this.projectPath) throw new Error("Managed process belongs to a different project.");
      if (!request.command.trim() || !request.sessionId || !request.originToolCallId) throw new Error("Managed process request is incomplete.");
      return this.spawnProcess(request);
    });
  }

  stop(processId: string): Promise<void> {
    const existing = this.stops.get(processId);
    if (existing) return existing;
    const operation = this.serialize(async () => {
      const entry = this.entries.get(processId);
      if (!entry || entry.record.projectPath !== this.projectPath) throw new Error("Unknown managed process id.");
      await this.stopEntry(entry);
    });
    this.stops.set(processId, operation);
    void operation.finally(() => this.stops.delete(processId)).catch(() => undefined);
    return operation;
  }

  dispose(): Promise<void> {
    return this.serialize(async () => {
      await this.stopAll();
      this.disposed = true;
      this.publish();
    });
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    // 启动与项目切换串行，切换不能遗漏尚未登记或正在 spawn 的进程。
    const next = this.operations.then(operation);
    this.operations = next.catch(() => undefined);
    return next;
  }

  private async spawnProcess(request: StartManagedProcessRequest): Promise<ManagedProcess> {
    const windows = process.platform === "win32";
    const child = spawn(windows ? (process.env.ComSpec ?? "cmd.exe") : "/bin/sh",
      windows ? ["/d", "/s", "/c", request.command] : ["-c", request.command],
      { cwd: request.projectPath, env: { ...process.env, NO_COLOR: "1" }, windowsHide: true, detached: !windows, stdio: ["ignore", "pipe", "pipe"] });
    const record: ManagedProcess = { ...request, id: randomUUID(), status: "starting", pid: null,
      startedAt: Date.now(), endedAt: null, exitCode: null, signal: null, output: "", outputTruncated: false, errorMessage: null };
    let markClosed = (): void => undefined;
    const entry: ProcessEntry = { record, child, didClose: false, closed: new Promise<void>((resolve) => { markClosed = resolve; }) };
    this.entries.set(record.id, entry);
    const stdoutDecoder = new StringDecoder("utf8");
    const stderrDecoder = new StringDecoder("utf8");
    // 输出块可能切在 UTF-8 字符中间，分别解码两个流避免日志出现替换字符。
    child.stdout?.on("data", (chunk: Buffer) => this.appendOutput(entry, stdoutDecoder.write(chunk)));
    child.stderr?.on("data", (chunk: Buffer) => this.appendOutput(entry, stderrDecoder.write(chunk)));
    child.on("error", (error) => {
      record.status = "error";
      record.errorMessage = error.message;
      this.publish();
    });
    child.once("close", (code, signal) => {
      this.appendOutput(entry, stdoutDecoder.end() + stderrDecoder.end());
      entry.didClose = true;
      record.endedAt = Date.now();
      record.exitCode = code;
      record.signal = signal;
      const processError = record.status === "error" ? record.errorMessage : null;
      // close 先记录真实退出；停止命令成功后才确认 stopped，旧停止错误不污染自然退出。
      record.status = processError || code !== 0 ? "error" : "exited";
      record.errorMessage = processError ?? (code === 0 ? null : `Process exited with code ${code}, signal ${signal}.`);
      markClosed();
      this.pruneExited();
      this.publish();
    });
    this.publish();
    try {
      await new Promise<void>((resolve, reject) => {
        child.once("spawn", () => { record.pid = child.pid ?? null; record.status = "running"; resolve(); });
        child.once("error", reject);
      });
    } catch (error) {
      // 失败启动也等待真实 close，串行队列随后切项目时不会看到半清理的记录。
      await entry.closed;
      throw error;
    }
    this.publish();
    return structuredClone(record);
  }

  private appendOutput(entry: ProcessEntry, text: string): void {
    if (!text) return;
    // 与固定验证一致剥离 CSI 控制序列，先合并以处理跨输出块的完整序列。
    const combined = (entry.record.output + text).replaceAll(/\u001b\[[0-?]*[ -/]*[@-~]/gu, "");
    entry.record.outputTruncated ||= combined.length > MAX_OUTPUT;
    entry.record.output = combined.slice(-MAX_OUTPUT);
    if (!this.timer) this.timer = setTimeout(() => { this.timer = undefined; this.publish(); }, PUBLISH_INTERVAL);
  }

  private async stopEntry(entry: ProcessEntry): Promise<void> {
    if (entry.didClose) return;
    const pid = entry.record.pid;
    if (!pid) throw new Error("Managed process has no registered pid.");
    entry.record.status = "stopping";
    entry.record.errorMessage = null;
    this.publish();
    try {
      if (process.platform === "win32") await this.killWindowsTree(pid);
      else {
        // 独立进程组确保 shell 与其子进程一起终止；不接受调用方提供的 pid。
        try { process.kill(-pid, "SIGKILL"); } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
        }
      }
      await entry.closed;
      entry.record.status = "stopped";
      entry.record.errorMessage = null;
      this.publish();
    } catch (error) {
      // taskkill 执行期间可能自然退出：不能覆盖 close 的终态，也无需再报停止失败。
      if (entry.didClose) return;
      entry.record.status = "running";
      entry.record.errorMessage = error instanceof Error ? error.message : String(error);
      this.publish();
      throw error;
    }
  }

  private async killWindowsTree(pid: number): Promise<void> {
    const root = process.env.SystemRoot ?? "C:\\Windows";
    if (!isAbsolute(root)) throw new Error("Windows system root must be absolute.");
    const killer = spawn(join(root, "System32", "taskkill.exe"), ["/pid", String(pid), "/t", "/f"],
      { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    killer.stdout.on("data", (chunk: Buffer) => { output = (output + chunk.toString()).slice(-MAX_OUTPUT); });
    killer.stderr.on("data", (chunk: Buffer) => { output = (output + chunk.toString()).slice(-MAX_OUTPUT); });
    await new Promise<void>((resolve, reject) => {
      killer.once("error", reject);
      killer.once("close", (code) => code === 0 ? resolve() : reject(new Error(`taskkill failed (${code}): ${output}`)));
    });
  }

  private async stopAll(): Promise<void> {
    const results = await Promise.allSettled([...this.entries.values()].map((entry) => this.stopEntry(entry)));
    const failures = results.filter((result): result is PromiseRejectedResult => result.status === "rejected");
    if (failures.length) throw new AggregateError(failures.map((failure) => failure.reason), "Managed process cleanup failed.");
  }

  private pruneExited(): void {
    const exited = [...this.entries.values()].filter((entry) => entry.didClose);
    for (const entry of exited.slice(0, Math.max(0, exited.length - MAX_EXITED))) this.entries.delete(entry.record.id);
  }

  private publish(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.onChange(this.current);
  }
}
