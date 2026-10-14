import { stat } from "node:fs/promises";
import { join } from "node:path";
import type { ExtensionFactory, ToolInfo } from "@earendil-works/pi-coding-agent";
import type { ToolCapability, ToolStatistic } from "../../shared/tool-statistics.js";
import type { ToolStatisticsStore } from "./tool-statistics.js";

const CAPABILITY_RULES: [ToolCapability, RegExp][] = [
  // Match document providers before generic read/search verbs; "exa" must not match "Examples".
  ["web-search", /web_search|source_check|fetch_content|(^|__)(exa|context7|deepwiki)(__|$)|\b(exa|context7|deepwiki)\b|网络搜索/iu],
  ["file-search", /ffgrep|fff?find|grep|glob|find_files|search_files|codegraph|文件搜索|查找文件|调用关系/iu],
  ["file-read", /(^|__)(read|inspect_local_file)(_|$)|read_file|读取文件/iu],
  ["file-edit", /(^|__)(edit|write|replace)(_|$)|edit_file|write_file|修改文件/iu],
  ["browser", /playwright|chrome_devtools|browser|浏览器/iu],
  ["git", /(^|__)git|版本/iu],
  ["shell", /(^|__)(bash|powershell|execute_command)|shell|命令/iu],
];

export function toolCapability(tool: Pick<ToolInfo, "name" | "description">): ToolCapability {
  return CAPABILITY_RULES.find(([, pattern]) => pattern.test(tool.name))?.[0]
    ?? CAPABILITY_RULES.find(([, pattern]) => pattern.test(tool.description))?.[0] ?? "other";
}

const TOOL_SELECTION_GUIDANCE = `Tool selection guidance:
- Identify the current operation from the conversation and latest tool results, not only the original user request.
- Prefer a dedicated tool when its description, namespace guidance and parameter schema match the exact operation, inputs and permissions. A shared capability label does not make tools interchangeable.
- Before using a general shell, check declared dedicated tools. If no suitable declared tool is evident, use tool_search when available to discover alternatives with concrete operation and parameter terms (for example, "git working tree status", not just "git").
- tool_search loads inactive deferred/codemode tools for the next model call; compare already declared tools using their definitions. Use the shell when dedicated tools are unavailable or do not support the required operation or parameters.
- Check current availability, permissions and required indexes before execution. Do not initialize indexes, add retries or bypass confirmation or permission failures.
- Execution observations below are unranked feedback, not tool candidates. Compare them only after tools fit the same concrete operation; keep direct and nested samples separate. Fewer than 5 completed samples is insufficient evidence, speed is secondary, and execution success does not prove task success.`;

export function declaredToolStatistics(tools: ToolInfo[], activeToolNames: string[], statistics: ToolStatistic[]): ToolStatistic[] {
  const active = new Set(activeToolNames);
  const declared = new Set(tools.filter((tool) => tool.exposure !== "hidden" && active.has(tool.name)).map((tool) => tool.name));
  return statistics.filter((entry) => declared.has(entry.name));
}

export function toolSelectionAdvice(tools: ToolInfo[], activeToolNames: string[], statistics: ToolStatistic[]): string {
  const observations = declaredToolStatistics(tools, activeToolNames, statistics)
    .toSorted((left, right) => left.name.localeCompare(right.name) || Number(left.nested) - Number(right.nested))
    .map((entry) => `${entry.name}: samples=${entry.successes + entry.failures}, sampleMode=${entry.nested ? "nested" : "direct"}, execution successes=${entry.successes}, failures=${entry.failures}, cancelled=${entry.cancelled}, blocked=${entry.blocked}, medianMs=${entry.medianMs ?? "unknown"}`);
  return [TOOL_SELECTION_GUIDANCE, ...(observations.length ? ["Local execution observations for currently declared tools (unranked):", ...observations] : [])].join("\n");
}

async function availableTools(tools: ToolInfo[], cwd: string): Promise<ToolInfo[]> {
  if (!tools.some((tool) => /codegraph/iu.test(tool.name))) return tools;
  const indexed = await stat(join(cwd, ".codegraph", "codegraph.db")).then((index) => index.isFile(), () => false);
  return tools.filter((tool) => indexed || !/codegraph/iu.test(tool.name));
}

export function toolAdvisorExtension(store: ToolStatisticsStore | undefined, onError: (message: string) => void): ExtensionFactory {
  return (pi) => {
    pi.on("context", async (event, context) => {
      const tools = await availableTools(pi.getAllTools(), context.cwd);
      // Request-local guidance must survive cold starts without becoming persisted conversation history.
      return { messages: [...event.messages, { role: "custom", customType: "pi-ecode.tool-advice", display: false, timestamp: Date.now(),
        content: toolSelectionAdvice(tools, pi.getActiveTools(), store?.current ?? []), details: undefined }] };
    });
    pi.on("tool_call", async (event, context) => {
      const definition = pi.getAllTools().find((tool) => tool.name === event.toolName);
      // Validate current exposure and the required index without substituting incompatible tools.
      if (definition?.exposure === "hidden") return { block: true, reason: "Tool is no longer available. Discover an appropriate active tool." };
      if (definition && !(await availableTools([definition], context.cwd)).length) return { block: true, reason: "当前工作目录缺少 .codegraph/codegraph.db，请使用文件搜索工具；不会自动初始化索引。" };
    });
    pi.on("tool_execution_end", (event, context) => {
      if (!store) return;
      const definition = pi.getAllTools().find((tool) => tool.name === event.toolName);
      const outcome = context.signal?.aborted ? "cancelled" : event.durationMs === undefined ? "blocked" : event.isError ? "failures" : "successes";
      void store.record({ name: event.toolName, capability: toolCapability(definition ?? { name: event.toolName, description: "" }),
        nested: Boolean(event.parentToolCallId), outcome, ...(event.durationMs === undefined ? {} : { durationMs: event.durationMs }) })
        .catch((error: unknown) => onError(`工具统计保存失败：${error instanceof Error ? error.message : String(error)}`));
    });
  };
}
