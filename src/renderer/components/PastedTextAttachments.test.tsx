import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../i18n/i18n";
import { PastedTextAttachments } from "./PastedTextAttachments";

describe("PastedTextAttachments", () => {
  it("uses a scoped composer variant without inheriting the composer frame", () => {
    vi.stubGlobal("localStorage", { getItem: () => "en", setItem: vi.fn() });
    const markup = renderToStaticMarkup(
      <I18nProvider>
        <PastedTextAttachments
          attachments={[{ id: "text-1", content: "content", lineCount: 1, byteSize: 7 }]}
          variant="composer"
        />
      </I18nProvider>,
    );

    expect(markup).toContain('class="pasted-text-list pasted-text-list-composer"');
    expect(markup).not.toContain('class="pasted-text-list composer"');
  });

  it("keeps the dialog mounted while its close animation plays", () => {
    const stylesheet = readFileSync(new URL("../styles/global.css", import.meta.url), "utf8");
    expect(stylesheet).toContain("@keyframes overlay-close");
    expect(stylesheet).toMatch(/\.pasted-text-dialog\.closing[^{]*\{[^}]*animation-name:\s*overlay-close/u);
  });
});
