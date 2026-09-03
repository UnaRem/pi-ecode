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
