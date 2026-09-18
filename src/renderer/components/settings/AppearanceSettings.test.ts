/// <reference types="node" />
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("AppearanceSettings", () => {
  it("keeps icon and background controls without exposing legacy theme colors", () => {
    const source = readFileSync(new URL("./AppearanceSettings.tsx", import.meta.url), "utf8");
    expect(source).toContain("chooseIcon");
    expect(source).toContain("chooseBackgroundImage");
    expect(source).not.toContain("saveTheme");
    expect(source).not.toContain('type="color"');
  });

  it("does not apply persisted theme colors to the fixed renderer design system", () => {
    const source = readFileSync(new URL("../../hooks/use-app-config.ts", import.meta.url), "utf8");
    expect(source).not.toContain("style.setProperty");
    expect(source).not.toContain("applyThemeColors");
  });
});
