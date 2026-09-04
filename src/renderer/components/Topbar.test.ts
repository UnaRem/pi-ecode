import { describe, expect, it } from "vitest";
import { normalizeSessionTitle, thinkingSelectOptions } from "./Topbar";

describe("normalizeSessionTitle", () => {
  it("trims whitespace, removes line breaks, and limits the title", () => {
    expect(normalizeSessionTitle("  Rename\n  this conversation  ")).toBe("Rename this conversation");
    expect(normalizeSessionTitle("x".repeat(90))).toHaveLength(80);
  });

  it("allows an empty title to restore the generated session title", () => {
    expect(normalizeSessionTitle("  \n ")).toBe("");
  });

  it("keeps thinking levels as untranslated SDK values", () => {
    expect(thinkingSelectOptions(["off", "minimal", "low", "medium", "high", "xhigh", "max"]))
      .toEqual([
        { value: "off", label: "off" },
        { value: "minimal", label: "minimal" },
        { value: "low", label: "low" },
        { value: "medium", label: "medium" },
        { value: "high", label: "high" },
        { value: "xhigh", label: "xhigh" },
        { value: "max", label: "max" },
      ]);
  });
});
