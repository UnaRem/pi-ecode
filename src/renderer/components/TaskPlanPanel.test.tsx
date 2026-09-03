import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TaskPlan } from "@shared/contracts";
import { I18nProvider } from "../i18n/i18n";
import { TaskPlanPanel } from "./TaskPlanPanel";

describe("TaskPlanPanel", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("renders one colored progress segment per task without visible step text", () => {
    vi.stubGlobal("localStorage", { getItem: () => "en", setItem: vi.fn() });
    const plan: TaskPlan = {
      title: "Ship feature",
      updatedAt: 1,
      items: [
        { id: "done", text: "Done", status: "completed" },
        { id: "active", text: "Active", status: "in_progress" },
        { id: "pending", text: "Pending", status: "pending" },
      ],
    };

    const markup = renderToStaticMarkup(
      <I18nProvider><TaskPlanPanel plan={plan} /></I18nProvider>,
    );

    expect(markup.match(/sidebar-task-segment/g)).toHaveLength(3);
    expect(markup).toContain("sidebar-task-segment completed");
    expect(markup).toContain("sidebar-task-segment in_progress");
    expect(markup).toContain("sidebar-task-segment pending");
    expect(markup).toContain('aria-label="Completed 1/3 steps"');
    expect(markup).not.toContain("Step 2/3");
  });
});
