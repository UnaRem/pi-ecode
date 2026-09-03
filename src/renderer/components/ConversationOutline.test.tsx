import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ConversationMessage } from "@shared/contracts";
import { I18nProvider } from "../i18n/i18n";
import { ConversationOutline } from "./ConversationOutline";

describe("ConversationOutline", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("keeps every conversation turn in one compressible marker track", () => {
    vi.stubGlobal("localStorage", { getItem: () => "en", setItem: vi.fn() });
    const messages: ConversationMessage[] = Array.from({ length: 50 }, (_, index) => ({
      id: `user-${index + 1}`,
      role: "user",
      text: `Question ${index + 1}`,
      timestamp: index,
    }));
    const markup = renderToStaticMarkup(
      <I18nProvider>
        <ConversationOutline messages={messages} activeId="user-50" showLatest onSelect={vi.fn()} onLatest={vi.fn()} />
      </I18nProvider>,
    );

    expect(markup.match(/<button class="outline-marker/g)).toHaveLength(50);
    expect(markup).toContain("outline-track has-latest");
    expect(markup).toContain("--outline-natural-height:650px");
    expect(markup).toContain("outline-marker active");
  });
});
