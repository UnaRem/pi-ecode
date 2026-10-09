import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ManagedProcess } from "../../shared/process-contracts.js";
import { ManagedProcessService } from "./managed-process-service.js";

const directories: string[] = [];
const services: ManagedProcessService[] = [];

async function fixture(script: string) {
  const root = await mkdtemp(join(tmpdir(), "pi-ecode-managed-process-"));
  directories.push(root);
  await writeFile(join(root, "process.cjs"), script, "utf8");
  await writeFile(join(root, "idle.cjs"), "setInterval(()=>{},1000);", "utf8");
  const updates: ManagedProcess[][] = [];
  const service = new ManagedProcessService((records) => updates.push(records));
  services.push(service);
  await service.configure(root);
  return { root, service, updates, request: { command: "node process.cjs", projectPath: root, sessionId: "session", originToolCallId: "tool" } };
}

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw error;
  }
}

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  try {
    const results = await Promise.allSettled(services.splice(0).map((service) => service.dispose()));
    const failed = results.find((result) => result.status === "rejected");
    if (failed?.status === "rejected") throw failed.reason;
  } finally {
    await Promise.all(directories.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  }
});

describe("ManagedProcessService", () => {
  it("启动返回后持续输出 stdout/stderr，克隆状态并合并重复停止", async () => {
    const test = await fixture("console.error('stderr-ready'); setInterval(() => console.log('tick'), 40);");
    const record = await test.service.start(test.request);
    expect(record.status).toBe("running");
    expect(record.pid).toBeTypeOf("number");
    await vi.waitFor(() => expect(test.service.current[0]?.output).toContain("stderr-ready"), { timeout: 5_000 });
    await vi.waitFor(() => expect(test.service.current[0]?.output.split("tick").length).toBeGreaterThan(2), { timeout: 5_000 });
    const snapshot = test.service.current;
    snapshot[0]!.output = "tampered";
    expect(test.service.current[0]!.output).not.toBe("tampered");
    const first = test.service.stop(record.id);
    expect(test.service.stop(record.id)).toBe(first);
    await first;
    expect(test.service.current[0]).toMatchObject({ status: "stopped", endedAt: expect.any(Number) });
    await test.service.stop(record.id);
    expect(test.updates.at(-1)?.[0]?.status).toBe("stopped");
  });

  it("停止真实子进程树并保持并行会话的进程归属", async () => {
    const test = await fixture("const {spawn}=require('node:child_process'); const fs=require('node:fs'); const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'}); fs.writeFileSync('child.pid',String(child.pid)); setInterval(()=>{},1000);");
    const first = await test.service.start(test.request);
    await vi.waitFor(async () => expect(Number(await readFile(join(test.root, "child.pid"), "utf8"))).toBeGreaterThan(0), { timeout: 5_000 });
    const childPid = Number(await readFile(join(test.root, "child.pid"), "utf8"));
    const second = await test.service.start({ ...test.request, command: "node idle.cjs", sessionId: "other-session", originToolCallId: "other-tool" });
    expect(alive(childPid)).toBe(true);
    await test.service.stop(first.id);
    await vi.waitFor(() => expect(alive(childPid)).toBe(false), { timeout: 5_000 });
    expect(test.service.current.find((record) => record.id === second.id)).toMatchObject({ status: "running", sessionId: "other-session", originToolCallId: "other-tool", projectPath: test.root });
    expect(alive(second.pid!)).toBe(true);
    await test.service.stop(second.id);
  });

  it("同项目配置保留进程，切换先停止旧进程并拒绝旧或未知 id", async () => {
    const test = await fixture("setInterval(()=>{},1000);");
    const record = await test.service.start(test.request);
    await test.service.configure(test.root);
    expect(test.service.current[0]?.id).toBe(record.id);
    const next = await mkdtemp(join(tmpdir(), "pi-ecode-managed-next-"));
    directories.push(next);
    await test.service.configure(next);
    expect(alive(record.pid!)).toBe(false);
    expect(test.service.current).toEqual([]);
    await expect(test.service.stop(record.id)).rejects.toThrow("Unknown managed process id");
    await expect(test.service.stop("unknown")).rejects.toThrow("Unknown managed process id");
    await expect(test.service.start(test.request)).rejects.toThrow("different project");
  });

  it("并发启动与切换不漏管进程，dispose 后拒绝启动", async () => {
    const test = await fixture("setInterval(()=>{},1000);");
    const next = await mkdtemp(join(tmpdir(), "pi-ecode-managed-race-"));
    directories.push(next);
    const started = test.service.start(test.request);
    const switched = test.service.configure(next);
    const late = test.service.start(test.request);
    const rejection = expect(late).rejects.toThrow("different project");
    const record = await started;
    await switched;
    await rejection;
    expect(alive(record.pid!)).toBe(false);
    expect(test.service.current).toEqual([]);
    await writeFile(join(next, "idle.cjs"), "setInterval(()=>{},1000);", "utf8");
    const running = await test.service.start({ ...test.request, projectPath: next, command: "node idle.cjs" });
    await test.service.dispose();
    expect(alive(running.pid!)).toBe(false);
    await expect(test.service.start({ ...test.request, projectPath: next })).rejects.toThrow("disposed");
  });

  it.each([0, 7])("自然或异常退出以真实 close 为准：%s", async (code) => {
    const test = await fixture(`console.log('final-output'); process.exit(${code});`);
    const record = await test.service.start(test.request);
    await vi.waitFor(() => expect(test.service.current[0]?.endedAt).not.toBeNull(), { timeout: 5_000 });
    expect(test.service.current[0]).toMatchObject({ status: code === 0 ? "exited" : "error", exitCode: code, output: expect.stringContaining("final-output") });
    expect(test.updates.at(-1)?.[0]?.endedAt).not.toBeNull();
    await test.service.stop(record.id);
  });

  it("日志有界且明确截断，保留最新 stderr", async () => {
    const test = await fixture("process.stdout.write('x'.repeat(180000),()=>{process.stderr.write('tail-marker');});");
    await test.service.start(test.request);
    await vi.waitFor(() => expect(test.service.current[0]?.endedAt).not.toBeNull(), { timeout: 5_000 });
    expect(test.service.current[0]).toMatchObject({ outputTruncated: true, status: "exited" });
    expect(test.service.current[0]!.output.length).toBe(160_000);
    expect(test.service.current[0]!.output).toContain("tail-marker");
  });

  it("spawn 错误拒绝启动并记录真实结束，不留下活动进程", async () => {
    const test = await fixture("setInterval(()=>{},1000);");
    await rm(test.root, { recursive: true, force: true });
    await expect(test.service.start(test.request)).rejects.toThrow();
    await vi.waitFor(() => expect(test.service.current[0]?.endedAt).not.toBeNull(), { timeout: 5_000 });
    expect(test.service.current[0]).toMatchObject({ status: "error", pid: null, errorMessage: expect.any(String) });
  });

  it.skipIf(process.platform !== "win32")("taskkill 启动失败报告错误且不假称进程已停止，可恢复后重试", async () => {
    const test = await fixture("setInterval(()=>{},1000);");
    const record = await test.service.start(test.request);
    try {
      vi.stubEnv("SystemRoot", join(test.root, "missing-system"));
      await expect(test.service.stop(record.id)).rejects.toThrow();
      expect(test.service.current[0]).toMatchObject({ status: "running", endedAt: null, errorMessage: expect.any(String) });
      expect(alive(record.pid!)).toBe(true);
    } finally {
      vi.unstubAllEnvs();
      await test.service.stop(record.id);
    }
    expect(test.service.current[0]).toMatchObject({ status: "stopped", endedAt: expect.any(Number), errorMessage: null });
  });

  it.skipIf(process.platform !== "win32").each([0, 7])("停止失败期间自然 close 保留真实终态：%s", async (code) => {
    const test = await fixture(`const fs=require('node:fs'); setInterval(()=>{if(fs.existsSync('exit-now'))process.exit(${code});},20); console.log('ready');`);
    const record = await test.service.start(test.request);
    await vi.waitFor(() => expect(test.service.current[0]?.output).toContain("ready"), { timeout: 5_000 });
    const internals = test.service as unknown as { killWindowsTree: (pid: number) => Promise<void> };
    // 只控制停止命令的失败时点，目标进程与 close 仍由真实脚本产生。
    vi.spyOn(internals, "killWindowsTree").mockImplementationOnce(async () => {
      await writeFile(join(test.root, "exit-now"), "exit", "utf8");
      await vi.waitFor(() => expect(test.service.current[0]?.endedAt).not.toBeNull(), { timeout: 5_000 });
      throw new Error("taskkill failed after natural close");
    });
    await expect(test.service.stop(record.id)).resolves.toBeUndefined();
    expect(test.service.current[0]).toMatchObject({ status: code === 0 ? "exited" : "error", exitCode: code, endedAt: expect.any(Number) });
    expect(test.service.current[0]?.errorMessage ?? "").not.toContain("taskkill");
  });

  it("真实彩色输出变成纯文本，设置 NO_COLOR 并保留 UTF-8 日志", async () => {
    const test = await fixture("console.log('NO_COLOR='+process.env.NO_COLOR); process.stdout.write('\\x1b[31m彩色正文\\x1b[0m\\n'); process.stderr.write('\\x1b[2K错误正文\\n'); setInterval(()=>{},1000);");
    const record = await test.service.start(test.request);
    await vi.waitFor(() => expect(test.service.current[0]?.output).toContain("错误正文"), { timeout: 5_000 });
    expect(test.service.current[0]?.output).toContain("NO_COLOR=1");
    expect(test.service.current[0]?.output).toContain("彩色正文");
    expect(test.service.current[0]?.output).not.toContain("\u001b");
    expect(test.service.current[0]?.output).not.toContain("�");
    await test.service.stop(record.id);
  });

  it("已退出记录仅保留最近 32 条", async () => {
    const test = await fixture("process.exit(0);");
    for (let index = 0; index < 34; index += 1) {
      const record = await test.service.start(test.request);
      await vi.waitFor(() => expect(test.service.current.find((item) => item.id === record.id)?.endedAt).not.toBeNull(), { timeout: 5_000 });
    }
    expect(test.service.current).toHaveLength(32);
  }, 30_000);
});
