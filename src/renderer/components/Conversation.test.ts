import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../i18n/i18n";
import { Conversation, conversationContentGrew, followConversationGrowth, formatWorkingDuration } from "./Conversation";
import { normalizeNickname } from "./MessageRoleLabel";

describe("Conversation", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("follows rendered height growth without treating shrinkage as new content", () => {
    const container = { scrollHeight: 720, scrollTop: 10 };
    expect(conversationContentGrew(720, 720)).toBe(false);
    expect(conversationContentGrew(720, 680)).toBe(false);
    expect(conversationContentGrew(720, 721)).toBe(true);

    container.scrollHeight = 721;
    expect(followConversationGrowth(container, 720, true)).toBe(721);
    expect(container.scrollTop).toBe(721);
    container.scrollHeight = 800;
    followConversationGrowth(container, 721, false);
    expect(container.scrollTop).toBe(721);
  });

  it("formats elapsed time as cumulative hours, minutes, and seconds", () => {
    expect(formatWorkingDuration(0)).toBe("00:00:00");
    expect(formatWorkingDuration(3_723_999)).toBe("01:02:03");
    expect(formatWorkingDuration(97_389_000)).toBe("27:03:09");
  });

  it("uses default nicknames when saved values are empty", () => {
    expect(normalizeNickname("assistant", "   ")).toBe("pi");
    expect(normalizeNickname("user", "   ")).toBe("你");
  });

  it("renders locally saved nicknames for both message roles", () => {
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => ({
        "pi-ecode:language": "en",
        "pi-ecode:assistant-nickname": "Builder",
        "pi-ecode:user-nickname": "Owner",
      })[key] ?? null,
      setItem: vi.fn(),
    });
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
      }),
    ));

    expect(markup).toContain(">Owner</button>");
    expect(markup).toContain(">Builder</button>");
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
