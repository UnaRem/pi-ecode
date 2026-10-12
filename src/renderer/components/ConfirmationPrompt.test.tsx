import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConfirmationPrompt } from "./ConfirmationPrompt";
import { I18nProvider } from "../i18n/i18n";

function renderPrompt(disabled = false) {
  vi.stubGlobal("localStorage", { getItem: () => "zh-CN", setItem: vi.fn() });
  return renderToStaticMarkup(<I18nProvider><ConfirmationPrompt
    request={{ requestId: "private-request-id", title: "实施方案", message: "第一步\n第二步 <script>" }}
    disabled={disabled}
    onSend={vi.fn(async () => undefined)}
  /></I18nProvider>);
}

describe("ConfirmationPrompt", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("renders the plan, optional labeled input and both actions without exposing its identifier", () => {
    const markup = renderPrompt();
    expect(markup).toContain("实施方案");
    expect(markup).toContain("第一步\n第二步 &lt;script&gt;");
    expect(markup).toContain("补充说明（可选）</span><textarea");
    expect(markup).toContain("确认并发送</button>");
    expect(markup).toContain("取消并发送</button>");
    expect(markup).not.toContain("private-request-id");
    expect(markup).not.toContain("autofocus");
    expect(markup).not.toContain('disabled=""');
  });

  it("disables both actions and the input while the conversation is blocked", () => {
    const markup = renderPrompt(true);
    expect(markup.match(/disabled=""/g)).toHaveLength(3);
    expect(markup).toContain("实施方案");
    expect(markup).toContain("取消并发送");
  });

  it("declares a single fade-in and removes animation and hover transitions for reduced motion", () => {
    const stylesheet = readFileSync(new URL("../styles/components/conversation.css", import.meta.url), "utf8");
    expect(stylesheet).toContain("animation: confirmation-prompt-enter 180ms ease-out both");
    expect(stylesheet).toContain("transition: color 120ms ease, border-color 120ms ease, background-color 120ms ease");
    expect(stylesheet).toMatch(/@media \(prefers-reduced-motion: reduce\)\s*\{\s*\.confirmation-prompt \{ animation: none; \}\s*\.confirmation-prompt-actions button \{ transition: none; \}/u);
  });
});
