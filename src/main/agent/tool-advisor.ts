import { stat } from "node:fs/promises";
import { join } from "node:path";
import type { ExtensionFactory, ToolInfo } from "@earendil-works/pi-coding-agent";
import type { ToolCapability, ToolStatistic } from "../../shared/tool-statistics.js";
import { textFromContent } from "./message-mapper.js";
import type { ToolStatisticsStore } from "./tool-statistics.js";

const CAPABILITY_RULES: [ToolCapability, RegExp][] = [
  ["file-search", /ffgrep|fff?find|grep|glob|find_files|search_files|codegraph|文件搜索|查找文件|调用关系/iu],
  ["file-read", /(^|__)(read|inspect_local_file)(_|$)|read_file|读取文件/iu],
  ["file-edit", /(^|__)(edit|write|replace)(_|$)|edit_file|write_file|修改文件/iu],
  ["web-search", /web_search|source_check|fetch_content|exa|context7|deepwiki|网络搜索/iu],
  ["browser", /playwright|chrome_devtools|browser|浏览器/iu],
  ["git", /(^|__)git|版本/iu],
  ["shell", /(^|__)(bash|powershell|execute_command)|shell|命令/iu],
];

export function toolCapability(tool: Pick<ToolInfo, "name" | "description">): ToolCapability {
  return CAPABILITY_RULES.find(([, pattern]) => pattern.test(tool.name))?.[0]
    ?? CAPABILITY_RULES.find(([, pattern]) => pattern.test(tool.description))?.[0] ?? "other";
}

function quality(statistic: ToolStatistic | undefined): number {
  if (!statistic || statistic.successes + statistic.failures < 5) return 5;
  const reliability = (statistic.successes + 1) / (statistic.successes + statistic.failures + 2);
  return reliability * 10 - Math.log10(1 + (statistic.medianMs ?? 0)) * .1;
}

function recommendationMetrics(statistics: ToolStatistic[]): Map<string, ToolStatistic> {
  // Prefer the group with more completed samples; direct calls win ties. Never pool nested latency.
  return new Map(statistics.toSorted((left, right) => (left.successes + left.failures) - (right.successes + right.failures)
    || Number(right.nested) - Number(left.nested)).map((entry) => [entry.name, entry]));
}

export function recommendTools(tools: ToolInfo[], statistics: ToolStatistic[], prompt: string): ToolInfo[] {
  const desired = new Set<ToolCapability>();
  if (/文件|源码|代码|函数|符号|调用关系|file|code|symbol/iu.test(prompt)) { desired.add("file-search"); desired.add("file-read"); }
  if (/修改|修复|实现|edit|fix|implement/iu.test(prompt)) desired.add("file-edit");
  if (/搜索|资料|文档|search|research|documentation|https?:/iu.test(prompt)) desired.add("web-search");
  if (/界面|浏览器|页面|ui|browser|page/iu.test(prompt)) desired.add("browser");
  if (/git|提交|版本/iu.test(prompt)) desired.add("git");
  const metrics = recommendationMetrics(statistics);
  const counts = new Map<ToolCapability, number>();
  return tools.filter((tool) => tool.exposure !== "hidden" && toolCapability(tool) !== "other"
    && (desired.size === 0 || desired.has(toolCapability(tool))))
    .sort((left, right) => toolCapability(left).localeCompare(toolCapability(right))
      || quality(metrics.get(right.name)) - quality(metrics.get(left.name)) || left.name.localeCompare(right.name))
    .filter((tool) => {
      const capability = toolCapability(tool);
      const count = counts.get(capability) ?? 0;
      counts.set(capability, count + 1);
      return count < 2;
    });
}

async function availableTools(tools: ToolInfo[], cwd: string): Promise<ToolInfo[]> {
  if (!tools.some((tool) => /codegraph/iu.test(tool.name))) return tools;
  const indexed = await stat(join(cwd, ".codegraph", "codegraph.db")).then((index) => index.isFile(), () => false);
  return tools.filter((tool) => indexed || !/codegraph/iu.test(tool.name));
}

export function toolAdvisorExtension(store: ToolStatisticsStore | undefined, onError: (message: string) => void): ExtensionFactory {
  return (pi) => {
    pi.on("context", async (event, context) => {
      const user = event.messages.findLast((message) => message.role === "user");
      const statistics = store?.current ?? [];
      const candidates = recommendTools(await availableTools(pi.getAllTools(), context.cwd), statistics, user?.role === "user" ? textFromContent(user.content) : "");
      if (!candidates.length) return;
      const metrics = recommendationMetrics(statistics);
      const lines = candidates.map((tool) => {
        const metric = metrics.get(tool.name);
        return `${toolCapability(tool)}: ${tool.name} (${tool.exposure ?? "direct"}); samples=${(metric?.successes ?? 0) + (metric?.failures ?? 0)}, sampleMode=${metric ? metric.nested ? "nested" : "direct" : "unknown"}, execution successes=${metric?.successes ?? 0}, failures=${metric?.failures ?? 0}, medianMs=${metric?.medianMs ?? "unknown"}`;
      });
      return { messages: [...event.messages, { role: "custom", customType: "pi-ecode.tool-advice", display: false, timestamp: Date.now(),
        content: `Local tool candidates (capabilities inferred from names/descriptions):\n${lines.join("\n")}\nMatch the current operation, parameters, permissions and available index before selecting. Compare reliability only within the same capability; speed is secondary. Fewer than 5 samples is insufficient evidence. Deferred tools require tool_search. Execution success does not prove task success. These are recommendations, not equivalent replacements; do not add retries or bypass confirmation.`, details: undefined }] };
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
