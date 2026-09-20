/// <reference types="node" />
import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";

function stylesheet(name: string): string {
  return readFileSync(new URL(name, import.meta.url), "utf8");
}

describe("renderer style system", () => {
  it("loads style layers in dependency order", () => {
    const entry = stylesheet("./index.css").replaceAll("\r\n", "\n");
    expect(entry).toBe([
      '@import "./tokens.css";',
      '@import "./base.css";',
      '@import "./layout.css";',
      '@import "./components/legacy.css";',
      '@import "./components/chrome.css";',
      '@import "./components/inspector.css";',
      '@import "./components/conversation.css";',
      '@import "./components/composer.css";',
      '@import "./components/settings.css";',
      '@import "./components/overlays.css";',
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

  it("keeps raw color values inside the token layer during migration", () => {
    const componentDirectory = new URL("./components/", import.meta.url);
    const componentFiles = readdirSync(componentDirectory).filter((name) => name.endsWith(".css") && name !== "legacy.css");
    for (const name of componentFiles) {
      const content = readFileSync(new URL(name, componentDirectory), "utf8");
      expect(content, name).not.toMatch(/#[0-9a-f]{3,8}|rgba?\(/iu);
    }
  });

  it("provides one global reduced-motion fallback", () => {
    const base = stylesheet("./base.css");
    expect(base).toContain("@media (prefers-reduced-motion: reduce)");
    expect(base).toContain("transition-duration: 0ms !important");
  });
});
