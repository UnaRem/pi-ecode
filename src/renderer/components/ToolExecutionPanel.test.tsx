/// <reference types="node" />
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ConversationItem, ToolActivity } from "@shared/contracts";
import { I18nProvider } from "../i18n/i18n";
import { latestUnseenRunningTool, ToolExecutionPanel, ToolExecutionPanelPresence, toolsInSelectedTurn } from "./ToolExecutionPanel";

function tool(id: string, status: ToolActivity["status"] = "success"): ToolActivity {
  return { id, name: "read", title: `read · ${id}.ts`, input: `${id}.ts`, output: `${id} output`, status };
}

function item(activity: ToolActivity): ConversationItem {
  return { kind: "tool", id: activity.id, tool: activity };
}

function message(id: string, role: "user" | "assistant"): ConversationItem {
  return { kind: "message", id, message: { id, role, text: id, timestamp: 1 } };
}

describe("ToolExecutionPanel", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("selects the newest running call only once even when its output updates", () => {
    const first = tool("first", "running");
    const latest = tool("latest", "running");
    expect(latestUnseenRunningTool([first, latest], new Set())).toEqual(latest);
    expect(latestUnseenRunningTool([{ ...latest, output: "more" }], new Set(["latest"]))).toBeNull();
  });

  it("lists every tool from the selected user turn but not adjacent turns", () => {
    const first = tool("first");
    const selected = tool("selected", "running");
    const next = tool("next");
    const timeline = [
      message("user-1", "user"), item(first), message("note", "assistant"), item(selected),
      message("user-2", "user"), item(next),
    ];
    expect(toolsInSelectedTurn(timeline, "selected").map((entry) => entry.id)).toEqual(["first", "selected"]);
    expect(toolsInSelectedTurn(timeline, "missing")).toEqual([]);
  });

  it("uses a full-height side panel and shrinks the whole workspace only on wide screens", () => {
    const stylesheet = readFileSync(new URL("../styles/global.css", import.meta.url), "utf8");
    expect(stylesheet).toMatch(/\.tool-execution-panel\s*\{[^}]*position:\s*fixed;[^}]*top:\s*0;[^}]*right:\s*0;[^}]*bottom:\s*0;/u);
    expect(stylesheet).toContain("@keyframes tool-panel-enter");
    expect(stylesheet).toContain("@keyframes tool-panel-leave");
    expect(stylesheet).toMatch(/@media \(min-width: 1001px\)[\s\S]*?\.app-shell:has\(\.tool-execution-panel:not\(\.leaving\)\) \.workspace\s*\{[^}]*margin-right:\s*var\(--tool-panel-width\)/u);
    expect(stylesheet).not.toContain(".workspace:has(.tool-execution-panel:not(.leaving)) .composer-area");
    expect(stylesheet).toMatch(/\.tool-batch-list\.scrollable,[\s\S]*?\.tool-execution-list,[\s\S]*?\.tool-execution-detail\s*\{[^}]*scrollbar-gutter:\s*stable;[^}]*scrollbar-width:\s*thin;/u);
    expect(stylesheet).toMatch(/\.tool-execution-detail::-webkit-scrollbar-thumb:hover\s*\{[^}]*background-color:\s*#8f9994;/u);
  });

  it("reveals new tool cards before showing a category-colored running slider", () => {
    const stylesheet = readFileSync(new URL("../styles/global.css", import.meta.url), "utf8");
    expect(stylesheet).toContain("@keyframes tool-card-enter");
    expect(stylesheet).toMatch(/\.timeline-tool\.entering\s*\{[^}]*animation:\s*tool-card-enter 220ms/u);
    expect(stylesheet).toMatch(/\.tool-card\.running::after\s*\{[^}]*background:\s*var\(--tool-accent\);[^}]*tool-runner-bounce/u);
    expect(stylesheet).toMatch(/\.tool-card\.selected:not\(\.running\)\s*\{/u);
    expect(stylesheet).not.toMatch(/\.tool-card\.running\s*\{[^}]*box-shadow:/u);
  });

  it("mounts the presence wrapper only when initially open", () => {
    vi.stubGlobal("localStorage", { getItem: () => "en", setItem: vi.fn() });
    const selected = tool("selected", "running");
    const openMarkup = renderToStaticMarkup(
      <I18nProvider>
        <ToolExecutionPanelPresence open tool={selected} turnTools={[selected]} onSelect={vi.fn()} onClose={vi.fn()} />
      </I18nProvider>,
    );
    const closedMarkup = renderToStaticMarkup(
      <I18nProvider>
        <ToolExecutionPanelPresence open={false} tool={null} turnTools={[]} onSelect={vi.fn()} onClose={vi.fn()} />
      </I18nProvider>,
    );
    const leavingMarkup = renderToStaticMarkup(
      <I18nProvider>
        <ToolExecutionPanel tool={selected} turnTools={[selected]} onSelect={vi.fn()} onClose={vi.fn()} leaving />
      </I18nProvider>,
    );
    expect(openMarkup).toContain('class="tool-execution-panel"');
    expect(leavingMarkup).toContain('class="tool-execution-panel leaving"');
    expect(closedMarkup).toBe("");
  });

  it("renders turn navigation and the selected call details", () => {
    vi.stubGlobal("localStorage", { getItem: () => "en", setItem: vi.fn() });
    const selected = tool("selected", "running");
    const markup = renderToStaticMarkup(
      <I18nProvider>
        <ToolExecutionPanel tool={selected} turnTools={[tool("first"), selected]} onSelect={vi.fn()} onClose={vi.fn()} />
      </I18nProvider>,
    );

    expect(markup).toContain("Tool execution");
    expect(markup).toContain("Tool calls in this turn");
    expect(markup).toContain('aria-current="true"');
    expect(markup).toContain("selected.ts");
    expect(markup).toContain("selected output");
    expect(markup).toContain("Close tool execution panel");
  });
});
