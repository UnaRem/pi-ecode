/// <reference types="node" />
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ToolActivity } from "@shared/contracts";
import { I18nProvider } from "../i18n/i18n";
import { latestUnseenRunningTool, ToolExecutionPanel, ToolExecutionPanelPresence } from "./ToolExecutionPanel";

function tool(id: string, status: ToolActivity["status"] = "success"): ToolActivity {
  return { id, name: "read", title: `read · ${id}.ts`, input: `${id}.ts`, output: `${id} output`, status };
}

describe("ToolExecutionPanel", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("selects the newest running call only once even when its output updates", () => {
    const first = tool("first", "running");
    const latest = tool("latest", "running");
    expect(latestUnseenRunningTool([first, latest], new Set())).toEqual(latest);
    expect(latestUnseenRunningTool([{ ...latest, output: "more" }], new Set(["latest"]))).toBeNull();
  });

  it("uses a full-height side panel and shrinks the whole workspace only on wide screens", () => {
    const stylesheet = readFileSync(new URL("../styles/global.css", import.meta.url), "utf8");
    expect(stylesheet).toMatch(/\.tool-execution-panel\s*\{[^}]*position:\s*fixed;[^}]*top:\s*0;[^}]*right:\s*0;[^}]*bottom:\s*0;/u);
    expect(stylesheet).toContain("@keyframes tool-panel-enter");
    expect(stylesheet).toContain("@keyframes tool-panel-leave");
    expect(stylesheet).toMatch(/@media \(min-width: 1001px\)[\s\S]*?\.app-shell:has\(\.tool-execution-panel:not\(\.leaving\)\) \.workspace\s*\{[^}]*margin-right:\s*var\(--tool-panel-width\)/u);
    expect(stylesheet).not.toContain(".workspace:has(.tool-execution-panel:not(.leaving)) .composer-area");
    expect(stylesheet).toMatch(/\.tool-batch-list\.scrollable,[\s\S]*?\.tool-execution-detail\s*\{[^}]*scrollbar-gutter:\s*stable;/u);
    expect(stylesheet).toMatch(/\*\s*\{[^}]*scrollbar-width:\s*thin;[^}]*scrollbar-color:\s*transparent transparent;/u);
    expect(stylesheet).toContain("[data-scrolling] { scrollbar-color: #8f9994 transparent; }");
    expect(stylesheet).not.toContain("scrollbar-thumb:hover");
    expect(stylesheet).not.toContain("scrollbar-width: none");
  });

  it("reveals new tool cards before showing a category-colored running slider", () => {
    const stylesheet = readFileSync(new URL("../styles/global.css", import.meta.url), "utf8");
    expect(stylesheet).toContain("@keyframes tool-card-enter");
    expect(stylesheet).toMatch(/\.timeline-tool\.entering\s*\{[^}]*animation:\s*tool-card-enter 220ms/u);
    expect(stylesheet).toMatch(/\.tool-card\.running::after\s*\{[^}]*background:\s*var\(--tool-accent\);[^}]*tool-runner-bounce/u);
    expect(stylesheet).not.toContain(".tool-card.selected");
    expect(stylesheet).toMatch(/\.tool-card\s*\{[^}]*height:\s*96px;/u);
    expect(stylesheet).toMatch(/\.tool-batch-list\s*\{[^}]*padding:\s*8px;[^}]*background:\s*var\(--panel-strong\);/u);
    expect(stylesheet).not.toMatch(/\.tool-card\.running\s*\{[^}]*box-shadow:/u);
  });

  it("mounts the presence wrapper only when initially open", () => {
    vi.stubGlobal("localStorage", { getItem: () => "en", setItem: vi.fn() });
    const selected = tool("selected", "running");
    const openMarkup = renderToStaticMarkup(
      <I18nProvider>
        <ToolExecutionPanelPresence open tool={selected} onClose={vi.fn()} />
      </I18nProvider>,
    );
    const closedMarkup = renderToStaticMarkup(
      <I18nProvider>
        <ToolExecutionPanelPresence open={false} tool={null} onClose={vi.fn()} />
      </I18nProvider>,
    );
    const leavingMarkup = renderToStaticMarkup(
      <I18nProvider>
        <ToolExecutionPanel tool={selected} onClose={vi.fn()} leaving />
      </I18nProvider>,
    );
    expect(openMarkup).toContain('class="tool-execution-panel"');
    expect(leavingMarkup).toContain('class="tool-execution-panel leaving"');
    expect(closedMarkup).toBe("");
  });

  it("offers full output loading only for truncated previews", () => {
    vi.stubGlobal("localStorage", { getItem: () => "en", setItem: vi.fn() });
    const selected = { ...tool("selected"), outputTruncated: true, outputLength: 100_000 };
    const markup = renderToStaticMarkup(
      <I18nProvider>
        <ToolExecutionPanel tool={selected} onClose={vi.fn()} />
      </I18nProvider>,
    );
    expect(markup).toContain("Previewing 100000 characters");
    expect(markup).toContain("Load full output");

    const runningMarkup = renderToStaticMarkup(
      <I18nProvider>
        <ToolExecutionPanel tool={{ ...selected, status: "running" }} onClose={vi.fn()} />
      </I18nProvider>,
    );
    expect(runningMarkup).toContain("Previewing 100000 characters");
    expect(runningMarkup).not.toContain("Load full output");
  });

  it("renders selected call details without duplicate turn navigation", () => {
    vi.stubGlobal("localStorage", { getItem: () => "en", setItem: vi.fn() });
    const selected = tool("selected", "running");
    const markup = renderToStaticMarkup(
      <I18nProvider>
        <ToolExecutionPanel tool={selected} onClose={vi.fn()} />
      </I18nProvider>,
    );

    expect(markup).toContain("Tool execution");
    expect(markup).not.toContain("Tool calls in this turn");
    expect(markup).not.toContain('aria-current="true"');
    expect(markup).toContain("selected.ts");
    expect(markup).toContain("selected output");
    expect(markup).toContain("Close tool execution panel");
  });
});
