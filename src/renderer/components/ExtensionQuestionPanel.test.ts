import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../i18n/i18n";
import { ExtensionQuestionPanel, multiSelectResponse } from "./ExtensionQuestionPanel";

describe("multiSelectResponse", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("renders explicit cancel and confirm actions for confirmations", () => {
    vi.stubGlobal("localStorage", { getItem: () => "en", setItem: vi.fn() });
    const markup = renderToStaticMarkup(createElement(
      I18nProvider,
      null,
      createElement(ExtensionQuestionPanel, {
        request: { id: "confirm-1", method: "confirm", title: "Apply changes?", message: "Update two files." },
        onRespond: vi.fn(),
      }),
    ));

    expect(markup).toContain(">Cancel</button>");
    expect(markup).toContain(">Confirm</button>");
    expect(markup).not.toContain(">Yes</button>");
  });

  it("makes a leaving question inert until its exit animation completes", () => {
    vi.stubGlobal("localStorage", { getItem: () => "en", setItem: vi.fn() });
    const markup = renderToStaticMarkup(createElement(
      I18nProvider,
      null,
      createElement(ExtensionQuestionPanel, {
        request: { id: "confirm-1", method: "confirm", title: "Apply changes?" },
        leaving: true,
        onRespond: vi.fn(),
      }),
    ));

    expect(markup).toContain("extension-question transient-panel leaving");
    expect(markup).toContain("inert=\"\"");
  });

  it("returns selected option values when no custom answer is entered", () => {
    expect(multiSelectResponse(["one", "three"], "  ")).toEqual(["one", "three"]);
  });

  it("prefers a typed custom answer over selected options", () => {
    expect(multiSelectResponse(["one"], "  another direction  ")).toBe("another direction");
  });
});
