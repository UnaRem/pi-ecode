/// <reference types="node" />
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("main window size", () => {
  const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");

  it("uses a 1440px initial width capped by the primary display work area", () => {
    expect(source).toContain("screen.getPrimaryDisplay().workAreaSize.width");
    expect(source).toContain("Math.min(1440");
    expect(source).toContain("width: initialWidth");
    expect(source).toContain("minWidth: 820");
  });

  it("lets the branded development executable own its taskbar identity", () => {
    expect(source).toContain('const IS_BRANDED_DEVELOPMENT_RUNTIME = process.env.PI_ECODE_DEVELOPMENT_RUNTIME === "1"');
    expect(source).toContain('process.platform === "win32" && !IS_BRANDED_DEVELOPMENT_RUNTIME');
    expect(source).toContain("app.setAppUserModelId(APP_ID)");
    expect(source).toContain("window.setAppDetails({ appId: APP_ID, appIconPath: iconPath, appIconIndex: 0 })");
  });
});
