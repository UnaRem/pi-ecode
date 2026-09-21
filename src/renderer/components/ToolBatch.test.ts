import { createElement } from "react";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ConversationItem, ExplorerTask, ToolActivity } from "@shared/contracts";
import { I18nProvider } from "../i18n/i18n";
import { groupConsecutiveTools, isScrollAreaAtBottom, ToolBatch } from "./ToolBatch";

function activity(id: string): ToolActivity {
  return {
    id,
    name: "read",
    title: `read · ${id}`,
    input: id,
    output: id,
    status: "success",
  };
}

function tool(id: string): ConversationItem {
  return { kind: "tool", id, tool: activity(id) };
}

function message(id: string, role: "user" | "assistant" = "assistant"): ConversationItem {
  return { kind: "message", id, message: { id, role, text: id, timestamp: 1 } };
}

describe("ToolBatch", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("renders a collapsed plaintext summary and a scrollable detail list", () => {
    vi.stubGlobal("localStorage", { getItem: () => "en", setItem: vi.fn() });
    const activities = ["one", "two", "three", "four", "five"].map(activity);
    const markup = renderToStaticMarkup(
      createElement(I18nProvider, null, createElement(ToolBatch, {
        tools: activities,
        selectedToolId: "four",
        onSelectTool: vi.fn(),
      })),
    );

    expect(markup).toContain('class="tool-dropdown"');
    expect(markup).toContain('class="lucide lucide-chevron-down tool-inline-chevron"');
    expect(markup).toContain('class="tool-batch-list scrollable"');
    expect(markup).toContain('role="region"');
    expect(markup).toContain('aria-expanded="false"');
    expect(markup).toContain('class="tool-batch-reveal" aria-hidden="true" inert=""');
    expect(markup).not.toContain('tabindex="0"');
    expect(markup).toMatch(/class="tool-plaintext-row[^\"]*selected/);
    expect(markup).toContain("read · one");
    expect(markup).not.toContain('open="true"');
  });

  it("keeps short batches at their natural height", () => {
    vi.stubGlobal("localStorage", { getItem: () => "en", setItem: vi.fn() });
    const markup = renderToStaticMarkup(
      createElement(I18nProvider, null, createElement(ToolBatch, {
        tools: ["one", "two", "three"].map(activity),
        selectedToolId: null,
        onSelectTool: vi.fn(),
      })),
    );

    expect(markup).toContain('class="tool-dropdown"');
    expect(markup).not.toContain('class="tool-batch-list scrollable"');
  });

  it("marks only a live new call for the zero-height reveal", () => {
    vi.stubGlobal("localStorage", { getItem: () => "en", setItem: vi.fn() });
    const running = { ...activity("latest"), status: "running" as const };
    const markup = renderToStaticMarkup(
      createElement(I18nProvider, null, createElement(ToolBatch, {
        tools: [activity("complete"), running],
        animateNewTools: true,
        selectedToolId: "latest",
        onSelectTool: vi.fn(),
      })),
    );

    expect(markup).toMatch(/class="tool-plaintext-row[^\"]*entering/);
    expect(markup).toContain('class="tool-plaintext-row  "');
  });

  it("renders only Explorers linked to this dispatch tool call", () => {
    vi.stubGlobal("localStorage", { getItem: () => "en", setItem: vi.fn() });
    const explorer = (id: string, originToolCallId: string): ExplorerTask => ({
      id, taskName: id, title: `Explorer ${id}`, objective: "Inspect behavior", scope: `src/${id}`,
      deliverable: "Evidence", status: "running", originToolCallId, queuedAt: 1,
    });
    const markup = renderToStaticMarkup(
      createElement(I18nProvider, null, createElement(ToolBatch, {
        tools: [{ ...activity("dispatch-call"), name: "dispatch_explorers" }],
        explorers: [explorer("linked", "dispatch-call"), explorer("other", "other-call")],
        selectedToolId: null,
        onSelectTool: vi.fn(),
      })),
    );

    expect(markup).toContain("Explorer linked");
    expect(markup).toContain("Exploring");
    expect(markup).not.toContain("Explorer other");
  });

  it("connects the entering class to the tool row animation", () => {
    const stylesheet = readFileSync(new URL("../styles/components/legacy.css", import.meta.url), "utf8");
    expect(stylesheet).toContain(".tool-plaintext-row.entering");
    expect(stylesheet).not.toContain(".timeline-tool.entering");
  });

  it("detects whether the scroll position is close enough to follow the latest tool", () => {
    expect(isScrollAreaAtBottom(92, 100, 200)).toBe(true);
    expect(isScrollAreaAtBottom(91, 100, 200)).toBe(false);
    expect(isScrollAreaAtBottom(0, 100, 80)).toBe(true);
  });
});

describe("groupConsecutiveTools", () => {
  it("groups only consecutive tool calls", () => {
    const groups = groupConsecutiveTools([
      message("user", "user"),
      tool("one"),
      tool("two"),
      message("commentary"),
      tool("three"),
      tool("four"),
    ]);

    expect(groups.map((group) => group.kind)).toEqual(["message", "tools", "message", "tools"]);
    expect(groups[1]).toMatchObject({ kind: "tools", tools: [{ id: "one" }, { id: "two" }] });
    expect(groups[3]).toMatchObject({ kind: "tools", tools: [{ id: "three" }, { id: "four" }] });
  });

  it("does not merge tools across a user message boundary", () => {
    const groups = groupConsecutiveTools([tool("before"), message("next-user", "user"), tool("after")]);
    expect(groups).toHaveLength(3);
    expect(groups[0]).toMatchObject({ kind: "tools", tools: [{ id: "before" }] });
    expect(groups[2]).toMatchObject({ kind: "tools", tools: [{ id: "after" }] });
  });
});
