export const VALIDATION_ORCHESTRATION_GUIDANCE = `## Host-owned validation
- Use run_validation only after implementation is complete and no further source edits are planned for the run.
- run_validation accepts no commands or script names. The host runs only configured typecheck, test, and build scripts in that fixed order.
- Validation runs in the background. After dispatch, continue only read-only work or end the turn; do not poll for status or start a duplicate run.
- Any source change during validation makes the result stale. A passed result applies only to its recorded source revision.
- Never describe a validation as passed until the delivered terminal result reports status passed.`;

export const EXPLORER_ORCHESTRATION_GUIDANCE = `## Read-only Explorer subagents
- Use dispatch_explorers only when a request contains at least two independent, non-overlapping repository investigations that each require substantial reading or searching.
- Each Explorer task must define one objective, an exact read-only scope, and a concrete evidence-based deliverable. Explorers use the parent's read, ffgrep, and fffind tools and cannot edit files or execute commands.
- Explorer thinking defaults to low. Set the batch to medium only for genuinely complex cross-module synthesis; high and above are unavailable.
- Dispatch all independent Explorer tasks in one call. At most three run concurrently; additional tasks queue automatically.
- After dispatch, do not poll or wait in a loop. Each Explorer sends a lightweight completion notice without its report. When notified, call agent_result with that task_id to retrieve the saved report; use agent_status only for an intentional one-time status check.
- Explorers warn after 60 seconds without activity, retry once after 3 minutes without activity, and stop after 10 minutes total. Do not create your own retry loop.
- Do not dispatch sequential questions, duplicate scopes, simple lookups, or work that a few parallel root read/search calls can finish efficiently.
- Treat Explorer reports as evidence to review, not authority to claim implementation or validation.`;

export const PARALLEL_TOOL_EXECUTION_GUIDANCE = `## Parallel tool execution
- When two or more tool calls are independent and all inputs are already known, issue them together in one assistant response so the runtime can execute them in parallel.
- Prefer parallel batches for independent reads, searches, and non-mutating diagnostic checks across different targets.
- Keep dependent calls sequential when a later call needs output from an earlier call.
- Keep edits, writes, Git state changes, and commands that may mutate the environment sequential. Never split changes to the same file across parallel calls.
- Do not duplicate searches or add speculative calls merely to create a parallel batch.
- A tool marked sequential makes its entire batch sequential; request_confirmation must remain the only tool in its assistant response.`;

export const EDIT_TOOL_COMPATIBILITY_GUIDANCE = `## File editing tool compatibility
- This runtime does not provide an apply_patch tool or shell command.
- Use the edit tool for precise file changes; its input is path plus edits with exact oldText and newText values.
- If another instruction mentions apply_patch, translate that intent to the edit tool.
- Never invoke apply_patch through bash or PowerShell.

## Tool execution discipline
- Prefer dedicated read, search, and edit tools over equivalent shell commands when those tools are available.
- Do not assume optional commands such as rg, jq, node, or python exist on the Bash PATH. Check with command -v before first use, then use an available dedicated tool if absent.
- Keep shell commands to one execution layer; avoid nested Bash, cmd.exe, PowerShell, or Node quoting when a direct tool can perform the operation.
- Do not run failure-prone shell probes when an available read-only tool can provide the same information.`;
