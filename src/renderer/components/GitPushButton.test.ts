import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../i18n/i18n";
import { GitPushButton } from "./GitPushButton";

describe("GitPushButton", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("starts disabled while the main process Git status is loading", () => {
    vi.stubGlobal("localStorage", { getItem: () => "en", setItem: vi.fn() });
    const markup = renderToStaticMarkup(createElement(
      I18nProvider,
      null,
      createElement(GitPushButton, { projectKey: "C:/project", disabled: false, validationStatus: "idle" }),
    ));
    expect(markup).toContain("Reading Git status…");
    expect(markup).toContain("disabled");
    expect(markup).toContain(">Push</span>");
  });
});
