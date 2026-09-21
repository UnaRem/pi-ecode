import { describe, expect, it } from "vitest";
import {
  EDIT_TOOL_COMPATIBILITY_GUIDANCE,
  EXPLORER_ORCHESTRATION_GUIDANCE,
  PARALLEL_TOOL_EXECUTION_GUIDANCE,
  VALIDATION_ORCHESTRATION_GUIDANCE,
} from "./agent-guidance.js";

describe("agent guidance", () => {
  it("maps GPT patch behavior to pi's edit tool", () => {
    expect(EDIT_TOOL_COMPATIBILITY_GUIDANCE).toContain("does not provide an apply_patch");
    expect(EDIT_TOOL_COMPATIBILITY_GUIDANCE).toContain("Use the edit tool");
    expect(EDIT_TOOL_COMPATIBILITY_GUIDANCE).toContain("translate that intent to the edit tool");
    expect(EDIT_TOOL_COMPATIBILITY_GUIDANCE).toContain("Never invoke apply_patch through bash or PowerShell");
  });

  it("discourages avoidable shell failures in every runtime", () => {
    expect(EDIT_TOOL_COMPATIBILITY_GUIDANCE).toContain("Prefer dedicated read, search, and edit tools");
    expect(EDIT_TOOL_COMPATIBILITY_GUIDANCE).toContain("Check with command -v before first use");
    expect(EDIT_TOOL_COMPATIBILITY_GUIDANCE).toContain("avoid nested Bash, cmd.exe, PowerShell, or Node quoting");
  });

  it("requires safe parallel tool batches across model families", () => {
    expect(PARALLEL_TOOL_EXECUTION_GUIDANCE).toContain("issue them together in one assistant response");
    expect(PARALLEL_TOOL_EXECUTION_GUIDANCE).toContain("reads, searches, and non-mutating diagnostic checks");
    expect(PARALLEL_TOOL_EXECUTION_GUIDANCE).toContain("Keep dependent calls sequential");
    expect(PARALLEL_TOOL_EXECUTION_GUIDANCE).toContain("Never split changes to the same file across parallel calls");
    expect(PARALLEL_TOOL_EXECUTION_GUIDANCE).toContain("request_confirmation must remain the only tool");
  });

  it("teaches every model the host validation protocol", () => {
    expect(VALIDATION_ORCHESTRATION_GUIDANCE).toContain("run_validation accepts no commands");
    expect(VALIDATION_ORCHESTRATION_GUIDANCE).toContain("typecheck, test, and build");
    expect(VALIDATION_ORCHESTRATION_GUIDANCE).toContain("continue only read-only work");
    expect(VALIDATION_ORCHESTRATION_GUIDANCE).toContain("source revision");
  });

  it("teaches every model the pi-ecode Explorer protocol", () => {
    expect(EXPLORER_ORCHESTRATION_GUIDANCE).toContain("dispatch_explorers");
    expect(EXPLORER_ORCHESTRATION_GUIDANCE).toContain("read, ffgrep, and fffind");
    expect(EXPLORER_ORCHESTRATION_GUIDANCE).toContain("At most three run concurrently");
    expect(EXPLORER_ORCHESTRATION_GUIDANCE).toContain("do not poll or wait");
    expect(EXPLORER_ORCHESTRATION_GUIDANCE).toContain("cannot edit files or execute commands");
  });
});
