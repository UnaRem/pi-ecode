/// <reference types="node" />
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("main window size", () => {
  it("uses a 1440px initial width capped by the primary display work area", () => {
    const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");

    expect(source).toContain("screen.getPrimaryDisplay().workAreaSize.width");
    expect(source).toContain("Math.min(1440");
    expect(source).toContain("width: initialWidth");
    expect(source).toContain("minWidth: 820");
  });
});
