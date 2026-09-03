import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TaskPlan } from "@shared/contracts";
import { I18nProvider } from "../i18n/i18n";
import { TaskPlanPanel, TaskPlanPresence } from "./TaskPlanPanel";

const plan: TaskPlan = {
  title: "Ship feature",
  updatedAt: 1,
  items: [
    { id: "done", text: "Done", status: "completed" },
    { id: "active", text: "Active", status: "in_progress" },
    { id: "pending", text: "Pending", status: "pending" },
  ],
};

describe("TaskPlanPanel", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("renders one colored progress segment per task without visible step text", () => {
    vi.stubGlobal("localStorage", { getItem: () => "en", setItem: vi.fn() });
    const markup = renderToStaticMarkup(
      <I18nProvider><TaskPlanPanel plan={plan} active /></I18nProvider>,
    );

    expect(markup.match(/sidebar-task-segment/g)).toHaveLength(3);
    expect(markup).toContain("sidebar-task-segment completed");
    expect(markup).toContain("sidebar-task-segment in_progress current flow-path");
    expect(markup).toContain("sidebar-task-segment pending");
    expect(markup.match(/flow-path/g)).toHaveLength(2);
    expect(markup).toContain("--task-flow-cycle:1900ms");
    expect(markup).toContain("--task-flow-delay:0ms");
    expect(markup).toContain("--task-flow-delay:684ms");
    expect(markup).toContain('class="sidebar-task-flow"');
    expect(markup).toContain('style="width:66.67%"');
    expect(markup).toContain('aria-label="Completed 1/3 steps"');
    expect(markup).not.toContain("Step 2/3");

    const presenceMarkup = renderToStaticMarkup(
      <I18nProvider><TaskPlanPresence plan={plan} active /></I18nProvider>,
    );
    expect(presenceMarkup).toContain('class="sidebar-task-section"');
    expect(presenceMarkup).not.toContain("<button");
  });

  it("stops progress motion when the answer is complete", () => {
    vi.stubGlobal("localStorage", { getItem: () => "en", setItem: vi.fn() });
    const markup = renderToStaticMarkup(
      <I18nProvider><TaskPlanPanel plan={plan} active={false} /></I18nProvider>,
    );
    expect(markup).toContain("sidebar-task-progress idle");
    expect(markup).not.toContain("sidebar-task-flow");
  });

  it("renders nothing before a task plan appears", () => {
    vi.stubGlobal("localStorage", { getItem: () => "en", setItem: vi.fn() });
    const markup = renderToStaticMarkup(
      <I18nProvider><TaskPlanPresence plan={null} active={false} /></I18nProvider>,
    );
    expect(markup).toBe("");
  });
});
