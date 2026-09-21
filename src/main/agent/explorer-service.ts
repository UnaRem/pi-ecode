import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
  createAgentSessionFromServices,
  createAgentSessionServices,
  getAgentDir,
  type AgentSession,
  type AgentSessionEvent,
  type ExtensionAPI,
  type ExtensionContext,
  type InlineExtension,
  type SessionEntry,
  SessionManager,
  SettingsManager,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { ConversationItem, ExplorerTask, ExplorerTimelineSnapshot, ThinkingLevel } from "../../shared/contracts.js";
import type { ProjectAgentDefinition } from "../../shared/agent-contracts.js";
import { formatToolInput, textFromContent, textFromToolResult, toolOutputView, toolTitle } from "./message-mapper.js";
import { mapTimeline, messageItem, toolItem } from "./timeline-mapper.js";
import { NativeCompaction } from "./native-compaction.js";

const EXPLORER_STATE_ENTRY = "pi-ecode.explorer-state";
const EXPLORER_COMPLETION_MESSAGE = "pi-ecode.explorer-completion";
const MAX_CONCURRENT_EXPLORERS = 3;
const MAX_DISPATCH_TASKS = 8;
const MAX_FINAL_TEXT_LENGTH = 16 * 1024;
const TIMELINE_THROTTLE_MS = 33;
const COMPLETION_COALESCE_MS = 50;
const TERMINAL_STATUSES = new Set<ExplorerTask["status"]>(["completed", "failed", "interrupted"]);
export const EXPLORER_TOOL_NAMES = ["read", "ffgrep", "fffind"] as const;

const DEFAULT_WATCHDOG = {
  warningMs: 60_000,
  inactivityMs: 3 * 60_000,
  totalMs: 10 * 60_000,
  intervalMs: 5_000,
  maxAttempts: 2,
} as const;

const EXPLORER_CHILD_GUIDANCE = `## PiECode read-only Explorer
You are a leaf Explorer working for a parent coding agent.
- Investigate only the delegated objective and scope.
- You can only use the parent's read, ffgrep, and fffind tools. Never claim to edit files or execute commands.
- Other Explorers may be running concurrently. Report only evidence you personally verified.
- Cite relevant file paths and finish with a concise, actionable result for the parent agent.
- If the task cannot be answered with the available read-only tools, state the blocker instead of guessing.`;

interface ExplorerLocator {
  taskId: string;
  attempt: number;
  sessionFile: string;
  startMessageIndex?: number;
  endMessageIndex?: number;
}

interface ExplorerCompletionNotice {
  id: string;
  taskId: string;
  createdAt: number;
  deliveredAt?: number;
  acknowledgedAt?: number;
}

interface ExplorerAgentSnapshot {
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

interface ExplorerGeneration {
  id: string;
  agentId: string;
  provider: string;
  modelId: string;
  sessionFile: string;
  createdAt: number;
  lastUsedAt: number;
}

interface ExplorerStateEntry {
  version: 5;
  tasks: ExplorerTask[];
  locators: ExplorerLocator[];
  completions: ExplorerCompletionNotice[];
  agentSnapshots: ExplorerAgentSnapshot[];
  generations: ExplorerGeneration[];
}

interface ExplorerRequest {
  agent_id?: string;
  task_name: string;
  title: string;
  objective: string;
  scope: string;
  deliverable: string;
}

interface ExplorerRunResult {
  sessionId: string;
  finalText: string;
}

interface WatchdogOptions {
  warningMs: number;
  inactivityMs: number;
  totalMs: number;
  intervalMs: number;
  maxAttempts: number;
}

interface ExplorerServiceOptions {
  getParentSession: () => AgentSession | undefined;
  onChange: (tasks: ExplorerTask[]) => void;
  onTimeline?: (snapshot: ExplorerTimelineSnapshot) => void;
  runExplorer?: (
    task: ExplorerTask,
    request: ExplorerRequest,
    parent: AgentSession,
    signal: AbortSignal,
  ) => Promise<ExplorerRunResult>;
  watchdog?: Partial<WatchdogOptions>;
  now?: () => number;
  getAgentDefinitions?: () => ProjectAgentDefinition[];
  getMaxConcurrent?: () => number;
  getSessionRoot?: (parent: AgentSession) => string;
}

const ExplorerTaskIdParameters = Type.Object({
  task_id: Type.String({ minLength: 1, maxLength: 200, description: "任务 ID" }),
});

const AgentMessageParameters = Type.Object({
  agent_id: Type.String({ minLength: 1, maxLength: 80, description: "项目代理 ID" }),
  message: Type.String({ minLength: 1, maxLength: 4000, description: "发送给空闲代理的后续任务或追问" }),
  deliverable: Type.Optional(Type.String({ minLength: 1, maxLength: 800, description: "期望报告格式" })),
});

const ExplorerStatusParameters = Type.Object({
  task_id: Type.Optional(Type.String({ minLength: 1, maxLength: 200, description: "可选任务 ID；省略时返回全部任务" })),
});

const ExplorerParameters = Type.Object({
  description: Type.String({ minLength: 1, maxLength: 160, description: "Short reason for this parallel investigation" }),
  thinking_level: Type.Optional(Type.Union([Type.Literal("low"), Type.Literal("medium")], {
    description: "Explorer reasoning level. Defaults to low; use medium only for complex cross-module synthesis.",
  })),
  explorers: Type.Array(Type.Object({
    agent_id: Type.Optional(Type.String({ minLength: 1, maxLength: 80, description: "项目代理 ID；省略时自动选择空闲探索者" })),
    task_name: Type.String({ minLength: 1, maxLength: 40, pattern: "^[a-z][a-z0-9_]*$", description: "Unique snake_case task identifier" }),
    title: Type.String({ minLength: 1, maxLength: 100, description: "Short user-visible task title" }),
    objective: Type.String({ minLength: 1, maxLength: 800, description: "One concrete question this Explorer must answer" }),
    scope: Type.String({ minLength: 1, maxLength: 800, description: "Exact files, directories, or modules this Explorer may inspect" }),
    deliverable: Type.String({ minLength: 1, maxLength: 800, description: "Evidence and result the parent needs back" }),
  }), { minItems: 1, maxItems: MAX_DISPATCH_TASKS }),
});

function cloneTasks(tasks: Iterable<ExplorerTask>): ExplorerTask[] {
  return [...tasks].map((task) => ({ ...task }));
}

function normalizeTask(task: ExplorerTask): ExplorerTask {
  return {
    ...task,
    thinkingLevel: (["off", "minimal", "low", "medium", "high", "xhigh", "max"] as ThinkingLevel[]).includes(task.thinkingLevel) ? task.thinkingLevel : "low",
    attempt: Number.isInteger(task.attempt) && task.attempt > 0 ? task.attempt : 1,
    maxAttempts: Number.isInteger(task.maxAttempts) && task.maxAttempts > 0 ? task.maxAttempts : DEFAULT_WATCHDOG.maxAttempts,
    revision: Number.isInteger(task.revision) ? task.revision : 0,
  };
}

function restoredState(entries: readonly SessionEntry[]): ExplorerStateEntry | null {
  let restored: ExplorerStateEntry | null = null;
  for (const entry of entries) {
    if (entry.type !== "custom" || entry.customType !== EXPLORER_STATE_ENTRY) continue;
    const state = entry.data as Partial<ExplorerStateEntry> | undefined;
    if (!state || !Array.isArray(state.tasks)) continue;
    restored = {
      version: 5,
      tasks: state.tasks.map((task) => normalizeTask(task)),
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

export function explorerToolDefinitions(
  parent: Pick<AgentSession, "getToolDefinition">,
  names: readonly string[] = EXPLORER_TOOL_NAMES,
): ToolDefinition[] {
  return names.map((name) => {
    const definition = parent.getToolDefinition(name);
    if (!definition) throw new Error(`Explorer requires the parent ${name} tool, but it is not available.`);
    return definition;
  });
}

export function compactionReserveTokens(contextWindow: number, thresholdPercent: number): number {
  return Math.max(1, Math.floor(contextWindow * (1 - thresholdPercent / 100)));
}

function compactFinalText(text: string): string {
  if (text.length <= MAX_FINAL_TEXT_LENGTH) return text;
  return `${text.slice(0, MAX_FINAL_TEXT_LENGTH)}\n…[Explorer result truncated]`;
}

function taskPrompt(request: ExplorerRequest): string {
  return `<explorer_task>
<task_name>${request.task_name}</task_name>
<objective>${request.objective}</objective>
<scope>${request.scope}</scope>
<deliverable>${request.deliverable}</deliverable>
</explorer_task>`;
}

function namespaceTimeline(taskId: string, attempt: number, timeline: ConversationItem[]): ConversationItem[] {
  return timeline.map((item): ConversationItem => item.kind === "message"
    ? { ...item, id: `${taskId}:${attempt}:${item.id}`, message: { ...item.message, id: `${taskId}:${attempt}:${item.message.id}` } }
    : { ...item, id: `${taskId}:${attempt}:${item.id}`, tool: { ...item.tool, id: `${taskId}:${attempt}:${item.tool.id}` } });
}

function attemptSeparator(taskId: string, attempt: number, timestamp: number): ConversationItem {
  return messageItem({
    id: `${taskId}:${attempt}:retry`,
    role: "assistant",
    text: `Retrying Explorer attempt ${attempt}/${DEFAULT_WATCHDOG.maxAttempts} after extended inactivity.`,
    timestamp,
  });
}

function messagesFromFile(sessionFile: string): AgentMessage[] {
  return SessionManager.open(sessionFile).getBranch().flatMap((entry) => entry.type === "message" ? [entry.message] : []);
}

function messagesForLocator(locator: ExplorerLocator): AgentMessage[] {
  const messages = messagesFromFile(locator.sessionFile);
  return messages.slice(locator.startMessageIndex ?? 0, locator.endMessageIndex ?? messages.length);
}

function rawToolCallId(namespacedId: string): { attempt: number; toolCallId: string } | null {
  const match = /^[^:]+:(\d+):(.*)$/u.exec(namespacedId);
  return match ? { attempt: Number(match[1]), toolCallId: match[2] ?? "" } : null;
}

class ExplorerWatchdogError extends Error {
  constructor(readonly reason: "inactivity" | "total") {
    super(reason === "inactivity" ? "Explorer had no activity for 3 minutes." : "Explorer exceeded the 10 minute time limit.");
  }
}

export class ExplorerService {
  private readonly tasks = new Map<string, ExplorerTask>();
  private readonly queue: string[] = [];
  private readonly controllers = new Map<string, AbortController>();
  private readonly operations = new Set<Promise<void>>();
  private readonly completions = new Map<string, ExplorerCompletionNotice>();
  private readonly taskAgents = new Map<string, ExplorerAgentSnapshot>();
  private readonly generations = new Map<string, ExplorerGeneration>();
  private readonly locators = new Map<string, ExplorerLocator[]>();
  private readonly liveSessions = new Map<string, AgentSession>();
  private readonly timelines = new Map<string, ExplorerTimelineSnapshot>();
  private readonly timelineTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private completionTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly now: () => number;
  private readonly watchdog: WatchdogOptions;
  private readonly runExplorer: ExplorerServiceOptions["runExplorer"] extends infer T ? NonNullable<T> : never;
  private extensionApi: ExtensionAPI | undefined;
  private generation = 0;
  private disposed = false;

  constructor(private readonly options: ExplorerServiceOptions) {
    this.now = options.now ?? Date.now;
    this.watchdog = { ...DEFAULT_WATCHDOG, ...options.watchdog };
    this.runExplorer = options.runExplorer ?? ((task, request, parent, signal) => this.runChildSession(task, request, parent, signal));
  }

  get current(): ExplorerTask[] {
    return cloneTasks(this.tasks.values());
  }

  get isActive(): boolean {
    return this.current.some((task) => task.status === "queued" || task.status === "running");
  }

  get workingStartedAt(): number | null {
    const starts = this.current
      .filter((task) => task.status === "queued" || task.status === "running")
      .map((task) => task.startedAt ?? task.queuedAt);
    return starts.length > 0 ? Math.min(...starts) : null;
  }

  asExtension(): InlineExtension {
    return { name: "pi-ecode-explorers", factory: (pi) => this.register(pi) };
  }

  async getTimeline(taskId: string): Promise<ExplorerTimelineSnapshot> {
    const task = this.requireTask(taskId);
    const live = this.timelines.get(taskId);
    if (live) return structuredClone(live);
    const timeline: ConversationItem[] = [];
    for (const locator of this.locators.get(taskId) ?? []) {
      if (locator.attempt > 1) timeline.push(attemptSeparator(taskId, locator.attempt, task.startedAt ?? task.queuedAt));
      timeline.push(...namespaceTimeline(taskId, locator.attempt, mapTimeline(messagesForLocator(locator))));
    }
    const snapshot = { taskId, revision: task.revision, timeline };
    this.timelines.set(taskId, snapshot);
    return structuredClone(snapshot);
  }

  async getToolOutput(taskId: string, toolCallId: string): Promise<string> {
    this.requireTask(taskId);
    const parsed = rawToolCallId(toolCallId);
    if (!parsed) throw new Error("Invalid Explorer tool call id.");
    const live = this.liveSessions.get(taskId);
    const locator = this.locatorForAttempt(taskId, parsed.attempt);
    const messages = live && this.tasks.get(taskId)?.attempt === parsed.attempt
      ? this.taskMessages(this.requireTask(taskId), live.messages)
      : messagesForLocator(locator);
    const result = messages.findLast((message) => message.role === "toolResult" && message.toolCallId === parsed.toolCallId);
    if (!result || result.role !== "toolResult") throw new Error("Explorer tool output is not available.");
    return textFromContent(result.content);
  }

  async interrupt(taskId: string): Promise<void> {
    const task = this.requireTask(taskId);
    if (TERMINAL_STATUSES.has(task.status)) return;
    task.status = "interrupted";
    task.activity = "Stopped by user";
    task.endedAt = this.now();
    this.bump(task);
    this.controllers.get(taskId)?.abort();
    const queuedIndex = this.queue.indexOf(taskId);
    if (queuedIndex >= 0) this.queue.splice(queuedIndex, 1);
    this.publish();
    await this.operationsForTask(taskId);
  }

  async interruptAll(): Promise<void> {
    for (const task of this.tasks.values()) {
      if (task.status !== "queued" && task.status !== "running") continue;
      task.status = "interrupted";
      task.activity = "Stopped by user";
      task.endedAt = this.now();
      this.bump(task);
      this.controllers.get(task.id)?.abort();
    }
    this.queue.length = 0;
    this.publish();
    await Promise.allSettled([...this.operations]);
  }

  async reset(): Promise<void> {
    this.disposed = true;
    this.generation += 1;
    await this.interruptAll();
    for (const timer of this.timelineTimers.values()) clearTimeout(timer);
    if (this.completionTimer) clearTimeout(this.completionTimer);
    this.completionTimer = undefined;
    this.tasks.clear();
    this.controllers.clear();
    this.locators.clear();
    this.liveSessions.clear();
    this.timelines.clear();
    this.timelineTimers.clear();
    this.completions.clear();
    this.taskAgents.clear();
    this.generations.clear();
    this.extensionApi = undefined;
    this.disposed = false;
    this.options.onChange([]);
  }

  private register(pi: ExtensionAPI): void {
    this.extensionApi = pi;
    pi.on("session_start", (_event, context) => this.restore(context));
    pi.on("session_tree", (_event, context) => this.restore(context));
    pi.registerTool({
      name: "dispatch_explorers",
      label: "Dispatch explorers",
      description: "并行派发独立的只读仓库调查。工具立即返回；每个任务结束时只通知状态，报告需通过 agent_result 显式获取。",
      promptSnippet: "Dispatch up to eight independent read-only investigations; at most three run concurrently",
      promptGuidelines: [
        "Use dispatch_explorers only when a task has at least two independent, non-overlapping repository questions that each require substantial reading or searching.",
        "Give every Explorer one objective, an exact read-only scope, and a concrete evidence-based deliverable. Explorers cannot edit files or execute shell commands.",
        "Explorer thinking defaults to low. Use medium only for complex cross-module synthesis; high and above are unavailable.",
        "派发后不要轮询。每个任务结束时会收到不含正文的完成通知；收到通知后调用 agent_result 按 task_id 获取已保存报告。",
      ],
      executionMode: "sequential",
      parameters: ExplorerParameters,
      execute: async (toolCallId, params, signal) => {
        signal?.throwIfAborted();
        const snapshots = this.dispatch(toolCallId, params.explorers, params.thinking_level);
        return {
          content: [{ type: "text", text: `已派发 ${snapshots.length} 个子代理任务；每个任务结束时会发送轻量通知，使用 agent_result 获取报告。` }],
          details: { kind: "pi-ecode.explorer-dispatch", version: 2, explorers: snapshots },
        };
      },
    });
    this.registerBusTools(pi);
  }

  private registerBusTools(pi: ExtensionAPI): void {
    pi.registerTool({
      name: "agent_status",
      label: "检查子代理状态",
      description: "检查当前主会话所属子代理任务的状态、活动和未读完成通知，不读取报告正文。",
      parameters: ExplorerStatusParameters,
      execute: async (_toolCallId, params) => {
        const tasks = params.task_id ? [this.requireTask(params.task_id)] : this.current;
        const notices = [...this.completions.values()];
        const status = tasks.map((task) => ({
          taskId: task.id,
          agent: task.taskName,
          title: task.title,
          status: task.status,
          activity: task.activity,
          resultAvailable: Boolean(task.finalText || task.errorMessage),
          resultUnread: notices.some((notice) => notice.taskId === task.id && !notice.acknowledgedAt),
        }));
        return { content: [{ type: "text", text: JSON.stringify(status, null, 2) }], details: { status } };
      },
    });
    pi.registerTool({
      name: "agent_result",
      label: "获取子代理结果",
      description: "按 task_id 读取子代理已经保存的最终报告；不会再次调用子代理模型。",
      parameters: ExplorerTaskIdParameters,
      execute: async (_toolCallId, params) => {
        const task = this.requireTask(params.task_id);
        if (!TERMINAL_STATUSES.has(task.status)) throw new Error("子代理任务尚未结束，请稍后检查状态。");
        const report = task.finalText ?? task.errorMessage ?? "子代理未生成报告。";
        const acknowledgedAt = this.now();
        for (const notice of this.completions.values()) {
          if (notice.taskId === task.id && !notice.acknowledgedAt) notice.acknowledgedAt = acknowledgedAt;
        }
        this.persist();
        return {
          content: [{ type: "text", text: report }],
          details: { taskId: task.id, agent: task.taskName, status: task.status, saved: true },
        };
      },
    });
    pi.registerTool({
      name: "agent_message",
      label: "向子代理发送后续任务",
      description: "向一个空闲的项目代理发送后续任务。代理将复用相同模型 generation 的长期会话；运行中的代理不接受追加消息。",
      parameters: AgentMessageParameters,
      execute: async (toolCallId, params) => {
        const snapshots = this.dispatch(toolCallId, [{
          agent_id: params.agent_id,
          task_name: `follow_up_${toolCallId.replace(/[^a-z0-9]+/giu, "_").toLowerCase().slice(-24)}`,
          title: `后续任务 · ${params.agent_id}`,
          objective: params.message,
          scope: "沿用该代理既有项目范围，并只处理本次消息明确涉及的文件。",
          deliverable: params.deliverable ?? "用中文给出自包含结论，并引用本次重新核实的文件路径。",
        }]);
        return { content: [{ type: "text", text: `已向代理 ${params.agent_id} 发送后续任务，task_id=${snapshots[0]!.id}` }], details: { task: snapshots[0] } };
      },
    });
    pi.registerTool({
      name: "agent_stop",
      label: "停止子代理任务",
      description: "停止当前主会话所属的一个排队中或运行中的子代理任务。",
      parameters: ExplorerTaskIdParameters,
      execute: async (_toolCallId, params) => {
        const task = this.requireTask(params.task_id);
        await this.interrupt(task.id);
        return { content: [{ type: "text", text: `已停止子代理任务：${task.title}` }], details: { taskId: task.id, status: "interrupted" } };
      },
    });
  }

  private selectAgentDefinition(
    requestedId: string | undefined,
    definitions: ProjectAgentDefinition[],
    occupiedAgentIds: Set<string>,
  ): ProjectAgentDefinition {
    const definition = requestedId
      ? definitions.find((candidate) => candidate.id === requestedId)
      : definitions.find((candidate) => candidate.role === "explorer" && !occupiedAgentIds.has(candidate.id));
    if (!definition) {
      throw new Error(requestedId ? `找不到已启用代理：${requestedId}` : "没有空闲探索者；请等待当前任务完成或明确指定其他空闲代理。");
    }
    if (occupiedAgentIds.has(definition.id)) throw new Error(`代理 ${definition.name} 正在执行其他任务。`);
    return definition;
  }

  private dispatch(toolCallId: string, requests: ExplorerRequest[], thinkingOverride?: "low" | "medium"): ExplorerTask[] {
    if (this.disposed) throw new Error("Explorer service is unavailable.");
    const parent = this.options.getParentSession();
    if (!parent?.model) throw new Error("派发子代理前必须先选择模型。");
    const names = new Set<string>();
    const definitions = this.options.getAgentDefinitions?.() ?? [];
    const occupiedAgentIds = new Set(this.current
      .filter((task) => task.status === "queued" || task.status === "running")
      .flatMap((task) => task.agentId ? [task.agentId] : []));
    for (const request of requests) {
      if (names.has(request.task_name)) throw new Error(`子代理任务名重复：${request.task_name}`);
      names.add(request.task_name);
    }
    const created = requests.map((request): ExplorerTask => {
      const definition = definitions.length > 0 ? this.selectAgentDefinition(request.agent_id, definitions, occupiedAgentIds) : undefined;
      const model = definition?.model.mode === "fixed"
        ? { provider: definition.model.provider, id: definition.model.modelId }
        : parent.model!;
      const task: ExplorerTask = {
        id: randomUUID(), taskName: request.task_name, title: request.title.trim(), objective: request.objective.trim(),
        scope: request.scope.trim(), deliverable: request.deliverable.trim(), status: "queued", originToolCallId: toolCallId,
        ...(definition ? { agentId: definition.id, agentRole: definition.role } : {}),
        provider: model.provider, modelId: model.id,
        thinkingLevel: thinkingOverride ?? definition?.thinkingLevel ?? "low",
        attempt: 1, maxAttempts: this.watchdog.maxAttempts, revision: 1, queuedAt: this.now(),
        lastActivityAt: this.now(), activity: "Queued",
      };
      if (definition) {
        occupiedAgentIds.add(definition.id);
        this.taskAgents.set(task.id, {
          taskId: task.id,
          agentId: definition.id,
          role: definition.role,
          prompt: definition.prompt,
          disabledTools: [...definition.disabledTools],
          provider: model.provider,
          modelId: model.id,
          autoCompactionEnabled: definition.autoCompaction.enabled,
          compactionThresholdPercent: definition.autoCompaction.thresholdPercent,
        });
      }
      this.tasks.set(task.id, task);
      this.queue.push(task.id);
      return task;
    });
    this.publish();
    this.drainQueue();
    return cloneTasks(created);
  }

  private drainQueue(): void {
    if (this.disposed) return;
    const maxConcurrent = Math.min(7, Math.max(1, this.options.getMaxConcurrent?.() ?? MAX_CONCURRENT_EXPLORERS));
    while (this.controllers.size < maxConcurrent) {
      const id = this.queue.shift();
      if (!id) return;
      const task = this.tasks.get(id);
      if (!task || task.status !== "queued") continue;
      const controller = new AbortController();
      this.controllers.set(id, controller);
      task.status = "running";
      task.startedAt = this.now();
      task.lastActivityAt = this.now();
      task.activity = "Starting Explorer";
      this.bump(task);
      this.publish();
      const generation = this.generation;
      const operation = this.executeTask(task, controller, generation);
      Object.assign(operation, { explorerTaskId: id });
      this.operations.add(operation);
      void operation.finally(() => this.operations.delete(operation));
    }
  }

  private async executeTask(task: ExplorerTask, controller: AbortController, generation: number): Promise<void> {
    const request: ExplorerRequest = {
      task_name: task.taskName, title: task.title, objective: task.objective, scope: task.scope, deliverable: task.deliverable,
    };
    const parent = this.options.getParentSession();
    try {
      if (!parent) throw new Error("Parent session is no longer available.");
      let result: ExplorerRunResult | undefined;
      while (!result && task.attempt <= task.maxAttempts) {
        try {
          result = await this.runAttempt(task, request, parent, controller.signal);
        } catch (error) {
          if (task.status === "interrupted" || controller.signal.aborted) throw error;
          if (error instanceof ExplorerWatchdogError && error.reason === "inactivity" && task.attempt < task.maxAttempts) {
            this.rotateAgentGeneration(task);
            task.attempt += 1;
            task.activity = `Retrying attempt ${task.attempt}/${task.maxAttempts}`;
            task.lastActivityAt = this.now();
            this.bump(task);
            this.publish();
            continue;
          }
          throw error;
        }
      }
      if (!result) throw new Error("Explorer produced no result.");
      if (generation !== this.generation || task.status === "interrupted") return;
      task.status = "completed";
      task.sessionId = result.sessionId;
      task.finalText = compactFinalText(result.finalText);
      task.activity = "Completed";
      task.endedAt = this.now();
      this.bump(task);
    } catch (error) {
      if (generation !== this.generation || task.status === "interrupted") return;
      task.status = controller.signal.aborted ? "interrupted" : "failed";
      task.errorMessage = error instanceof Error ? error.message : String(error);
      task.activity = task.status === "interrupted" ? "Stopped" : "Failed";
      task.endedAt = this.now();
      this.bump(task);
    } finally {
      this.controllers.delete(task.id);
      if (generation === this.generation) {
        this.publish();
        this.notifyTaskIfReady(task);
        this.drainQueue();
      }
    }
  }

  private async runAttempt(task: ExplorerTask, request: ExplorerRequest, parent: AgentSession, outerSignal: AbortSignal): Promise<ExplorerRunResult> {
    const attemptController = new AbortController();
    const signal = AbortSignal.any([outerSignal, attemptController.signal]);
    let watchdogError: ExplorerWatchdogError | undefined;
    let warned = false;
    const interval = setInterval(() => {
      const now = this.now();
      if (task.startedAt && now - task.startedAt >= this.watchdog.totalMs) {
        watchdogError = new ExplorerWatchdogError("total");
        attemptController.abort();
        return;
      }
      const idleFor = now - (task.lastActivityAt ?? task.startedAt ?? now);
      if (idleFor >= this.watchdog.inactivityMs) {
        watchdogError = new ExplorerWatchdogError("inactivity");
        attemptController.abort();
      } else if (!warned && idleFor >= this.watchdog.warningMs) {
        warned = true;
        task.activity = "Extended period without activity";
        this.bump(task);
        this.publish(false);
      }
    }, this.watchdog.intervalMs);
    try {
      return await this.runExplorer(task, request, parent, signal);
    } catch (error) {
      throw watchdogError ?? error;
    } finally {
      clearInterval(interval);
    }
  }

  private rotateAgentGeneration(task: ExplorerTask): void {
    const agent = this.taskAgents.get(task.id);
    if (agent) this.generations.delete(agent.agentId);
  }

  private childSettings(parent: AgentSession, agent: ExplorerAgentSnapshot | undefined, contextWindow: number): SettingsManager {
    if (!agent) return parent.settingsManager;
    const inherited = {
      ...parent.settingsManager.getGlobalSettings(),
      ...parent.settingsManager.getProjectSettings(),
    };
    const compaction = {
      ...inherited.compaction,
      enabled: agent.autoCompactionEnabled,
      ...(agent.compactionThresholdPercent === null ? {} : {
        reserveTokens: compactionReserveTokens(contextWindow, agent.compactionThresholdPercent),
      }),
    };
    return SettingsManager.inMemory({ ...inherited, compaction });
  }

  private async compactChildIfNeeded(task: ExplorerTask, child: AgentSession, nativeCompaction: NativeCompaction): Promise<void> {
    const agent = this.taskAgents.get(task.id);
    const threshold = agent?.compactionThresholdPercent;
    if (!agent?.autoCompactionEnabled || threshold === null || threshold === undefined || child.isCompacting) return;
    const usage = child.getContextUsage();
    if (usage?.percent === null || usage?.percent === undefined || usage.percent < threshold) return;
    task.compactionMethod = nativeCompaction.supports(child.model) ? "native" : "summary";
    this.touch(task, `正在压缩上下文 · ${task.compactionMethod === "native" ? "远程" : "摘要"}`, true);
    try {
      await child.compact("保留当前代理的已确认事实、用户决策、文件状态、未完成事项和下一步；省略冗长工具输出。");
      delete task.compactionError;
    } catch (error) {
      task.compactionError = error instanceof Error ? error.message : String(error);
    }
  }

  private taskMessages(task: ExplorerTask, messages: AgentMessage[]): AgentMessage[] {
    const locator = this.locators.get(task.id)?.find((candidate) => candidate.attempt === task.attempt);
    return messages.slice(locator?.startMessageIndex ?? 0);
  }

  private async runChildSession(task: ExplorerTask, request: ExplorerRequest, parent: AgentSession, signal: AbortSignal): Promise<ExplorerRunResult> {
    const cwd = parent.sessionManager.getCwd();
    const sessionRoot = this.options.getSessionRoot?.(parent) ?? (parent.sessionFile
      ? join(dirname(parent.sessionFile), ".explorers", parent.sessionId)
      : join(getAgentDir(), "state", "pi-ecode-explorers", parent.sessionId));
    await mkdir(sessionRoot, { recursive: true });
    signal.throwIfAborted();
    const agent = this.taskAgents.get(task.id);
    let model = parent.model;
    if (agent) {
      const available = await parent.modelRuntime.getAvailable().catch(() => parent.modelRuntime.getAvailableSnapshot());
      model = available.find((candidate) => candidate.provider === agent.provider && candidate.id === agent.modelId);
      if (!model) throw new Error(`代理模型不可用或尚未认证：${agent.provider}/${agent.modelId}`);
    }
    if (!model) throw new Error("子代理无法在未选择模型的情况下启动。");
    const settingsManager = this.childSettings(parent, agent, model.contextWindow);
    let childSession: AgentSession | undefined;
    const nativeCompaction = new NativeCompaction(
      () => childSession,
      fetch,
      (message) => { task.compactionError = message; },
    );
    const services = await createAgentSessionServices({
      cwd, agentDir: getAgentDir(), settingsManager, modelRuntime: parent.modelRuntime,
      resourceLoaderOptions: {
        extensionFactories: [nativeCompaction.asExtension()], appendSystemPromptOverride: (base) => [
          ...base,
          EXPLORER_CHILD_GUIDANCE,
          ...(agent ? [agent.prompt] : []),
        ],
        extensionsOverride: (base) => ({ ...base, extensions: [] }),
      },
    });
    const generation = agent ? this.generations.get(agent.agentId) : undefined;
    const reusable = generation?.provider === model.provider && generation.modelId === model.id;
    const sessionManager = reusable
      ? SessionManager.open(generation.sessionFile)
      : SessionManager.create(cwd, sessionRoot, { ...(parent.sessionFile ? { parentSession: parent.sessionFile } : {}) });
    const toolNames = EXPLORER_TOOL_NAMES.filter((name) => !agent?.disabledTools.includes(name));
    const created = await createAgentSessionFromServices({
      services,
      sessionManager,
      model,
      thinkingLevel: task.thinkingLevel,
      tools: [...toolNames],
      customTools: explorerToolDefinitions(parent, toolNames),
      ...(toolNames.length === 0 ? { noTools: "all" as const } : {}),
    });
    const child = created.session;
    childSession = child;
    task.provider = model.provider;
    task.modelId = model.id;
    task.thinkingLevel = child.thinkingLevel;
    this.liveSessions.set(task.id, child);
    task.sessionId = child.sessionId;
    const sessionFile = child.sessionFile;
    const startMessageIndex = child.messages.length;
    if (sessionFile) {
      this.addLocator({ taskId: task.id, attempt: task.attempt, sessionFile, startMessageIndex });
      if (agent && !reusable) {
        this.generations.set(agent.agentId, {
          id: randomUUID(), agentId: agent.agentId, provider: model.provider, modelId: model.id,
          sessionFile, createdAt: this.now(), lastUsedAt: this.now(),
        });
      }
    }
    this.touch(task, `等待模型 · ${task.thinkingLevel}`, true);
    const unsubscribe = child.subscribe((event) => this.onChildEvent(task, child, event));
    const abortChild = (): void => { void child.abort(); };
    signal.addEventListener("abort", abortChild, { once: true });
    try {
      child.agent.toolExecution = "parallel";
      await child.bindExtensions({ mode: "rpc" });
      await child.prompt(taskPrompt(request));
      signal.throwIfAborted();
      const response = child.messages.findLast((message) => message.role === "assistant");
      if (!response || response.role !== "assistant") throw new Error("子代理没有返回最终回复。");
      const text = textFromContent(response.content).trim();
      if (response.stopReason === "error") throw new Error(response.errorMessage || text || "子代理执行失败。");
      if (!text) throw new Error("子代理返回了空报告。");
      await this.compactChildIfNeeded(task, child, nativeCompaction);
      const currentGeneration = agent ? this.generations.get(agent.agentId) : undefined;
      if (currentGeneration) currentGeneration.lastUsedAt = this.now();
      return { sessionId: child.sessionId, finalText: text };
    } finally {
      if (sessionFile) this.addLocator({ taskId: task.id, attempt: task.attempt, sessionFile, startMessageIndex, endMessageIndex: child.messages.length });
      signal.removeEventListener("abort", abortChild);
      unsubscribe();
      if (this.liveSessions.get(task.id) === child) this.liveSessions.delete(task.id);
      child.dispose();
    }
  }

  private onChildEvent(task: ExplorerTask, child: AgentSession, event: AgentSessionEvent): void {
    if (task.status !== "running") return;
    if (event.type === "message_update") {
      this.touch(task, "Generating response");
      const messages = child.messages.includes(event.message) ? child.messages : [...child.messages, event.message];
      this.replaceAttemptTimeline(task, mapTimeline(this.taskMessages(task, messages)));
    } else if (event.type === "message_end" || event.type === "agent_settled") {
      this.touch(task, event.type === "agent_settled" ? "正在收尾" : "等待模型");
      this.replaceAttemptTimeline(task, mapTimeline(this.taskMessages(task, child.messages)));
    } else if (event.type === "tool_execution_start") {
      this.touch(task, toolTitle(event.toolName, event.args));
      this.updateLiveTool(task, event.toolCallId, event.toolName, event.args, "", false);
    } else if (event.type === "tool_execution_update") {
      this.touch(task, toolTitle(event.toolName, event.args));
      this.updateLiveTool(task, event.toolCallId, event.toolName, event.args, textFromToolResult(event.partialResult), false);
    } else if (event.type === "tool_execution_end") {
      this.touch(task, "Waiting for model");
      this.updateLiveTool(task, event.toolCallId, event.toolName, undefined, textFromToolResult(event.result), event.isError);
    }
  }

  private replaceAttemptTimeline(task: ExplorerTask, attemptTimeline: ConversationItem[]): void {
    const previous = this.timelines.get(task.id)?.timeline ?? [];
    const prefix = previous.filter((item) => !item.id.startsWith(`${task.id}:${task.attempt}:`));
    if (task.attempt > 1 && !prefix.some((item) => item.id === `${task.id}:${task.attempt}:retry`)) {
      prefix.push(attemptSeparator(task.id, task.attempt, this.now()));
    }
    this.setTimeline(task, [...prefix, ...namespaceTimeline(task.id, task.attempt, attemptTimeline)]);
  }

  private updateLiveTool(task: ExplorerTask, rawId: string, name: string, args: unknown, output: string, isError: boolean): void {
    const snapshot = this.timelines.get(task.id) ?? { taskId: task.id, revision: 0, timeline: [] };
    const id = `${task.id}:${task.attempt}:${rawId}`;
    const existing = snapshot.timeline.find((item) => item.kind === "tool" && item.id === id);
    const tool = {
      id,
      name,
      title: existing?.kind === "tool" ? existing.tool.title : toolTitle(name, args),
      input: existing?.kind === "tool" ? existing.tool.input : formatToolInput(args),
      ...toolOutputView(output),
      status: isError ? "error" as const : "running" as const,
      startedAt: existing?.kind === "tool" ? existing.tool.startedAt ?? this.now() : this.now(),
      ...(isError ? { endedAt: this.now() } : {}),
    };
    const timeline = existing
      ? snapshot.timeline.map((item) => item.id === id ? toolItem(tool) : item)
      : [...snapshot.timeline, toolItem(tool)];
    this.setTimeline(task, timeline);
  }

  private setTimeline(task: ExplorerTask, timeline: ConversationItem[]): void {
    const revision = (this.timelines.get(task.id)?.revision ?? 0) + 1;
    this.timelines.set(task.id, { taskId: task.id, revision, timeline });
    if (this.timelineTimers.has(task.id)) return;
    const timer = setTimeout(() => {
      this.timelineTimers.delete(task.id);
      const snapshot = this.timelines.get(task.id);
      if (snapshot) this.options.onTimeline?.(structuredClone(snapshot));
      this.options.onChange(this.current);
    }, TIMELINE_THROTTLE_MS);
    this.timelineTimers.set(task.id, timer);
  }

  private touch(task: ExplorerTask, activity: string, persist = false): void {
    task.lastActivityAt = this.now();
    task.activity = activity;
    this.bump(task);
    if (persist) this.publish();
  }

  private notifyTaskIfReady(task: ExplorerTask): void {
    if (this.disposed || (task.status !== "completed" && task.status !== "failed")) return;
    if ([...this.completions.values()].some((notice) => notice.taskId === task.id)) return;
    const notice: ExplorerCompletionNotice = { id: randomUUID(), taskId: task.id, createdAt: this.now() };
    this.completions.set(notice.id, notice);
    this.persist();
    this.scheduleCompletionDelivery();
  }

  private scheduleCompletionDelivery(): void {
    if (this.disposed || this.completionTimer || ![...this.completions.values()].some((notice) => !notice.deliveredAt)) return;
    this.completionTimer = setTimeout(() => {
      this.completionTimer = undefined;
      this.deliverPendingCompletions();
    }, COMPLETION_COALESCE_MS);
  }

  private deliverPendingCompletions(): void {
    const pending = [...this.completions.values()].filter((notice) => !notice.deliveredAt);
    if (!this.extensionApi || pending.length === 0) return;
    const summaries = pending.flatMap((notice) => {
      const task = this.tasks.get(notice.taskId);
      return task ? [{ notice, task }] : [];
    });
    if (summaries.length === 0) return;
    const text = summaries.map(({ notice, task }) =>
      `<agent_completion completion_id="${notice.id}" task_id="${task.id}" agent="${task.taskName}" status="${task.status}" />`,
    ).join("\n");
    try {
      this.extensionApi.sendMessage({
        customType: EXPLORER_COMPLETION_MESSAGE,
        content: [{ type: "text", text: `${text}\n子代理任务已结束。请使用 agent_result 按 task_id 获取已保存结果；通知中不包含报告正文。` }],
        display: false,
        details: { completions: summaries.map(({ notice, task }) => ({ completionId: notice.id, taskId: task.id, status: task.status })) },
      }, { triggerTurn: true, deliverAs: "followUp" });
      const deliveredAt = this.now();
      for (const { notice } of summaries) notice.deliveredAt = deliveredAt;
      this.persist();
    } catch {
      this.scheduleCompletionDelivery();
    }
  }

  private restore(context: ExtensionContext): void {
    this.generation += 1;
    for (const controller of this.controllers.values()) controller.abort();
    for (const timer of this.timelineTimers.values()) clearTimeout(timer);
    if (this.completionTimer) clearTimeout(this.completionTimer);
    this.completionTimer = undefined;
    this.tasks.clear();
    this.queue.length = 0;
    this.controllers.clear();
    this.locators.clear();
    this.liveSessions.clear();
    this.timelines.clear();
    this.timelineTimers.clear();
    this.completions.clear();
    this.taskAgents.clear();
    const state = restoredState(context.sessionManager.getBranch());
    let changed = false;
    if (state) {
      for (const restored of state.tasks) {
        const task = normalizeTask(restored);
        if (task.status === "queued" || task.status === "running") {
          task.status = "interrupted";
          task.endedAt = this.now();
          task.errorMessage = "Explorer was interrupted when the parent session closed.";
          task.activity = "Interrupted when parent session closed";
          this.bump(task);
          changed = true;
        }
        this.tasks.set(task.id, task);
      }
      for (const locator of state.locators) this.addLocator(locator);
      for (const notice of state.completions) this.completions.set(notice.id, { ...notice });
      for (const snapshot of state.agentSnapshots) this.taskAgents.set(snapshot.taskId, { ...snapshot, disabledTools: [...snapshot.disabledTools] });
      for (const generation of state.generations) this.generations.set(generation.agentId, { ...generation });
    }
    this.options.onChange(this.current);
    if (changed) this.persist();
    this.scheduleCompletionDelivery();
  }

  private publish(persist = true): void {
    this.options.onChange(this.current);
    if (persist) this.persist();
  }

  private persist(): void {
    if (!this.extensionApi) return;
    this.extensionApi.appendEntry<ExplorerStateEntry>(EXPLORER_STATE_ENTRY, {
      version: 5,
      tasks: this.current,
      locators: [...this.locators.values()].flat().map((locator) => ({ ...locator })),
      completions: [...this.completions.values()].map((notice) => ({ ...notice })),
      agentSnapshots: [...this.taskAgents.values()].map((snapshot) => ({ ...snapshot, disabledTools: [...snapshot.disabledTools] })),
      generations: [...this.generations.values()].map((generation) => ({ ...generation })),
    });
  }

  private addLocator(locator: ExplorerLocator): void {
    const locators = this.locators.get(locator.taskId) ?? [];
    const existing = locators.findIndex((candidate) => candidate.attempt === locator.attempt);
    if (existing >= 0) locators[existing] = { ...locator };
    else locators.push({ ...locator });
    locators.sort((left, right) => left.attempt - right.attempt);
    this.locators.set(locator.taskId, locators);
  }

  private locatorForAttempt(taskId: string, attempt: number): ExplorerLocator {
    const locator = this.locators.get(taskId)?.find((candidate) => candidate.attempt === attempt);
    if (!locator) throw new Error("Explorer session transcript is not available.");
    return locator;
  }

  private requireTask(taskId: string): ExplorerTask {
    if (!taskId || taskId.length > 200) throw new Error("Invalid Explorer task id.");
    const task = this.tasks.get(taskId);
    if (!task) throw new Error("Explorer task does not belong to the active parent session.");
    return task;
  }

  private bump(task: ExplorerTask): void {
    task.revision += 1;
  }

  private async operationsForTask(taskId: string): Promise<void> {
    const matching = [...this.operations].filter((operation) => (operation as Promise<void> & { explorerTaskId?: string }).explorerTaskId === taskId);
    await Promise.allSettled(matching);
  }
}
