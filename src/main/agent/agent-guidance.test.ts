import { describe, expect, it } from "vitest";
import { EDIT_TOOL_COMPATIBILITY_GUIDANCE } from "./agent-guidance.js";

describe("agent guidance", () => {
  it("maps GPT patch behavior to pi's edit tool", () => {
    expect(EDIT_TOOL_COMPATIBILITY_GUIDANCE).toContain("does not provide an apply_patch");
    expect(EDIT_TOOL_COMPATIBILITY_GUIDANCE).toContain("Use the edit tool");
    expect(EDIT_TOOL_COMPATIBILITY_GUIDANCE).toContain("translate that intent to the edit tool");
    expect(EDIT_TOOL_COMPATIBILITY_GUIDANCE).toContain("Never invoke apply_patch through bash or PowerShell");
  });
});
