/// <reference types="node" />
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

function stylesheet(name: string): string {
  return readFileSync(new URL(name, import.meta.url), "utf8");
}

describe("renderer style system", () => {
  it("loads style layers in dependency order", () => {
    const entry = stylesheet("./index.css");
    expect(entry).toBe([
      '@import "./tokens.css";',
      '@import "./base.css";',
      '@import "./layout.css";',
      '@import "./components/legacy.css";',
      '@import "./components/chrome.css";',
      '@import "./components/inspector.css";',
      '@import "./components/conversation.css";',
      '@import "./components/composer.css";',
      "",
    ].join("\n"));
  });

  it("defines semantic colors, spacing, layout and motion tokens", () => {
    const tokens = stylesheet("./tokens.css");
    for (const token of [
      "--color-accent",
      "--color-surface",
      "--color-text",
      "--color-border",
      "--space-1",
      "--radius-md",
      "--sidebar-width",
      "--inspector-width",
      "--duration-standard",
    ]) expect(tokens).toContain(token);
  });

  it("provides one global reduced-motion fallback", () => {
    const base = stylesheet("./base.css");
    expect(base).toContain("@media (prefers-reduced-motion: reduce)");
    expect(base).toContain("transition-duration: 0ms !important");
  });
});
