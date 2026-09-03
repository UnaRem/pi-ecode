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
