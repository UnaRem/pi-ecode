import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
  createAgentSessionFromServices,
  createAgentSessionServices,
  createEditToolDefinition,
  createWriteToolDefinition,
  getAgentDir,
  type AgentSession,
  type AgentSessionEvent,
  type EditToolInput,
  type ExtensionAPI,
  type ExtensionContext,
  type InlineExtension,
  type SessionEntry,
  SessionManager,
  SettingsManager,
  type ToolDefinition,
  type WriteToolInput,
} from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import type { ConversationItem, ExplorerTask, ExplorerTimelineSnapshot } from "../../shared/contracts.js";
import type { ProjectAgentDefinition } from "../../shared/agent-contracts.js";
import { formatToolInput, textFromContent, textFromToolResult, toolOutputView, toolTitle } from "./message-mapper.js";
import { mapTimeline, toolItem } from "./timeline-mapper.js";
import { NativeCompaction } from "./native-compaction.js";
import { AgentWriteLockService } from "./agent-write-locks.js";
import { configuredCompactionReserveTokens, contextBudgetReached, contextBudgetReserveTokens } from "./context-budget.js";
import {
  AgentMessageParameters,
  attemptSeparator,
  cloneTasks,
  compactFinalText,
  COMPLETION_COALESCE_MS,
  compactionReserveTokens,
  DEFAULT_WATCHDOG,
  EXPLORER_CHILD_GUIDANCE,
  EXPLORER_COMPLETION_MESSAGE,
  ExplorerParameters,
  type ExplorerAgentSnapshot,
  type ExplorerCompletionNotice,
  type ExplorerGeneration,
  type ExplorerLocator,
  type ExplorerRequest,
  type ExplorerRunResult,
  type ExplorerServiceOptions,
  ExplorerStatusParameters,
  EXPLORER_STATE_ENTRY,
  ExplorerTaskIdParameters,
  EXPLORER_TOOL_NAMES,
  ExplorerWatchdogError,
  explorerToolDefinitions,
  MAX_CONCURRENT_EXPLORERS,
  messagesForLocator,
  namespaceTimeline,
  normalizeTask,
  rawToolCallId,
  restoredState,
  type ExplorerStateEntry,
  taskPrompt,
  TERMINAL_STATUSES,
  TIMELINE_THROTTLE_MS,
  validationResultText,
  type WatchdogOptions,
} from "./explorer-support.js";

export { compactionReserveTokens, EXPLORER_TOOL_NAMES, explorerToolDefinitions } from "./explorer-support.js";

export class ExplorerService {
  private readonly tasks = new Map<string, ExplorerTask>();
  private readonly writeLocks = new AgentWriteLockService();
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
    this.writeLocks.release(taskId);
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
    this.writeLocks.clear();
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
    this.writeLocks.clear();
    this.extensionApi = undefined;
    this.disposed = false;
    this.options.onChange([]);
  }

  private register(pi: ExtensionAPI): void {
    this.extensionApi = pi;
    pi.on("session_start", (_event, context) => this.restore(context));
    pi.on("session_tree", (_event, context) => this.restore(context));
    const executeDispatch = async (toolCallId: string, params: Static<typeof ExplorerParameters>, signal?: AbortSignal) => {
      signal?.throwIfAborted();
      const snapshots = this.dispatch(toolCallId, params.explorers, params.thinking_level);
      return {
        content: [{ type: "text" as const, text: `已派发 ${snapshots.length} 个子代理任务；每个任务结束时会发送轻量通知，使用 agent_result 获取报告。` }],
        details: { kind: "pi-ecode.agent-dispatch", version: 1, explorers: snapshots },
      };
    };
    pi.registerTool({
      name: "agent_dispatch",
      label: "派发代理任务",
      description: "向项目代理派发一个或多个任务。代理可长期复用会话；编辑者必须声明 write_scope。",
      promptSnippet: "按稳定 agent_id 指挥项目代理；完成通知不携带报告正文",
      promptGuidelines: [
        "根据项目代理目录选择 agent_id；一个代理同一时刻只能执行一个任务。",
        "探索者和审查者只读；验证者只能运行固定验证；编辑者写入前必须声明精确 write_scope。",
        "派发后不要轮询。收到完成通知后调用 agent_result；需要后续任务时调用 agent_message。",
      ],
      executionMode: "sequential",
      parameters: ExplorerParameters,
      execute: executeDispatch,
    });
    pi.registerTool({
      name: "dispatch_explorers",
      label: "派发只读探索者",
      description: "兼容入口：并行派发独立的只读仓库调查；省略 agent_id 时自动选择空闲探索者。",
      executionMode: "sequential",
      parameters: ExplorerParameters,
      execute: executeDispatch,
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
          ...(params.write_scope.length > 0 ? { write_scope: params.write_scope } : {}),
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
    const created: ExplorerTask[] = [];
    try {
      for (const request of requests) {
        const definition = definitions.length > 0 ? this.selectAgentDefinition(request.agent_id, definitions, occupiedAgentIds) : undefined;
        const model = definition?.model.mode === "fixed"
          ? { provider: definition.model.provider, id: definition.model.modelId }
          : parent.model!;
        const task: ExplorerTask = {
          id: randomUUID(), taskName: request.task_name, title: request.title.trim(), objective: request.objective.trim(),
          scope: request.scope.trim(), deliverable: request.deliverable.trim(), status: "queued", originToolCallId: toolCallId,
          ...(definition ? { agentId: definition.id, agentRole: definition.role } : {}),
          ...(request.write_scope?.length ? { writeScope: [...request.write_scope] } : {}),
          provider: model.provider, modelId: model.id,
          thinkingLevel: thinkingOverride ?? definition?.thinkingLevel ?? "low",
          attempt: 1, maxAttempts: this.watchdog.maxAttempts, revision: 1, queuedAt: this.now(),
          lastActivityAt: this.now(), activity: "Queued",
        };
        if (definition?.role === "editor") {
          if (!request.write_scope?.length) throw new Error("编辑者任务必须声明 write_scope。");
          this.writeLocks.acquire(parent.sessionManager.getCwd(), task.id, definition.id, request.write_scope);
        } else if (request.write_scope?.length) {
          throw new Error(`只有编辑者任务可以声明非空 write_scope：${definition?.name ?? request.task_name}`);
        }
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
        created.push(task);
      }
    } catch (error) {
      for (const task of created) {
        this.writeLocks.release(task.id);
        this.taskAgents.delete(task.id);
        this.tasks.delete(task.id);
        const queuedIndex = this.queue.indexOf(task.id);
        if (queuedIndex >= 0) this.queue.splice(queuedIndex, 1);
      }
      throw error;
    }
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
      ...(task.writeScope ? { write_scope: [...task.writeScope] } : {}),
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
      this.writeLocks.release(task.id);
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

  private roleToolDefinitions(
    task: ExplorerTask,
    parent: AgentSession,
    cwd: string,
    agent: ExplorerAgentSnapshot | undefined,
  ): ToolDefinition[] {
    const readOnlyNames = EXPLORER_TOOL_NAMES.filter((name) => !agent?.disabledTools.includes(name));
    const definitions = explorerToolDefinitions(parent, readOnlyNames);
    if (agent?.role === "editor") {
      const edit = createEditToolDefinition(cwd);
      const write = createWriteToolDefinition(cwd);
      const lockedEdit = {
        ...edit,
        label: "受锁编辑",
        description: "在当前编辑任务已声明并锁定的 write_scope 内执行精确文本替换。",
        execute: async (toolCallId: string, params: EditToolInput, signal: AbortSignal | undefined, onUpdate: Parameters<typeof edit.execute>[3], context: Parameters<typeof edit.execute>[4]) => {
          this.writeLocks.assertPath(cwd, task.id, params.path);
          return edit.execute(toolCallId, params, signal, onUpdate, context);
        },
      };
      const lockedWrite = {
        ...write,
        label: "受锁写入",
        description: "只在当前编辑任务已声明并锁定的 write_scope 内新建或完整覆盖文件。",
        execute: async (toolCallId: string, params: WriteToolInput, signal: AbortSignal | undefined, onUpdate: Parameters<typeof write.execute>[3], context: Parameters<typeof write.execute>[4]) => {
          this.writeLocks.assertPath(cwd, task.id, params.path);
          return write.execute(toolCallId, params, signal, onUpdate, context);
        },
      };
      definitions.push(lockedEdit as unknown as ToolDefinition, lockedWrite as unknown as ToolDefinition);
    }
    if ((agent?.role === "editor" || agent?.role === "validator") && this.options.runValidation) {
      definitions.push({
        name: "run_validation",
        label: "运行固定验证",
        description: "运行宿主固定的 typecheck、test、build 检查；不能指定或执行任意命令。",
        parameters: Type.Object({}),
        execute: async (_toolCallId, _params, signal) => {
          signal?.throwIfAborted();
          const state = await this.options.runValidation!();
          return { content: [{ type: "text", text: validationResultText(state) }], details: state };
        },
      });
    }
    return definitions.filter((definition) => !agent?.disabledTools.includes(definition.name));
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
    const configuredReserve = configuredCompactionReserveTokens(
      parent.settingsManager.getGlobalSettings(),
      parent.settingsManager.getProjectSettings(),
    );
    const percentageReserve = agent.compactionThresholdPercent === null
      ? configuredReserve
      : compactionReserveTokens(contextWindow, agent.compactionThresholdPercent);
    const compaction = {
      ...inherited.compaction,
      enabled: agent.autoCompactionEnabled,
      reserveTokens: contextBudgetReserveTokens(contextWindow, Math.max(configuredReserve, percentageReserve)),
    };
    return SettingsManager.inMemory({ ...inherited, compaction });
  }

  private async compactChildIfNeeded(task: ExplorerTask, child: AgentSession, nativeCompaction: NativeCompaction): Promise<void> {
    const agent = this.taskAgents.get(task.id);
    const threshold = agent?.compactionThresholdPercent;
    if (!agent?.autoCompactionEnabled || child.isCompacting) return;
    const usage = child.getContextUsage();
    const percentageReached = threshold !== null && threshold !== undefined
      && usage?.percent !== null && usage?.percent !== undefined && usage.percent >= threshold;
    if (!contextBudgetReached(usage?.tokens) && !percentageReached) return;
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
    const toolDefinitions = this.roleToolDefinitions(task, parent, cwd, agent);
    const toolNames = toolDefinitions.map((definition) => definition.name);
    const created = await createAgentSessionFromServices({
      services,
      sessionManager,
      model,
      thinkingLevel: task.thinkingLevel,
      tools: toolNames,
      customTools: toolDefinitions,
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
    if (!taskId || taskId.length > 200) throw new Error("子代理任务 ID 无效。");
    const task = this.tasks.get(taskId);
    if (!task) throw new Error("子代理任务不属于当前主会话。");
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
