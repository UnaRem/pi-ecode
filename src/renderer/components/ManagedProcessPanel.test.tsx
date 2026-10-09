import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ManagedProcess, ManagedProcessStatus } from "@shared/process-contracts";
import { I18nProvider } from "../i18n/i18n";
import { ManagedProcessPanel } from "./ManagedProcessPanel";

function processRecord(overrides: Partial<ManagedProcess> = {}): ManagedProcess {
  return {
    id: "dev-1", command: "npm run dev", status: "running", pid: 123,
    projectPath: "C:/workspace", sessionId: "session-1", originToolCallId: "tool-1",
    startedAt: 1, endedAt: null, exitCode: null, signal: null,
    output: "server ready", outputTruncated: false, errorMessage: null, ...overrides,
  };
}

function render(processes: ManagedProcess[], language = "en") {
  vi.stubGlobal("localStorage", { getItem: () => language, setItem: vi.fn() });
  return renderToStaticMarkup(<I18nProvider><ManagedProcessPanel processes={processes} onStop={vi.fn(async () => undefined)} /></I18nProvider>);
}

describe("ManagedProcessPanel", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("shows a localized empty state without stop controls", () => {
    const markup = render([], "zh-CN");
    expect(markup).toContain("开发进程");
    expect(markup).toContain("尚无开发进程。");
    expect(markup).not.toContain("<button");
    expect(markup).not.toContain('role="region"');
  });

  it("selects the latest active process even when a newer record has ended", () => {
    const markup = render([
      processRecord({ id: "old", startedAt: 1, output: "old log" }),
      processRecord({ id: "new", startedAt: 3, status: "exited", output: "ended log" }),
      processRecord({ id: "active", startedAt: 2, command: "npm run watch", output: "active log" }),
    ]);
    expect(markup).toContain('aria-pressed="true" title="npm run watch"');
    expect(markup).toContain("active log</pre>");
    expect(markup).not.toContain("old log");
    expect(markup).not.toContain("ended log");
    expect(markup).toContain('role="region" aria-label="Process logs: npm run watch" tabindex="0"');
    expect(markup).toContain("data-scroll-follow");
    expect(markup).not.toContain("entering");
  });

  it("selects the latest record when all processes have ended", () => {
    const markup = render([
      processRecord({ id: "new", startedAt: 2, status: "error", output: "new log", errorMessage: "spawn failed" }),
      processRecord({ status: "stopped", output: "old log" }),
    ]);
    expect(markup).toContain("new log</pre>");
    expect(markup).not.toContain("old log");
    expect(markup).toContain('role="alert">spawn failed');
  });

  it.each<[ManagedProcessStatus, string, boolean]>([
    ["starting", "Starting", false], ["running", "Running", false],
    ["stopping", "Stopping", true], ["stopped", "Stopped", true],
    ["exited", "Exited", true], ["error", "Failed", true],
  ])("renders %s and its stop eligibility", (status, label, disabled) => {
    const markup = render([processRecord({ status })]);
    expect(markup).toContain(`<span>${label}</span>`);
    expect(markup).toContain("PID 123");
    expect(markup).toContain(disabled ? '<button type="button" disabled="">' : '<button type="button">Stop process');
    if (!disabled) expect(markup).not.toContain('disabled=""');
    if (status === "stopping") expect(markup).toContain("Stopping…</button>");
  });

  it("keeps exit code zero, missing PID, truncation and escaped logs visible", () => {
    const markup = render([processRecord({ status: "exited", pid: null, exitCode: 0, outputTruncated: true, output: "<script>output</script>" })]);
    expect(markup).toContain("PID — · Exit code 0");
    expect(markup).toContain("Earlier output was truncated");
    expect(markup).toContain("&lt;script&gt;output&lt;/script&gt;");
    expect(markup).not.toContain("<script>");
  });

  it("shows the waiting state and translated status in Chinese", () => {
    const markup = render([processRecord({ status: "starting", output: "" })], "zh-CN");
    expect(markup).toContain("正在启动");
    expect(markup).toContain("等待进程输出…");
    expect(markup).toContain("停止进程</button>");
  });
});
