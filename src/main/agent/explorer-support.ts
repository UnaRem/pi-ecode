import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { type AgentSession, type SessionEntry, SessionManager, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { ProjectAgentDefinition } from "../../shared/agent-contracts.js";
import type { ConversationItem, ExplorerTask, ExplorerTimelineSnapshot, ThinkingLevel, ValidationState } from "../../shared/contracts.js";
import { messageItem } from "./timeline-mapper.js";

export const EXPLORER_STATE_ENTRY = "pi-ecode.explorer-state";
export const EXPLORER_COMPLETION_MESSAGE = "pi-ecode.explorer-completion";
export const MAX_CONCURRENT_EXPLORERS = 3;
export const MAX_FINAL_TEXT_LENGTH = 16 * 1024;
export const TIMELINE_THROTTLE_MS = 33;
export const COMPLETION_COALESCE_MS = 50;
export const TERMINAL_STATUSES = new Set<ExplorerTask["status"]>(["completed", "failed", "interrupted"]);
export const EXPLORER_TOOL_NAMES = ["read", "ffgrep", "fffind"] as const;

export const DEFAULT_WATCHDOG = {
  warningMs: 60_000,
  inactivityMs: 3 * 60_000,
  totalMs: 10 * 60_000,
  intervalMs: 5_000,
  maxAttempts: 2,
} as const;

export const EXPLORER_CHILD_GUIDANCE = `## PiECode 子代理
你是由主会话编排的项目子代理。
- 只处理本次委派的目标和范围，重新核实当前源码，不依赖过时记忆。
- 不嵌套派发，不询问用户，不修改代理配置或主会话状态。
- 只调用本会话实际提供的工具；没有写工具时不得声称已修改文件。
- 用中文给出自包含报告，引用相关路径和符号；受阻时明确说明证据和阻塞点。`;

export interface ExplorerLocator {
  taskId: string;
  attempt: number;
  sessionFile: string;
  startMessageIndex?: number;
  endMessageIndex?: number;
}

export interface ExplorerCompletionNotice {
  id: string;
  taskId: string;
  createdAt: number;
  deliveredAt?: number;
  acknowledgedAt?: number;
}

export interface ExplorerAgentSnapshot {
  taskId: string;
  agentId: string;
  role: ProjectAgentDefinition["role"];
  prompt: string;
  disabledTools: string[];
  provider: string;
  modelId: string;
  autoCompactionEnabled: boolean;
  compactionThresholdPercent: number | null;
}

export interface ExplorerGeneration {
  id: string;
  agentId: string;
  provider: string;
  modelId: string;
  sessionFile: string;
  createdAt: number;
  lastUsedAt: number;
}

export interface ExplorerStateEntry {
  version: 5;
  tasks: ExplorerTask[];
  locators: ExplorerLocator[];
  completions: ExplorerCompletionNotice[];
  agentSnapshots: ExplorerAgentSnapshot[];
  generations: ExplorerGeneration[];
}

export interface ExplorerRequest {
  agent_id?: string;
  task_name: string;
  title: string;
  objective: string;
  scope: string;
  deliverable: string;
  write_scope?: string[];
}

export interface ExplorerRunResult {
  sessionId: string;
  finalText: string;
}

export interface WatchdogOptions {
  warningMs: number;
  inactivityMs: number;
  totalMs: number;
  intervalMs: number;
  maxAttempts: number;
}

export interface ExplorerServiceOptions {
  getParentSession: () => AgentSession | undefined;
  onChange: (tasks: ExplorerTask[]) => void;
  onTimeline?: (snapshot: ExplorerTimelineSnapshot) => void;
  runExplorer?: (task: ExplorerTask, request: ExplorerRequest, parent: AgentSession, signal: AbortSignal) => Promise<ExplorerRunResult>;
  watchdog?: Partial<WatchdogOptions>;
  now?: () => number;
  getAgentDefinitions?: () => ProjectAgentDefinition[];
  getMaxConcurrent?: () => number;
  getSessionRoot?: (parent: AgentSession) => string;
  runValidation?: () => Promise<ValidationState>;
}

export const ExplorerTaskIdParameters = Type.Object({
  task_id: Type.String({ minLength: 1, maxLength: 200, description: "任务 ID" }),
});

export const ExplorerWaitParameters = Type.Object({
  task_ids: Type.Array(Type.String({ minLength: 1, maxLength: 200 }), { minItems: 1, maxItems: 8, description: "等待的子代理任务 ID" }),
  mode: Type.Union([Type.Literal("all"), Type.Literal("any")], { description: "all 等待全部终态；any 等待任一终态" }),
});

export const AgentMessageParameters = Type.Object({
  agent_id: Type.String({ minLength: 1, maxLength: 80, description: "项目代理 ID" }),
  message: Type.String({ minLength: 1, maxLength: 4000, description: "发送给空闲代理的后续任务或追问" }),
  deliverable: Type.Optional(Type.String({ minLength: 1, maxLength: 800, description: "期望报告格式" })),
  write_scope: Type.Array(Type.String({ minLength: 1, maxLength: 500 }), { minItems: 0, maxItems: 30, description: "编辑者传非空写入范围；其他角色传空数组" }),
});

export const ExplorerStatusParameters = Type.Object({
  task_id: Type.String({ minLength: 0, maxLength: 200, description: "任务 ID；传空字符串返回运行中或未读任务" }),
});

export const ExplorerParameters = Type.Object({
  description: Type.String({ minLength: 1, maxLength: 160, description: "派发这一组任务的简短原因" }),
  thinking_level: Type.Optional(Type.Union([Type.Literal("low"), Type.Literal("medium")], { description: "可选批次覆盖；默认使用各代理配置" })),
  explorers: Type.Array(Type.Object({
    agent_id: Type.Optional(Type.String({ minLength: 1, maxLength: 80, description: "项目代理 ID；省略时自动选择空闲探索者" })),
    task_name: Type.String({ minLength: 1, maxLength: 40, pattern: "^[a-z][a-z0-9_]*$", description: "唯一 snake_case 任务名" }),
    title: Type.String({ minLength: 1, maxLength: 100, description: "用户可见短标题" }),
    objective: Type.String({ minLength: 1, maxLength: 800, description: "一个具体目标" }),
    scope: Type.String({ minLength: 1, maxLength: 800, description: "明确的文件、目录或模块范围" }),
    deliverable: Type.String({ minLength: 1, maxLength: 800, description: "证据和报告要求" }),
    write_scope: Type.Array(Type.String({ minLength: 1, maxLength: 500 }), { minItems: 0, maxItems: 30, description: "编辑者传非空相对写入范围；其他角色传空数组；目录使用 /** 后缀" }),
  }), { minItems: 1, maxItems: 8 }),
});

export function cloneTasks(tasks: Iterable<ExplorerTask>): ExplorerTask[] {
  return [...tasks].map((task) => ({ ...task }));
}

export function normalizeTask(task: ExplorerTask): ExplorerTask {
  const levels: ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
  return {
    ...task,
    thinkingLevel: levels.includes(task.thinkingLevel) ? task.thinkingLevel : "low",
    attempt: Number.isInteger(task.attempt) && task.attempt > 0 ? task.attempt : 1,
    maxAttempts: Number.isInteger(task.maxAttempts) && task.maxAttempts > 0 ? task.maxAttempts : DEFAULT_WATCHDOG.maxAttempts,
    revision: Number.isInteger(task.revision) ? task.revision : 0,
  };
}

export function restoredState(entries: readonly SessionEntry[]): ExplorerStateEntry | null {
  let restored: ExplorerStateEntry | null = null;
  for (const entry of entries) {
    if (entry.type !== "custom" || entry.customType !== EXPLORER_STATE_ENTRY) continue;
    const state = entry.data as Partial<ExplorerStateEntry> | undefined;
    if (!state || !Array.isArray(state.tasks)) continue;
    restored = {
      version: 5,
      tasks: state.tasks.map(normalizeTask),
      locators: Array.isArray(state.locators) ? state.locators.map((locator) => ({ ...locator })) : [],
      completions: Array.isArray(state.completions) ? state.completions.map((notice) => ({ ...notice })) : [],
      agentSnapshots: Array.isArray(state.agentSnapshots) ? state.agentSnapshots.map((snapshot) => ({
        ...snapshot,
        disabledTools: [...snapshot.disabledTools],
        autoCompactionEnabled: snapshot.autoCompactionEnabled ?? true,
        compactionThresholdPercent: snapshot.compactionThresholdPercent ?? null,
      })) : [],
      generations: Array.isArray(state.generations) ? state.generations.map((generation) => ({ ...generation })) : [],
    };
  }
  return restored;
}

export function explorerToolDefinitions(parent: Pick<AgentSession, "getToolDefinition">, names: readonly string[] = EXPLORER_TOOL_NAMES): ToolDefinition[] {
  return names.map((name) => {
    const definition = parent.getToolDefinition(name);
    if (!definition) throw new Error(`parent ${name} tool（父会话 ${name} 工具）当前不可用。`);
    return definition;
  });
}

export function compactionReserveTokens(contextWindow: number, thresholdPercent: number): number {
  return Math.max(1, Math.floor(contextWindow * (1 - thresholdPercent / 100)));
}

export function validationResultText(state: ValidationState): string {
  const steps = state.steps.filter((step) => step.status !== "skipped")
    .map((step) => `- ${step.label}: ${step.status}${step.exitCode === null ? "" : `（退出码 ${step.exitCode}）`}`)
    .join("\n");
  return `验证状态：${state.status}\n${state.message ?? "固定验证已结束。"}${steps ? `\n${steps}` : ""}`;
}

export function compactFinalText(text: string): string {
  return text.length <= MAX_FINAL_TEXT_LENGTH ? text : `${text.slice(0, MAX_FINAL_TEXT_LENGTH)}\n…[子代理报告已截断]`;
}

export function taskPrompt(request: ExplorerRequest): string {
  return `## 子代理任务
任务标题：${request.title}
任务目标：${request.objective}
工作范围：${request.scope}
交付要求：${request.deliverable}

请重新核实当前源码后，用中文输出自包含报告；不要输出英文 XML 标签，不要修改任务范围之外的内容。`;
}

export function namespaceTimeline(taskId: string, attempt: number, timeline: ConversationItem[]): ConversationItem[] {
  return timeline.map((item): ConversationItem => item.kind === "message"
    ? { ...item, id: `${taskId}:${attempt}:${item.id}`, message: { ...item.message, id: `${taskId}:${attempt}:${item.message.id}` } }
    : { ...item, id: `${taskId}:${attempt}:${item.id}`, tool: { ...item.tool, id: `${taskId}:${attempt}:${item.tool.id}` } });
}

export function attemptSeparator(taskId: string, attempt: number, timestamp: number): ConversationItem {
  return messageItem({ id: `${taskId}:${attempt}:retry`, role: "assistant", text: `长时间无活动，开始第 ${attempt}/${DEFAULT_WATCHDOG.maxAttempts} 次尝试。`, timestamp });
}

export function messagesForLocator(locator: ExplorerLocator): AgentMessage[] {
  const messages = SessionManager.open(locator.sessionFile).getBranch().flatMap((entry) => entry.type === "message" ? [entry.message] : []);
  return messages.slice(locator.startMessageIndex ?? 0, locator.endMessageIndex ?? messages.length);
}

export function rawToolCallId(namespacedId: string): { attempt: number; toolCallId: string } | null {
  const match = /^[^:]+:(\d+):(.*)$/u.exec(namespacedId);
  return match ? { attempt: Number(match[1]), toolCallId: match[2] ?? "" } : null;
}

export class ExplorerWatchdogError extends Error {
  constructor(readonly reason: "inactivity" | "total") {
    super(reason === "inactivity" ? "子代理 3 分钟无活动。" : "子代理超过 10 分钟运行上限。");
  }
}
