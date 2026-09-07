import { renderToStaticMarkup } from "react-dom/server";
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
});
