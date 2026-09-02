export type ToolCategory = "inspect" | "mutate" | "execute" | "research" | "version" | "plan" | "other";

const INSPECT_TOOLS = new Set(["read", "ffgrep", "fffind", "grep", "find", "ls"]);
const MUTATION_TOOLS = new Set(["edit", "write", "apply_patch"]);
const RESEARCH_TOOLS = new Set(["web_search", "source_check", "fetch_content", "get_search_content"]);

export function toolCategory(name: string, input: string): ToolCategory {
  const normalizedName = name.toLowerCase();
  if (normalizedName === "task_plan" || normalizedName === "todo") return "plan";
  if (normalizedName.includes("checkpoint") || normalizedName.includes("git")) return "version";
  if ((normalizedName === "bash" || normalizedName === "powershell") && /^\s*git(?:\s|$)/i.test(input)) return "version";
  if (INSPECT_TOOLS.has(normalizedName)) return "inspect";
  if (MUTATION_TOOLS.has(normalizedName)) return "mutate";
  if (RESEARCH_TOOLS.has(normalizedName)) return "research";
  if (normalizedName === "bash" || normalizedName === "powershell") return "execute";
  return "other";
}

export function toolCategoryLabel(category: ToolCategory): string {
  switch (category) {
    case "inspect": return "INSPECT";
    case "mutate": return "CHANGE";
    case "execute": return "RUN";
    case "research": return "RESEARCH";
    case "version": return "VERSION";
    case "plan": return "PLAN";
    default: return "TOOL";
  }
}
