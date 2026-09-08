import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TaskPlan } from "@shared/contracts";
import { I18nProvider } from "../i18n/i18n";
import { centeredTaskScrollTop, taskItemTopWithinList, TaskPlanPanel, TaskPlanPresence } from "./TaskPlanPanel";

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

  it("renders one water drop path from the previous completed task to the current task", () => {
    vi.stubGlobal("localStorage", { getItem: () => "en", setItem: vi.fn() });
    const markup = renderToStaticMarkup(
      <I18nProvider><TaskPlanPanel plan={plan} active /></I18nProvider>,
    );

    expect(markup.match(/sidebar-task-marker/g)).toHaveLength(3);
    expect(markup.match(/sidebar-task-node/g)).toHaveLength(3);
    expect(markup.match(/sidebar-task-rail/g)).toHaveLength(2);
    expect(markup).toContain("sidebar-task-marker completed drop-source");
    expect(markup).toContain("sidebar-task-marker in_progress current");
    expect(markup).toContain("sidebar-task-marker pending");
    expect(markup.match(/drop-source/g)).toHaveLength(1);
    expect(markup).not.toContain("flow-path");
    expect(markup).not.toContain("--task-flow");
    expect(markup).toContain('aria-label="Completed 1/3 steps"');
    expect(markup).not.toContain("sidebar-task-progress");
    expect(markup).not.toContain("<svg");
    expect(markup).not.toContain("Step 2/3");

    const presenceMarkup = renderToStaticMarkup(
      <I18nProvider><TaskPlanPresence plan={plan} active /></I18nProvider>,
    );
    expect(presenceMarkup).toContain('class="sidebar-task-section"');
    expect(presenceMarkup).not.toContain("<button");
  });

  it("keeps the current task centered using coordinates relative to the scroll list", () => {
    expect(taskItemTopWithinList(546.5, 500, 0)).toBe(46.5);
    expect(taskItemTopWithinList(546.5, 500, 69)).toBe(115.5);
    expect(centeredTaskScrollTop(46.5, 23, 116, 230)).toBe(0);
    expect(centeredTaskScrollTop(115, 23, 116, 230)).toBe(68.5);
    expect(centeredTaskScrollTop(207, 23, 116, 230)).toBe(114);
    expect(centeredTaskScrollTop(0, 23, 116, 100)).toBe(0);
  });

  it("marks boundary current tasks for top and bottom alignment", () => {
    vi.stubGlobal("localStorage", { getItem: () => "en", setItem: vi.fn() });
    const firstCurrent = { ...plan, items: plan.items.map((item, index) => ({ ...item, status: index === 0 ? "in_progress" as const : "pending" as const })) };
    const lastCurrent = { ...plan, items: plan.items.map((item, index) => ({ ...item, status: index < 2 ? "completed" as const : "in_progress" as const })) };

    const firstMarkup = renderToStaticMarkup(<I18nProvider><TaskPlanPanel plan={firstCurrent} active /></I18nProvider>);
    const lastMarkup = renderToStaticMarkup(<I18nProvider><TaskPlanPanel plan={lastCurrent} active /></I18nProvider>);

    expect(firstMarkup).toContain("sidebar-task-items has-current current-first");
    expect(lastMarkup).toContain("sidebar-task-items has-current current-last");
  });

  it("marks a completed plan for compact bottom alignment", () => {
    vi.stubGlobal("localStorage", { getItem: () => "en", setItem: vi.fn() });
    const completedPlan: TaskPlan = {
      ...plan,
      items: plan.items.map((item) => ({ ...item, status: "completed" })),
    };
    const markup = renderToStaticMarkup(
      <I18nProvider><TaskPlanPanel plan={completedPlan} active /></I18nProvider>,
    );

    expect(markup).toContain("sidebar-task-items all-completed");
    expect(markup).not.toContain(" current");
    expect(markup).not.toContain("drop-source");
  });

  it("stops the water drop when the plan is inactive", () => {
    vi.stubGlobal("localStorage", { getItem: () => "en", setItem: vi.fn() });
    const markup = renderToStaticMarkup(
      <I18nProvider><TaskPlanPanel plan={plan} active={false} /></I18nProvider>,
    );
    expect(markup).toContain("sidebar-task-timeline idle");
    expect(markup).not.toContain("drop-source");
  });

  it("does not add a water drop without a completed predecessor", () => {
    vi.stubGlobal("localStorage", { getItem: () => "en", setItem: vi.fn() });
    const noPredecessorPlan: TaskPlan = {
      ...plan,
      items: [
        { id: "pending", text: "Pending", status: "pending" },
        { id: "active", text: "Active", status: "in_progress" },
      ],
    };
    const markup = renderToStaticMarkup(
      <I18nProvider><TaskPlanPanel plan={noPredecessorPlan} active /></I18nProvider>,
    );
    expect(markup).not.toContain("drop-source");
  });

  it("renders nothing before a task plan appears", () => {
    vi.stubGlobal("localStorage", { getItem: () => "en", setItem: vi.fn() });
    const markup = renderToStaticMarkup(
      <I18nProvider><TaskPlanPresence plan={null} active={false} /></I18nProvider>,
    );
    expect(markup).toBe("");
  });
});
