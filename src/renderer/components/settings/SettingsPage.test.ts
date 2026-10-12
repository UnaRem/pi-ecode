/// <reference types="node" />
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("SettingsPage", () => {
  it("applies runtime configuration when settings are reloaded", () => {
    const source = readFileSync(new URL("./SettingsPage.tsx", import.meta.url), "utf8");
    const reloadButton = source.split("\n").find((line) => line.includes('className="settings-reload"'));

    expect(reloadButton).toContain("settings.reload()");
    expect(reloadButton).not.toContain("settings.load()");
  });
});
