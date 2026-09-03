export const EDIT_TOOL_COMPATIBILITY_GUIDANCE = `## File editing tool compatibility
- This runtime does not provide an apply_patch tool or shell command.
- Use the edit tool for precise file changes; its input is path plus edits with exact oldText and newText values.
- If another instruction mentions apply_patch, translate that intent to the edit tool.
- Never invoke apply_patch through bash or PowerShell.`;
