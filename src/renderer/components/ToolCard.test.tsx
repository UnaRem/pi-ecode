import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../i18n/i18n";
import { ToolCard } from "./ToolCard";

describe("ToolCard", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("uses one visible status icon and keeps status text screen-reader only", () => {
    vi.stubGlobal("localStorage", { getItem: () => "en", setItem: vi.fn() });
    const markup = renderToStaticMarkup(
      <I18nProvider>
        <ToolCard tool={{
          id: "tool-1",
          name: "edit",
          title: "edit · src/main/index.ts",
          input: "",
          output: "Updated file",
          status: "success",
        }} selected onSelect={vi.fn()} />
      </I18nProvider>,
    );

    expect(markup).toMatch(/^<button type="button" class="tool-card/);
    expect(markup.match(/<button/g)).toHaveLength(1);
    expect(markup).toContain("Updated file");
    expect(markup).toContain('class="tool-status"');
    expect(markup).toContain('class="sr-only">Done</span>');
    expect(markup).toContain('aria-pressed="true"');
    expect(markup).toContain("tool-panel-icon");
    expect(markup).not.toContain('aria-expanded=');
    expect(markup).not.toContain("tool-detail");
    expect(markup).not.toContain("<small>");
  });
});
