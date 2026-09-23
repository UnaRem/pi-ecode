import { createElement } from "react";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ConversationItem, ExplorerTask, ToolActivity, ValidationState } from "@shared/contracts";
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

function explorerTask(id: string, originToolCallId: string, agentRole?: ExplorerTask["agentRole"]): ExplorerTask {
  return {
    id, taskName: id, title: `Explorer ${id}`, objective: "Inspect behavior", scope: `src/${id}`,
    deliverable: "Evidence", status: "running", originToolCallId, thinkingLevel: "low",
    attempt: 1, maxAttempts: 2, revision: 1, queuedAt: 1,
    ...(agentRole ? { agentRole } : {}),
  };
}

function renderBatch(props: { tools: ToolActivity[]; explorers?: ExplorerTask[] }): string {
  vi.stubGlobal("localStorage", { getItem: () => "en", setItem: vi.fn() });
  return renderToStaticMarkup(
    createElement(I18nProvider, null, createElement(ToolBatch, {
      tools: props.tools,
      ...(props.explorers ? { explorers: props.explorers } : {}),
      selectedToolId: null,
      onSelectTool: vi.fn(),
    })),
  );
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

  it("replaces large Explorer cards with one compact dispatch summary", () => {
    vi.stubGlobal("localStorage", { getItem: () => "en", setItem: vi.fn() });
    const markup = renderToStaticMarkup(
      createElement(I18nProvider, null, createElement(ToolBatch, {
        tools: [{ ...activity("dispatch-call"), name: "dispatch_explorers" }],
        explorers: [explorerTask("linked", "dispatch-call"), explorerTask("other", "other-call")],
        selectedToolId: null,
        onSelectTool: vi.fn(),
      })),
    );

    expect(markup).toContain("Agents · 1 active / 1 total");
    expect(markup).not.toContain("Explorer linked");
    expect(markup).not.toContain("Explorer other");
    expect(markup).not.toContain("explorer-cards");
  });

  it("labels a single-role batch with the translated role name", () => {
    const editor = renderBatch({
      tools: [{ ...activity("dispatch-call"), name: "agent_dispatch" }],
      explorers: [explorerTask("linked", "dispatch-call", "editor")],
    });
    expect(editor).toContain("Editor · 1 active / 1 total");

    const explorers = renderBatch({
      tools: [{ ...activity("dispatch-call"), name: "agent_dispatch" }],
      explorers: [explorerTask("one", "dispatch-call", "explorer"), explorerTask("two", "dispatch-call", "explorer")],
    });
    expect(explorers).toContain("Explorer · 2 active / 2 total");
  });

  it("uses the neutral agent label for mixed roles or a missing role", () => {
    const mixed = renderBatch({
      tools: [{ ...activity("dispatch-call"), name: "agent_dispatch" }],
      explorers: [explorerTask("one", "dispatch-call", "editor"), explorerTask("two", "dispatch-call", "explorer")],
    });
    expect(mixed).toContain("Agents · 2 active / 2 total");
    expect(mixed).not.toContain("Editor ·");
    expect(mixed).not.toContain("Explorer ·");

    const partiallyKnown = renderBatch({
      tools: [{ ...activity("dispatch-call"), name: "agent_dispatch" }],
      explorers: [explorerTask("one", "dispatch-call", "editor"), explorerTask("legacy", "dispatch-call")],
    });
    expect(partiallyKnown).toContain("Agents · 2 active / 2 total");
    expect(partiallyKnown).not.toContain("Editor ·");
  });

  it("keeps the original tool title when no task is linked to the batch", () => {
    const markup = renderBatch({
      tools: [{ ...activity("dispatch-call"), name: "agent_dispatch" }],
      explorers: [explorerTask("other", "other-call", "editor")],
    });

    expect(markup).toContain("read · dispatch-call");
    expect(markup).not.toContain("Agents ·");
    expect(markup).not.toContain("Editor ·");
  });

  it("renders the validation state only under its originating tool call", () => {
    vi.stubGlobal("localStorage", { getItem: () => "en", setItem: vi.fn() });
    const validation: ValidationState = {
      supported: true, isSelfProject: false, status: "running", runId: "run-1", activeStep: "test",
      steps: [{ id: "test", label: "Tests", command: "npm run test", status: "running", output: "", exitCode: null, durationMs: null }],
      sourceRevision: null, originToolCallId: "validation-call", startedAt: 1, verifiedAt: null, message: null,
    };
    const markup = renderToStaticMarkup(
      createElement(I18nProvider, null, createElement(ToolBatch, {
        tools: [{ ...activity("validation-call"), name: "run_validation" }],
        validation,
        selectedToolId: null,
        onSelectTool: vi.fn(),
      })),
    );

    expect(markup).toContain("Background validation");
    expect(markup).toContain("Tests: running");
    expect(markup).toContain("Tests");
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
