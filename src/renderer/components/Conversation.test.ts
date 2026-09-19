import { createElement } from "react";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../i18n/i18n";
import { Conversation, formatWorkingDuration } from "./Conversation";
import { normalizeNickname } from "./MessageRoleLabel";

describe("Conversation", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("positions the latest button outside the outline at the composer edge", () => {
    const stylesheet = readFileSync(new URL("../styles/components/legacy.css", import.meta.url), "utf8");
    expect(stylesheet).toMatch(/\.conversation-latest\s*\{[^}]*position:\s*absolute;[^}]*right:\s*max\(28px, calc\(50% - 380px\)\);[^}]*bottom:\s*12px;[^}]*width:\s*44px;[^}]*height:\s*44px;/u);
    expect(stylesheet).not.toContain(".outline-latest");
  });

  it("formats elapsed time as cumulative hours, minutes, and seconds", () => {
    expect(formatWorkingDuration(0)).toBe("00:00:00");
    expect(formatWorkingDuration(3_723_999)).toBe("01:02:03");
    expect(formatWorkingDuration(97_389_000)).toBe("27:03:09");
  });

  it("uses default nicknames when saved values are empty", () => {
    expect(normalizeNickname("assistant", "   ")).toBe("PiECode");
    expect(normalizeNickname("user", "   ")).toBe("你");
  });

  it("renders locally saved nicknames for both message roles", () => {
    vi.stubGlobal("localStorage", { getItem: () => "en", setItem: vi.fn() });
    const markup = renderToStaticMarkup(createElement(
      I18nProvider,
      null,
      createElement(Conversation, {
        timeline: [
          { kind: "message", id: "user-1", message: { id: "user-1", role: "user", text: "Question", timestamp: 1 } },
          { kind: "message", id: "assistant-1", message: { id: "assistant-1", role: "assistant", text: "Answer", timestamp: 2 } },
        ],
        isStreaming: false,
        workingStartedAt: null,
        projectName: "demo",
        error: null,
        canContinue: false,
        notice: null,
        onContinue: vi.fn(),
        conversationIdentity: {
          assistant: { nickname: "Builder", avatarPath: null, avatarUrl: null },
          user: { nickname: "Owner", avatarPath: null, avatarUrl: null },
        },
      }),
    ));

    expect(markup).toContain('class="message-role-name">Owner</span>');
    expect(markup).toContain('class="message-role-name">Builder</span>');
  });

  it("renders pasted text attachments separately from the user message", () => {
    vi.stubGlobal("localStorage", { getItem: () => "en", setItem: vi.fn() });
    const markup = renderToStaticMarkup(createElement(
      I18nProvider,
      null,
      createElement(Conversation, {
        timeline: [{
          kind: "message",
          id: "user-1",
          message: {
            id: "user-1",
            role: "user",
            text: "Review this",
            timestamp: 1,
            pastedTexts: [{ id: "text-1", content: "first\nsecond", lineCount: 2, byteSize: 12 }],
          },
        }],
        isStreaming: false,
        workingStartedAt: null,
        projectName: "demo",
        error: null,
        canContinue: false,
        notice: null,
        onContinue: vi.fn(),
      }),
    ));

    expect(markup).toContain("Review this");
    expect(markup).toContain("Pasted text #1");
    expect(markup).toContain("2 lines · 12 B");
    expect(markup).not.toContain("first\nsecond");
  });

  it("marks every user message after the first as a new turn", () => {
    vi.stubGlobal("localStorage", { getItem: () => "en", setItem: vi.fn() });
    const markup = renderToStaticMarkup(createElement(
      I18nProvider,
      null,
      createElement(Conversation, {
        timeline: [
          { kind: "message", id: "user-1", message: { id: "user-1", role: "user", text: "First", timestamp: 1 } },
          { kind: "message", id: "assistant-1", message: { id: "assistant-1", role: "assistant", text: "Answer", timestamp: 2 } },
          { kind: "message", id: "user-2", message: { id: "user-2", role: "user", text: "Second", timestamp: 3 } },
        ],
        isStreaming: false,
        workingStartedAt: null,
        projectName: "demo",
        error: null,
        canContinue: false,
        notice: null,
        onContinue: vi.fn(),
      }),
    ));
    expect(markup.match(/turn-start/g)).toHaveLength(1);
    expect(markup).toContain('class="message user turn-start"');
  });

  it("offers bounded history paging only when older turns remain", () => {
    vi.stubGlobal("localStorage", { getItem: () => "en", setItem: vi.fn() });
    const markup = renderToStaticMarkup(createElement(
      I18nProvider,
      null,
      createElement(Conversation, {
        timeline: [{ kind: "message", id: "user-1", message: { id: "user-1", role: "user", text: "Recent", timestamp: 1 } }],
        isStreaming: false,
        workingStartedAt: null,
        projectName: "demo",
        error: null,
        canContinue: false,
        notice: null,
        hasOlderTimeline: true,
        isLoadingOlder: true,
        onLoadOlder: vi.fn(),
        onContinue: vi.fn(),
      }),
    ));
    expect(markup).toContain("Loading earlier messages…");
    expect(markup).toContain("disabled");
  });

  it("offers continuation only for a recoverable interruption", () => {
    vi.stubGlobal("localStorage", { getItem: () => "en", setItem: vi.fn() });
    const markup = renderToStaticMarkup(createElement(
      I18nProvider,
      null,
      createElement(Conversation, {
        timeline: [],
        isStreaming: false,
        workingStartedAt: null,
        projectName: "demo",
        error: "502 Bad Gateway",
        canContinue: true,
        notice: null,
        onContinue: vi.fn(),
      }),
    ));
    expect(markup).toContain("502 Bad Gateway");
    expect(markup).toContain(">Continue</button>");
  });
});
