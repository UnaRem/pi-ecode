import { describe, expect, it } from "vitest";
import { normalizeSessionTitle } from "./Topbar";

describe("normalizeSessionTitle", () => {
  it("trims whitespace, removes line breaks, and limits the title", () => {
    expect(normalizeSessionTitle("  Rename\n  this conversation  ")).toBe("Rename this conversation");
    expect(normalizeSessionTitle("x".repeat(90))).toHaveLength(80);
  });

  it("allows an empty title to restore the generated session title", () => {
    expect(normalizeSessionTitle("  \n ")).toBe("");
  });
});
