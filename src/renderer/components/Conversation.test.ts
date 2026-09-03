import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../i18n/i18n";
import { Conversation, formatWorkingDuration } from "./Conversation";

describe("Conversation", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("formats elapsed time as cumulative hours, minutes, and seconds", () => {
    expect(formatWorkingDuration(0)).toBe("00:00:00");
    expect(formatWorkingDuration(3_723_999)).toBe("01:02:03");
    expect(formatWorkingDuration(97_389_000)).toBe("27:03:09");
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
