/// <reference types="node" />
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../i18n/i18n";
import { copyText, Markdown } from "./Markdown";

describe("Markdown code blocks", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("renders a keyboard-accessible copy button with exact code text", () => {
    vi.stubGlobal("localStorage", { getItem: () => "en", setItem: vi.fn() });
    const markup = renderToStaticMarkup(
      <I18nProvider><Markdown>{"```ts\nconst answer = 42;\n```"}</Markdown></I18nProvider>,
    );

    expect(markup).toContain('class="markdown-code-block"');
    expect(markup).toContain('class="markdown-copy-button idle"');
    expect(markup).toContain('aria-label="Copy"');
    expect(markup).toContain('data-language="ts"');
    expect(markup).toContain("const answer = 42;");
  });

  it("reports clipboard success and failure without throwing", async () => {
    const writeText = vi.fn(async () => undefined);
    await expect(copyText("exact code", writeText)).resolves.toBe(true);
    expect(writeText).toHaveBeenCalledWith("exact code");

    await expect(copyText("blocked", async () => { throw new Error("denied"); })).resolves.toBe(false);
  });

  it("keeps the copy action above code and styles feedback states", () => {
    const stylesheet = readFileSync(new URL("../styles/components/conversation.css", import.meta.url), "utf8");
    expect(stylesheet).toMatch(/\.markdown-copy-button\s*\{[^}]*position:\s*absolute;[^}]*top:\s*7px;[^}]*right:\s*7px;/u);
    expect(stylesheet).toContain(".markdown-copy-button.copied");
    expect(stylesheet).toContain(".markdown-copy-button.failed");
  });
});
