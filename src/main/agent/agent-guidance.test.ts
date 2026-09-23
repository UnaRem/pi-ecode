import { describe, expect, it } from "vitest";
import {
  EDIT_TOOL_COMPATIBILITY_GUIDANCE,
  EXPLORER_ORCHESTRATION_GUIDANCE,
  PARALLEL_TOOL_EXECUTION_GUIDANCE,
  SUBAGENT_ORCHESTRATION_GUIDANCE,
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

  it("routes every main-session request to the right subagent role", () => {
    expect(SUBAGENT_ORCHESTRATION_GUIDANCE).toContain("directly in the main session");
    expect(SUBAGENT_ORCHESTRATION_GUIDANCE).toContain("Every editor dispatch requires approval through the project's existing applicable confirmation gates");
    expect(SUBAGENT_ORCHESTRATION_GUIDANCE).toContain("only skips the exploration step");
    expect(SUBAGENT_ORCHESTRATION_GUIDANCE).toContain("must not edit any file inside a subagent's active write_scope");
    expect(SUBAGENT_ORCHESTRATION_GUIDANCE).toContain("Use agent_dispatch for a single investigation direction");
    expect(SUBAGENT_ORCHESTRATION_GUIDANCE).toContain("use dispatch_explorers only for two independent directions");
    expect(SUBAGENT_ORCHESTRATION_GUIDANCE).toContain("the plan passes the same confirmation gates");
    expect(SUBAGENT_ORCHESTRATION_GUIDANCE).toContain("The main session owns the final validation");
    expect(SUBAGENT_ORCHESTRATION_GUIDANCE).toContain("validation must be rerun before delivery");
    expect(SUBAGENT_ORCHESTRATION_GUIDANCE).toContain("state that explicitly before degrading to main-session edits");
  });

  it("teaches every model the pi-ecode Explorer protocol", () => {
    expect(EXPLORER_ORCHESTRATION_GUIDANCE).toContain("dispatch_explorers");
    expect(EXPLORER_ORCHESTRATION_GUIDANCE).toContain("read, ffgrep, and fffind");
    expect(EXPLORER_ORCHESTRATION_GUIDANCE).toContain("thinking defaults to low");
    expect(EXPLORER_ORCHESTRATION_GUIDANCE).toContain("At most three run concurrently");
    expect(EXPLORER_ORCHESTRATION_GUIDANCE).toContain("do not poll or wait");
    expect(EXPLORER_ORCHESTRATION_GUIDANCE).toContain("attention marker");
    expect(EXPLORER_ORCHESTRATION_GUIDANCE).toContain("retry once after an inactivity abort or another non-user error");
    expect(EXPLORER_ORCHESTRATION_GUIDANCE).toContain("After a second failure");
    expect(EXPLORER_ORCHESTRATION_GUIDANCE).toContain("stop after 10 minutes total");
    expect(EXPLORER_ORCHESTRATION_GUIDANCE).toContain("cannot edit files or execute commands");
  });
});
