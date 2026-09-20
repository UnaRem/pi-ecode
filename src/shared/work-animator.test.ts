import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { defaultWorkAnimator, presetFrames } from "./work-animator.js";

describe("work animator presets", () => {
  it("uses shiro by default and maps both built-in sets to actual files", () => {
    expect(defaultWorkAnimator().idle.frames).toHaveLength(6);
    expect(defaultWorkAnimator().working.frames).toHaveLength(6);
    expect(presetFrames("idle", "silence_wang")).toHaveLength(4);
    expect(presetFrames("working", "silence_wang")).toHaveLength(12);
    expect(defaultWorkAnimator().display).toEqual({ scalePercent: 100, offsetX: 0, offsetY: 0 });
    for (const preset of ["shiro", "silence_wang"] as const) {
      for (const status of ["idle", "working"] as const) {
        for (const frame of presetFrames(status, preset)) {
          expect(existsSync(join(process.cwd(), "resources", frame.id))).toBe(true);
          expect(frame.durationMs).toBe(status === "idle" ? 650 : 220);
        }
      }
    }
  });
});
