import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../i18n/i18n";
import { Sidebar } from "./Sidebar";

describe("Sidebar", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("offers deletion only for inactive sessions", () => {
    vi.stubGlobal("localStorage", { getItem: () => "en", setItem: vi.fn() });
    const markup = renderToStaticMarkup(
      <I18nProvider>
        <Sidebar
          projectName="demo"
          projectPath="C:/demo"
          sessions={[
            { path: "active.jsonl", id: "active", title: "Active", modifiedAt: 2, messageCount: 1 },
            { path: "inactive.jsonl", id: "inactive", title: "Inactive", modifiedAt: 1, messageCount: 1 },
          ]}
          activeSessionFile="active.jsonl"
          disabled={false}
          taskPlan={null}
          settingsActive={false}
          onChooseProject={vi.fn()}
          onNewSession={vi.fn()}
          onSwitchSession={vi.fn()}
          onDeleteSession={vi.fn()}
          onOpenSettings={vi.fn()}
          onCollapse={vi.fn()}
        />
      </I18nProvider>,
    );

    expect(markup.match(/aria-label="Delete conversation"/g)).toHaveLength(1);
    expect(markup).toContain('class="session-row active"');
  });
});
