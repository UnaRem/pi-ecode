import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProjectAgentCatalog } from "@shared/agent-contracts";
import type { ExplorerTask } from "@shared/contracts";
import { I18nProvider } from "../i18n/i18n";
import { ExplorerPanel } from "./ExplorerPanel";
import { ExplorerContextBar } from "./ExplorerContextBar";

function task(patch: Partial<ExplorerTask> = {}): ExplorerTask {
  return {
    id: "explorer-1",
    taskName: "inspect_child",
    title: "Inspect child session data",
    objective: "Inspect runtime",
    scope: "src/main/agent/",
    deliverable: "Evidence",
    status: "running",
    originToolCallId: "dispatch-1",
    thinkingLevel: "low",
    attempt: 1,
    maxAttempts: 2,
    revision: 3,
    queuedAt: 1,
    startedAt: Date.now() - 20_000,
    lastActivityAt: Date.now(),
    activity: "ffgrep · AgentSession",
    ...patch,
  };
}

const catalog: ProjectAgentCatalog = {
  version: 1,
  projectPath: "C:/workspace",
  maxConcurrent: 3,
  updatedAt: 1,
  agents: [{
    id: "explorer-1",
    name: "探索者 1",
    role: "explorer",
    builtIn: true,
    enabled: true,
    model: { mode: "inherit" },
    thinkingLevel: "high",
    autoCompaction: { enabled: true, thresholdPercent: null },
    prompt: "只读",
    disabledTools: [],
    createdAt: 1,
    updatedAt: 1,
  }],
};

describe("ExplorerPanel", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("shows counts, live activity, thinking level, attempt and a stop action", () => {
    vi.stubGlobal("localStorage", { getItem: () => "en", setItem: vi.fn() });
    const markup = renderToStaticMarkup(
      <I18nProvider>
        <ExplorerPanel tasks={[task(), task({ id: "done", status: "completed", endedAt: Date.now() })]} selectedTaskId="explorer-1" onSelect={vi.fn()} onStop={vi.fn()} />
      </I18nProvider>,
    );

    expect(markup).toContain("1 active · 0 queued · 1 completed");
    expect(markup).toContain("ffgrep · AgentSession");
    expect(markup).toContain("Thinking: low");
    expect(markup).toContain("Attempt 1/2");
    expect(markup).toContain("Stop Explorer: Inspect child session data");
  });

  it("labels a task with no activity for more than one minute", () => {
    vi.stubGlobal("localStorage", { getItem: () => "en", setItem: vi.fn() });
    const markup = renderToStaticMarkup(
      <I18nProvider>
        <ExplorerPanel tasks={[task({ lastActivityAt: Date.now() - 61_000 })]} selectedTaskId={null} onSelect={vi.fn()} onStop={vi.fn()} />
      </I18nProvider>,
    );
    expect(markup).toContain("Extended period without activity");
  });

  it("renders a focused read-only context bar with a return action", () => {
    vi.stubGlobal("localStorage", { getItem: () => "en", setItem: vi.fn() });
    const markup = renderToStaticMarkup(
      <I18nProvider><ExplorerContextBar task={task()} onReturn={vi.fn()} /></I18nProvider>,
    );
    expect(markup).toContain("Read-only Explorer transcript");
    expect(markup).toContain("Return to main conversation");
  });

  it("keeps the configured agent visible and nests task history under it", () => {
    vi.stubGlobal("localStorage", { getItem: () => "zh-CN", setItem: vi.fn() });
    const historyTask = task({
      id: "task-1",
      taskName: "inspect_context",
      title: "核查上下文",
      status: "completed",
      agentId: "explorer-1",
      sessionId: "child-session-1",
      endedAt: 2,
    });
    const markup = renderToStaticMarkup(
      <I18nProvider>
        <ExplorerPanel
          tasks={[historyTask]}
          agentCatalog={catalog}
          selectedTaskId={null}
          onSelect={vi.fn()}
          onStop={vi.fn()}
        />
      </I18nProvider>,
    );
    expect(markup).toContain("探索者 1");
    expect(markup).toContain("长期会话");
    expect(markup).toContain("历史任务");
    expect(markup).toContain("核查上下文");
  });
});
