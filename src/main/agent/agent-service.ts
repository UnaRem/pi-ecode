import { hostname } from "node:os";
import { createHash } from "node:crypto";
import { basename, join, resolve } from "node:path";
import { stat } from "node:fs/promises";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import {
  type AgentSession,
  type AgentSessionEvent,
  type AgentSessionRuntime,
  type CreateAgentSessionRuntimeFactory,
  type SettingsManager,
  createAgentSessionFromServices,
  createAgentSessionRuntime,
  createAgentSessionServices,
  createEventBus,
  getAgentDir,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import type { AuthFlowEvent, AuthPromptResponse, AuthType, ProviderStatus } from "../../shared/settings-contracts.js";
import type {
  AgentEvent,
  AgentSnapshot,
  AgentTimelinePage,
  ConversationImagePayload,
  ConversationMessage,
  ConversationItem,
  ImageAttachment,
  ModelOption,
  ThinkingLevel,
  ValidationState,
  CandidateState,
  ChangeReview,
  CompactionMethod,
  CompactionStatus,
  ToolActivity,
  ExtensionUiResponse,
} from "../../shared/contracts.js";
import { WorkspaceHistory } from "../history/workspace-history.js";
import { ValidationService } from "../validation/validation-service.js";
import { CandidateService } from "../update/candidate-service.js";
import { ConfirmationService } from "./confirmation.js";
import { formatToolInput, textFromContent, textFromToolResult, toolOutputView, toolTitle } from "./message-mapper.js";
import { conversationImagePayload, historyMessages, mapTimeline, messageItem, recentMessageWindow, toolItem } from "./timeline-mapper.js";
import { NativeCompaction } from "./native-compaction.js";
import { NativeMcp } from "./native-mcp.js";
import { StreamContinuity } from "./stream-continuity.js";
import { TaskPlanService } from "./task-plan.js";
import { ExtensionUiBridge } from "./extension-ui-bridge.js";
import { AuthService } from "./auth-service.js";
import {
  EDIT_TOOL_COMPATIBILITY_GUIDANCE,
  PARALLEL_TOOL_EXECUTION_GUIDANCE,
  VALIDATION_ORCHESTRATION_GUIDANCE,
} from "./agent-guidance.js";
import { PromptLifecycle } from "./prompt-lifecycle.js";
import { listSessionSummaries } from "./session-summaries.js";
import { EMPTY_AGENT_SNAPSHOT } from "./empty-agent-snapshot.js";
import { providerFailure, PROVIDER_RECOVERY_PROMPT } from "./provider-recovery.js";
import { CodegraphToolService } from "./codegraph-tool.js";
import { ValidationToolService } from "./validation-tool.js";
import { ManagedProcessService } from "../processes/managed-process-service.js";
import { ManagedProcessToolService } from "./managed-process-tool.js";
import { toolStatisticsStore, type ToolStatisticsStore } from "./tool-statistics.js";
import { declaredToolStatistics, toolAdvisorExtension } from "./tool-advisor.js";
import type { McpToolSummary } from "../../shared/mcp-contracts.js";
import type { ToolStatistic } from "../../shared/tool-statistics.js";
import { SessionTitleService } from "./session-title.js";
import { readProjectProfile } from "./project-profile.js";
import { configuredCompactionReserveTokens, contextBudgetReserveTokens } from "./context-budget.js";

const HISTORY_PAGE_TURNS = 25;

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class AgentService {
  private managedProcesses = this.createManagedProcesses();
  private readonly managedProcessTool = new ManagedProcessToolService({
    isCurrent: (cwd, sessionId) => this.projectPath === cwd && this.runtime?.session.sessionId === sessionId
      && this.runtime.session.sessionManager.getCwd() === cwd,
    start: (request) => this.managedProcesses.start(request),
    stop: (id) => this.managedProcesses.stop(id),
  });
  private runtime: AgentSessionRuntime | undefined;
  private readonly sessionMcp = new WeakMap<AgentSession, NativeMcp>();
  private readonly sessionTitles = new SessionTitleService((message) => this.emit({ type: "notice", message }));
  private statistics: ToolStatisticsStore | undefined;
  private statisticsError: string | null = null;
  private unsubscribeStatistics: (() => void) | undefined;

  private createManagedProcesses(): ManagedProcessService {
    return new ManagedProcessService((processes) => this.emit({ type: "processes", processes }));
  }

  async stopManagedProcess(id: string): Promise<void> {
    if (!this.projectPath || !this.managedProcesses.current.some((entry) => entry.id === id && entry.projectPath === this.projectPath)) {
      throw new Error("Unknown managed process in the active project.");
    }
    await this.managedProcesses.stop(id);
  }
  private projectPath: string | undefined;
  private projectProfile: import("../../shared/contracts.js").ProjectProfile | undefined;
  private sessionSummaries: { projectPath: string; sessions: import("../../shared/contracts.js").SessionSummary[] } | undefined;
  private sessionSummaryRevision = 0;
  private startupError: string | undefined;
  private unsubscribe: (() => void) | undefined;
  private readonly listeners = new Set<(event: AgentEvent) => void>();
  private readonly authListeners = new Set<(event: AuthFlowEvent) => void>();
  private readonly auth: AuthService;
  private readonly liveTools = new Map<string, ToolActivity>();
  private liveAssistantId: string | undefined;
  private liveAssistantText = "";
  private assistantStreaming = false;
  private liveAssistantSequence = 0;
  private readonly pendingStreamItems = new Map<string, ConversationItem>();
  private pendingStreamContext: AgentSession | undefined;
  private streamTimer: ReturnType<typeof setTimeout> | undefined;
  private visibleTimelineTurns = HISTORY_PAGE_TURNS;
  private readonly promptLifecycle = new PromptLifecycle((session) => {
    const isStreaming = this.isAgentActive(session);
    this.emit({ type: "state", patch: { isStreaming, workingStartedAt: this.workingStartedAt,
      pendingCount: session.pendingMessageCount, ...(isStreaming ? { error: null, canContinue: false } : {}) } });
  });
  private compactOperation: Promise<void> | undefined;
  private validationOperation: Promise<ValidationState> | undefined;
  private contextEstimate: number | null = null;
  private compactionStatus: CompactionStatus = { status: "idle" };
  private readonly nativeCompaction = new NativeCompaction(
    () => this.runtime?.session,
    fetch,
    (message) => this.emit({ type: "error", message }),
  );
  private readonly streamContinuity = new StreamContinuity();
  private readonly confirmation = new ConfirmationService();
  private readonly taskPlan = new TaskPlanService((taskPlan) => this.emit({ type: "task-plan", taskPlan }));
  private readonly extensionUi = new ExtensionUiBridge(
    (request) => this.emit({ type: "extension-ui", request }),
    (message) => this.emit({ type: "notice", message }),
  );
  private readonly extensionEventBus = createEventBus();
  private readonly removeQuestionnaireListener = this.extensionEventBus.on(
    "rpiv:ask-user:prompt",
    (payload) => this.extensionUi.setQuestionnaireMetadata(payload),
  );
  private readonly history = new WorkspaceHistory(join(getAgentDir(), "state", "pi-ecode-workspace-history"));
  private readonly validationTool = new ValidationToolService({
    getState: () => this.validation.getState(),
    start: (originToolCallId) => this.startValidationFromTool(originToolCallId),
  });
  private readonly codegraphTool = new CodegraphToolService({
    getProjectPath: () => this.projectPath,
  });
  /**
   * 验证通过触发的宿主侧索引同步：同一时刻最多一个在途进程，外加一个待启动意图。
   * 意图会在新的验证阶段、结果失效、项目切换或窗口关闭时被丢弃，drain 启动前还会再核对一次，
   * 因此缓存的同步请求既不会在旧进程清理期间被丢弃，也不会在换项目之后滞后启动。
   */
  private codegraphSync: { projectPath: string; controller: AbortController; operation: Promise<void> } | undefined;
  private codegraphSyncIntent: { runId: string; projectPath: string } | undefined;
  private codegraphSyncDraining = false;
  private readonly codegraphSyncedRunIds = new Set<string>();
  private readonly validation = new ValidationService((validation) => {
    if (validation.status === "stale") this.candidate.invalidate();
    this.validationTool.onValidationChanged(validation);
    this.emit({ type: "validation", validation: { ...validation, isSelfProject: this.options.allowSelfUpdate !== false && validation.isSelfProject } });
    this.scheduleCodegraphSync(validation);
    const session = this.runtime?.session;
    if (session) this.emit({ type: "state", patch: {
      isStreaming: this.isAgentActive(session),
      workingStartedAt: this.workingStartedAt,
    } });
  });
  private readonly candidate = new CandidateService(
    join(getAgentDir(), "state", "pi-ecode-self-update"),
    (candidate) => this.emit({ type: "candidate", candidate }),
  );
  private readonly trashItem: (path: string) => Promise<void>;

  constructor(
    openExternal: (url: string) => Promise<void> = async () => undefined,
    trashItem: (path: string) => Promise<void> = async () => { throw new Error("System trash is unavailable."); },
    private readonly options: { allowSelfUpdate?: boolean } = {},
  ) {
    this.trashItem = trashItem;
    this.auth = new AuthService(
      () => this.runtime?.session.modelRuntime,
      (event) => {
        for (const listener of this.authListeners) listener(event);
      },
      openExternal,
      () => this.requireRuntime().services.settingsManager.getOrCreateDeviceId(),
    );
  }

  async initialize(): Promise<void> {
    await this.candidate.initialize();
    const sourceRoot = await this.candidate.discoverSourceRoot();
    if (!sourceRoot) return;
    try {
      await this.openProject(sourceRoot);
    } catch (error) {
      this.startupError = `Could not open the pi-ecode source project: ${errorText(error)}`;
    }
  }

  subscribe(listener: (event: AgentEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  subscribeAuth(listener: (event: AuthFlowEvent) => void): () => void {
    this.authListeners.add(listener);
    return () => this.authListeners.delete(listener);
  }

  reportError(message: string): void {
    this.emit({ type: "state", patch: { error: message } });
  }

  private emit(event: AgentEvent): void {
    for (const listener of this.listeners) listener(event);
  }

  private publishStreamItem(item: ConversationItem): void {
    // Keep only the latest progress per item until the next paint opportunity.
    this.pendingStreamItems.set(item.id, item);
    if (this.streamTimer === undefined) this.streamTimer = setTimeout(() => this.flushStreamItems(), 33);
  }

  private flushStreamItems(): void {
    if (this.streamTimer !== undefined) clearTimeout(this.streamTimer);
    this.streamTimer = undefined;
    for (const item of this.pendingStreamItems.values()) this.emit({ type: "timeline-upsert", item });
    this.pendingStreamItems.clear();
    if (this.pendingStreamContext) this.emitContext(this.pendingStreamContext);
    this.pendingStreamContext = undefined;
  }

  async openProject(inputPath: string, sessionPath?: string, startNewSession = true): Promise<AgentSnapshot> {
    const cwd = resolve(inputPath);
    const details = await stat(cwd);
    if (!details.isDirectory()) throw new Error("Selected project is not a directory.");

    await this.disposeRuntime();
    // 停止旧进程失败时保留旧项目归属，用户仍能通过登记 ID 重试停止。
    try {
      await this.managedProcesses.configure(cwd);
    } catch (error) {
      this.startupError = `项目切换失败，可重试停止旧项目进程：${errorText(error)}`;
      throw error;
    }
    this.projectPath = cwd;
    this.sessionSummaries = undefined;
    this.sessionSummaryRevision += 1;
    this.startupError = undefined;

    try {
      this.projectProfile = await readProjectProfile(cwd);
      this.runtime = await createAgentSessionRuntime(this.createRuntimeFactory(), {
        cwd,
        agentDir: getAgentDir(),
        // A shared cwd must still get a distinct conversation file; continuing recent could reopen a running session.
        sessionManager: sessionPath ? SessionManager.open(sessionPath, undefined, cwd)
          : startNewSession ? SessionManager.create(cwd) : SessionManager.continueRecent(cwd),
      });
      this.runtime.setRebindSession(async (session) => this.bindSession(session));
      await this.bindSession(this.runtime.session);
      await this.validation.configure(cwd);
      if (this.options.allowSelfUpdate !== false) this.candidate.configure(cwd);
      const snapshot = await this.getSnapshot();
      this.emit({ type: "snapshot", snapshot });
      return snapshot;
    } catch (error) {
      await this.disposeRuntime();
      await this.managedProcesses.dispose();
      this.managedProcesses = this.createManagedProcesses();
      this.projectPath = undefined;
      throw error;
    }
  }

  loadOlderTimeline(): AgentTimelinePage {
    const session = this.requireRuntime().session;
    this.visibleTimelineTurns += HISTORY_PAGE_TURNS;
    return this.timelinePage(session);
  }

  getToolOutput(toolCallId: string): string {
    if (!toolCallId || toolCallId.length > 200) throw new Error("Invalid tool call id.");
    const message = historyMessages(this.requireRuntime().session.sessionManager.getBranch()).findLast((entry) => (
      entry.role === "toolResult" && entry.toolCallId === toolCallId
    ));
    if (!message || message.role !== "toolResult") throw new Error("Tool output is not available in the active session.");
    return textFromContent(message.content);
  }

  getConversationImage(sourceId: string): ConversationImagePayload | null {
    if (!/^\d+:\d+$/u.test(sourceId)) throw new Error("Invalid conversation image id.");
    return this.runtime ? conversationImagePayload(historyMessages(this.runtime.session.sessionManager.getBranch()), sourceId) : null;
  }

  private timelinePage(session: AgentSession): AgentTimelinePage {
    const window = recentMessageWindow(historyMessages(session.sessionManager.getBranch()), this.visibleTimelineTurns);
    return { timeline: this.withLiveTimeline(mapTimeline(window.messages, window.startIndex)), hasMore: window.hasMore };
  }

  private withLiveTimeline(timeline: ConversationItem[]): ConversationItem[] {
    const visible = [...timeline];
    for (const tool of this.liveTools.values()) {
      if (tool.status === "running" && !visible.some((item) => item.id === tool.id)) visible.push(toolItem(tool));
    }
    if (this.assistantStreaming && this.liveAssistantId && this.liveAssistantText) {
      visible.push(messageItem({ id: this.liveAssistantId, role: "assistant", text: this.liveAssistantText, timestamp: Date.now() }));
    }
    return visible;
  }

  get agentDirectory(): string {
    return getAgentDir();
  }

  get activeProjectPath(): string | undefined {
    return this.projectPath;
  }

  get activeModelRuntime() {
    return this.runtime?.session.modelRuntime;
  }

  get recommendationContext() {
    const session = this.runtime?.session;
    return session?.model ? { model: session.model, runtime: session.modelRuntime } : undefined;
  }

  get projectSettingsTrusted(): boolean {
    return this.runtime?.services.settingsManager.isProjectTrusted() ?? false;
  }

  get fffExtensionLoaded(): boolean {
    return this.runtime?.session.resourceLoader.getExtensions().extensions.some((extension) => (
      extension.path.replaceAll("\\", "/").includes("pi-fff")
    )) ?? false;
  }

  getProviderStatuses(): Promise<ProviderStatus[]> {
    return this.auth.getProviderStatuses();
  }

  loginProvider(providerId: string, type: AuthType): Promise<void> {
    return this.auth.login(providerId, type);
  }

  logoutProvider(providerId: string): Promise<void> {
    return this.auth.logout(providerId);
  }

  respondAuthPrompt(response: AuthPromptResponse): boolean {
    return this.auth.respond(response);
  }

  cancelAuth(): void {
    this.auth.cancel();
  }

  get hasBackgroundResources(): boolean {
    return this.sessionTitles.hasPending || this.managedProcesses.current.some((entry) => ["starting", "running", "stopping"].includes(entry.status));
  }

  get runtimeBusy(): boolean {
    const session = this.runtime?.session;
    return Boolean(session && (this.isAgentActive(session) || session.isCompacting));
  }

  private isAgentActive(session: AgentSession): boolean {
    return this.promptLifecycle.isActive(session) || this.validation.getState().status === "running";
  }

  private get workingStartedAt(): number | null {
    return this.promptLifecycle.workingStartedAt
      ?? this.validation.getState().startedAt;
  }

  async reloadRuntimeConfiguration(): Promise<void> {
    const previousRuntime = this.requireRuntime();
    this.flushStreamItems();
    const cwd = this.projectPath;
    if (!cwd) return;
    const sessionFile = previousRuntime.session.sessionFile;
    const sessionManager = sessionFile ? SessionManager.open(sessionFile) : SessionManager.create(cwd);
    const candidateRuntime = await createAgentSessionRuntime(this.createRuntimeFactory(), {
      cwd,
      agentDir: getAgentDir(),
      sessionManager,
    });
    try {
      this.runtime = candidateRuntime;
      candidateRuntime.setRebindSession(async (session) => this.bindSession(session));
      await this.bindSession(candidateRuntime.session);
    } catch (error) {
      this.runtime = previousRuntime;
      await candidateRuntime.dispose();
      await this.bindSession(previousRuntime.session);
      throw error;
    }
    await previousRuntime.dispose();
    this.emit({ type: "snapshot", snapshot: await this.getSnapshot() });
  }

  async getSnapshot(): Promise<AgentSnapshot> {
    return this.snapshotWithSessions();
  }

  private async snapshotWithSessions(knownSessions?: import("../../shared/contracts.js").SessionSummary[]): Promise<AgentSnapshot> {
    if (!this.runtime || !this.projectPath) {
      return {
        ...EMPTY_AGENT_SNAPSHOT,
        projectPath: this.projectPath ?? null,
        projectName: this.projectPath ? basename(this.projectPath) : null,
        processes: this.managedProcesses.current,
        error: this.startupError ?? null,
      };
    }
    const session = this.runtime.session;
    const [sessions, availableModels, { history, review }] = await Promise.all([
      knownSessions ?? (this.sessionSummaries?.projectPath === this.projectPath ? this.sessionSummaries.sessions : this.loadSessionSummaries()),
      session.modelRuntime.getAvailable().catch(() => session.modelRuntime.getAvailableSnapshot()),
      this.history.getSnapshot(session),
    ]);
    const timelinePage = this.timelinePage(session);
    const model = session.model;
    const usage = session.getContextUsage();
    const contextFiles = session.resourceLoader.getAgentsFiles().agentsFiles.map((file) => file.path);
    const failure = providerFailure(session.messages);

    return {
      projectPath: this.projectPath,
      ...(this.projectProfile ? { projectProfile: this.projectProfile } : {}),
      projectName: basename(this.projectPath),
      sessionId: session.sessionId,
      sessionFile: session.sessionFile ?? null,
      sessionTitle: session.sessionName ?? null,
      sessions,
      timeline: timelinePage.timeline,
      timelineHasMore: timelinePage.hasMore,
      models: availableModels.map<ModelOption>((item) => ({
        id: item.id,
        provider: item.provider,
        name: item.name,
        reasoning: item.reasoning,
        thinkingLevels: getSupportedThinkingLevels(item),
        supportsImages: item.input.includes("image"),
      })),
      selectedModel: model ? `${model.provider}/${model.id}` : null,
      thinkingLevel: session.thinkingLevel,
      thinkingLevels: session.getAvailableThinkingLevels(),
      isStreaming: this.isAgentActive(session),
      workingStartedAt: this.workingStartedAt,
      pendingCount: session.pendingMessageCount,
      error: failure?.message ?? this.runtime.modelFallbackMessage ?? this.runtime.diagnostics.at(0)?.message ?? this.statisticsError,
      canContinue: failure?.canContinue ?? false,
      taskPlan: this.taskPlan.current,
      processes: this.managedProcesses.current,
      mcpTools: this.sessionMcp.get(session)?.current ?? [],
      toolStatistics: this.currentToolStatistics(session),
      extensionUi: this.extensionUi.current,
      history,
      validation: { ...this.validation.getState(), isSelfProject: this.options.allowSelfUpdate !== false && this.validation.getState().isSelfProject },
      review,
      candidate: this.candidate.getState(),
      context: this.contextState(session, usage),
      policy: { contextFiles, workflow: "manual-review", gitCommits: "required-after-verification" },
    };
  }

  async newSession(): Promise<AgentSnapshot> {
    const runtime = this.requireRuntime();
    if (this.runtimeBusy) throw new Error("Stop the active agent run before creating a session.");
    await runtime.newSession();
    const snapshot = await this.getSnapshot();
    this.emit({ type: "snapshot", snapshot });
    return snapshot;
  }

  async switchSession(sessionPath: string): Promise<AgentSnapshot> {
    const runtime = this.requireRuntime();
    if (this.runtimeBusy) throw new Error("Stop the active agent run before switching sessions.");
    this.flushStreamItems();
    const projectPath = this.projectPath;
    const isCurrent = this.sessionGuard(runtime.session);
    const knownSessions = this.sessionSummaries;
    const sessions = knownSessions && knownSessions.projectPath === projectPath
      ? knownSessions.sessions : await this.loadSessionSummaries();
    if (!sessions.some((session) => session.path === sessionPath)) {
      throw new Error("That session does not belong to the active project.");
    }
    const details = await stat(sessionPath);
    if (!details.isFile()) throw new Error("Selected session is not a file.");
    if (!isCurrent()) throw new Error("The active session changed before switching.");
    const switchResult = await runtime.switchSession(sessionPath);
    if (this.runtime !== runtime || this.projectPath !== projectPath) throw new Error("The active project changed while switching.");
    // SDK 取消切换时仍停留原会话，不得把目标标题写入已发布列表。
    const switched = !switchResult.cancelled && runtime.session.sessionFile === sessionPath;
    const updatedSessions = switched ? sessions.map((summary) => summary.path === sessionPath
      ? { ...summary, title: runtime.session.sessionName ?? summary.title }
      : summary) : sessions;
    if (switched && projectPath) {
      this.sessionSummaryRevision += 1;
      this.sessionSummaries = { projectPath, sessions: updatedSessions };
    }
    const stillCurrent = this.sessionGuard(runtime.session);
    const snapshot = await this.snapshotWithSessions(updatedSessions);
    if (stillCurrent()) this.emit({ type: "snapshot", snapshot });
    return snapshot;
  }

  async deleteSession(sessionPath: string): Promise<void> {
    const runtime = this.requireRuntime();
    if (this.runtimeBusy) throw new Error("Stop the active agent run before deleting a session.");
    const sessions = await this.loadSessionSummaries();
    const target = sessions.find((session) => session.path === sessionPath);
    if (!target) throw new Error("That session does not belong to the active project.");
    if (target.path === runtime.session.sessionFile) throw new Error("The active session cannot be deleted.");
    await this.trashItem(target.path);
    await this.refreshSessions();
  }

  renameSession(title: string): void {
    const normalizedTitle = title.replace(/\s+/gu, " ").trim().slice(0, 80);
    const session = this.requireRuntime().session;
    this.sessionTitles.cancel(session.sessionId);
    session.setSessionName(normalizedTitle);
  }

  async continueAfterError(): Promise<void> {
    const session = this.requireRuntime().session;
    const failure = providerFailure(session.messages);
    if (!session.isIdle || !failure?.canContinue) throw new Error("The interrupted response is not ready to continue.");
    try {
      await this.promptLifecycle.continueAfterError(session, PROVIDER_RECOVERY_PROMPT);
    } catch (error) {
      this.emit({ type: "error", message: errorText(error) });
      throw error;
    }
  }

  async prompt(message: string, images: ImageAttachment[] = []): Promise<void> {
    const session = this.requireRuntime().session;
    const text = message.trim();
    if (!text && images.length === 0) return;
    const promptText = text || "Describe the attached image.";
    const sdkImages = images.map((image) => ({ type: "image" as const, data: image.data, mimeType: image.mimeType }));
    try {
      this.confirmation.assertResponse(session, promptText, this.isAgentActive(session));
      await this.promptLifecycle.prompt(session, promptText, sdkImages);
    } catch (error) {
      this.emit({ type: "error", message: errorText(error) });
      throw error;
    }
  }

  compact(): Promise<void> {
    if (this.compactOperation) return this.compactOperation;
    const session = this.requireRuntime().session;
    if (session.isStreaming) return Promise.reject(new Error("Stop the active agent run before compacting context."));
    if (!this.canCompact(session)) return Promise.resolve();
    const usage = session.getContextUsage();
    this.compactionStatus = {
      status: "running",
      reason: "manual",
      method: this.compactionMethod(session),
      tokensBefore: usage?.tokens ?? this.contextEstimate,
    };
    this.emitContext(session);
    const operation = session.compact()
      .then(() => undefined)
      .catch((error: unknown) => {
        const message = errorText(error);
        if (message === "Compaction cancelled") return;
        throw error;
      })
      .finally(() => {
        if (this.compactOperation === operation) this.compactOperation = undefined;
        this.emitContext(session);
      });
    this.compactOperation = operation;
    return operation;
  }

  cancelCompaction(): void {
    const session = this.requireRuntime().session;
    if (!this.compactOperation && !session.isCompacting) return;
    session.abortCompaction();
  }

  async stop(): Promise<void> {
    const session = this.requireRuntime().session;
    const validationStop = this.validation.stop();
    this.flushStreamItems();
    this.extensionUi.cancelPending();
    if (session.isCompacting) session.abortCompaction();
    const promptStop = this.promptLifecycle.stop(session);
    await Promise.all([validationStop, promptStop]);
    await this.history.settlePending(session);
    await this.emitHistory(session);
  }

  async setModel(provider: string, modelId: string): Promise<void> {
    const session = this.requireRuntime().session;
    const model = session.modelRuntime.getModel(provider, modelId);
    if (!model) throw new Error(`Model not found: ${provider}/${modelId}`);
    await session.setModel(model, { persist: true });
    this.applyContextBudget(session);
    this.emitModelState(session);
  }

  setThinkingLevel(level: ThinkingLevel): void {
    const session = this.requireRuntime().session;
    session.setThinkingLevel(level);
    this.emitModelState(session);
  }

  async undo(): Promise<import("../../shared/contracts.js").HistoryOperationResult> {
    const session = this.requireRuntime().session;
    this.validation.invalidate("Workspace was restored after the last verification.");
    this.candidate.invalidate();
    const result = await this.history.undo(session);
    this.emit({ type: "snapshot", snapshot: await this.getSnapshot() });
    await this.emitHistory(session, result);
    return result;
  }

  async redo(): Promise<import("../../shared/contracts.js").HistoryOperationResult> {
    const session = this.requireRuntime().session;
    this.validation.invalidate("Workspace was restored after the last verification.");
    this.candidate.invalidate();
    const result = await this.history.redo(session);
    this.emit({ type: "snapshot", snapshot: await this.getSnapshot() });
    await this.emitHistory(session, result);
    return result;
  }

  async runValidation(): Promise<ValidationState> {
    if (this.validationOperation) throw new Error("Validation is already running.");
    const session = this.requireRuntime().session;
    const operation = (async () => {
      await this.history.checkpoint(session, "validation input");
      return this.executeValidation(session);
    })();
    return this.trackValidation(operation);
  }

  private startValidationFromTool(originToolCallId: string): void {
    if (this.validationOperation) throw new Error("Validation is already running.");
    const session = this.requireRuntime().session;
    const operation = this.executeValidation(session, originToolCallId);
    void this.trackValidation(operation).catch((error: unknown) => this.emit({ type: "error", message: errorText(error) }));
  }

  private async executeValidation(session: AgentSession, originToolCallId?: string): Promise<ValidationState> {
    const sourceRevision = await this.history.captureSourceRevision(session);
    this.candidate.invalidate();
    const result = await this.validation.run({
      sourceRevision,
      readSourceRevision: () => this.history.captureSourceRevision(session),
      ...(originToolCallId ? { originToolCallId } : {}),
    });
    this.emit({ type: "review", review: await this.history.getReview(session) });
    return result;
  }

  private trackValidation(operation: Promise<ValidationState>): Promise<ValidationState> {
    this.validationOperation = operation;
    void operation.finally(() => {
      if (this.validationOperation === operation) this.validationOperation = undefined;
    }).catch(() => undefined);
    return operation;
  }

  /**
   * 验证通过后刷新 CodeGraph 索引只是后台副作用：只异步启动，绝不阻塞已经落定的验证结果。
   */
  private scheduleCodegraphSync(validation: ValidationState): void {
    if (validation.status === "running" || validation.status === "stale") {
      // 新的验证阶段或失效结果：待启动的意图必须作废，在途进程也必须停掉（否则会按旧源码写索引）。
      this.codegraphSyncIntent = undefined;
      void this.cancelCodegraphSync();
      return;
    }
    const runId = validation.status === "passed" ? validation.runId : null;
    const projectPath = this.projectPath;
    if (!runId || !projectPath) return;
    // 同一次验证只同步一次：onChange 可能对同一个终态重复发布。
    if (this.codegraphSyncedRunIds.has(runId) || this.codegraphSyncIntent?.runId === runId) return;
    this.codegraphSyncIntent = { runId, projectPath };
    void this.drainCodegraphSync();
  }

  /**
   * 串行消费同步意图。启动前先等旧的在途同步真正清理完，因此「新 passed 已发布、旧同步被取消但尚未
   * 结束」时不会静默丢同步；若等待期间意图被新的验证阶段作废或被更新的 passed 替换，则重新判断，
   * 绝不在换项目或新的 running 之后滞后启动。
   */
  private async drainCodegraphSync(): Promise<void> {
    if (this.codegraphSyncDraining) return;
    this.codegraphSyncDraining = true;
    try {
      for (;;) {
        const intent = this.codegraphSyncIntent;
        if (!intent) return;
        await this.cancelCodegraphSync();
        // 身份比较同时覆盖两种情况：意图被 running/stale/关闭清除，或被更新的 passed 替换。
        if (this.codegraphSyncIntent !== intent) continue;
        this.codegraphSyncIntent = undefined;
        if (intent.projectPath !== this.projectPath) return;
        this.codegraphSyncedRunIds.add(intent.runId);
        const controller = new AbortController();
        const operation = this.runCodegraphSync(intent.projectPath, controller.signal);
        const active = { projectPath: intent.projectPath, controller, operation };
        this.codegraphSync = active;
        // 失败已在 runCodegraphSync 里转成用户可见提示，这里只负责回收在途状态。
        await operation;
        if (this.codegraphSync === active) this.codegraphSync = undefined;
      }
    } finally {
      this.codegraphSyncDraining = false;
    }
  }

  private async runCodegraphSync(projectPath: string, signal: AbortSignal): Promise<void> {
    try {
      // 返回 false 表示项目没有索引：宿主只刷新已有索引，绝不代替用户执行 init。
      await this.codegraphTool.syncIndex(projectPath, signal);
    } catch (error) {
      // 主动取消不是失败，用户不需要因此看到提示。
      if (signal.aborted) return;
      this.emit({ type: "notice", message: `CodeGraph 索引同步失败：${errorText(error)}` });
    }
  }

  /** 取消在途同步并等它真正结束，防止旧项目目录上的尾部写入落到新项目或已关闭的窗口上。 */
  private async cancelCodegraphSync(): Promise<void> {
    const active = this.codegraphSync;
    if (!active) return;
    active.controller.abort();
    await active.operation;
    if (this.codegraphSync === active) this.codegraphSync = undefined;
  }

  async stopValidation(): Promise<void> {
    await this.validation.stop();
  }

  async getReview(): Promise<ChangeReview> {
    const review = await this.history.getReview(this.requireRuntime().session);
    this.emit({ type: "review", review });
    return review;
  }

  async rejectReviewFile(path: string): Promise<ChangeReview> {
    const session = this.requireRuntime().session;
    this.validation.invalidate("A reviewed file was restored to its pre-task state.");
    this.candidate.invalidate();
    const review = await this.history.rejectFile(session, path);
    this.emit({ type: "review", review });
    await this.emitHistory(session, { message: `Rejected changes in ${path}.` });
    return review;
  }

  async prepareCandidate(): Promise<CandidateState> {
    const session = this.requireRuntime().session;
    await this.assertValidationCurrent(session, "Run verification successfully before preparing a candidate.");
    const candidate = await this.candidate.prepare();
    try {
      await this.assertValidationCurrent(session, "Source changed while preparing the candidate. Run verification again.");
      return candidate;
    } catch (error) {
      this.candidate.invalidate();
      throw error;
    }
  }

  async activateCandidate(): Promise<void> {
    const session = this.requireRuntime().session;
    await this.assertValidationCurrent(session, "The verified result is stale. Run verification again.");
    await this.candidate.activate();
  }

  private async assertValidationCurrent(session: AgentSession, message: string): Promise<void> {
    if (this.options.allowSelfUpdate === false) throw new Error("该会话不负责自更新，请回到项目主会话。");
    const validation = this.validation.getState();
    if (!validation.isSelfProject) throw new Error("Candidate updates are available only for the pi-ecode source project.");
    if (validation.status !== "passed" || !validation.sourceRevision) throw new Error(message);
    if (await this.history.captureSourceRevision(session) === validation.sourceRevision) return;
    this.validation.invalidate("Project files changed after the last verification.");
    this.candidate.invalidate();
    throw new Error(message);
  }

  async rendererReady(): Promise<void> {
    await this.candidate.rendererReady();
  }

  private sessionGuard(session: AgentSession): () => boolean {
    const projectPath = this.projectPath;
    const sessionId = session.sessionId;
    const cwd = session.sessionManager?.getCwd?.();
    // SDK 可以在同一 session 对象上切换会话，不能仅比较对象引用。
    return () => this.runtime?.session === session && this.projectPath === projectPath
      && session.sessionId === sessionId && session.sessionManager?.getCwd?.() === cwd;
  }

  private async refreshInBackground(isCurrent: () => boolean, label: string, refresh: () => Promise<void>): Promise<void> {
    if (!isCurrent()) return;
    try {
      await refresh();
    } catch (error) {
      if (isCurrent()) this.emit({ type: "notice", message: `${label}失败，可稍后重试：${errorText(error)}` });
    }
  }

  private async refreshReview(session: AgentSession): Promise<void> {
    const isCurrent = this.sessionGuard(session);
    if (!isCurrent()) return;
    const review = await this.history.getReview(session);
    if (isCurrent()) this.emit({ type: "review", review });
  }

  private async emitHistory(session: AgentSession, result?: import("../../shared/contracts.js").HistoryOperationResult): Promise<void> {
    const isCurrent = this.sessionGuard(session);
    if (!isCurrent()) return;
    const history = await this.history.getState(session);
    if (!isCurrent()) return;
    this.emit({
      type: "history",
      history,
      ...(result?.editorText !== undefined ? { editorText: result.editorText } : {}),
      ...(result?.editorImages ? { editorImages: result.editorImages } : {}),
      ...(result?.message ? { notice: result.message } : {}),
    });
  }

  private createRuntimeFactory(): CreateAgentSessionRuntimeFactory {
    return async ({ cwd: targetCwd, sessionManager, sessionStartEvent }) => {
      let owner: AgentSession | undefined;
      const mcp = new NativeMcp((tools) => {
        if (owner) this.publishMcpTools(owner, tools);
      });
      const services = await createAgentSessionServices({
        cwd: targetCwd,
        resourceLoaderOptions: {
          extensionFactories: [
            ...mcp.extensions(),
            (pi) => {
              let installed = false;
              pi.on("session_start", () => {
                if (!installed) {
                  installed = true;
                  toolAdvisorExtension(this.statistics, (message) => this.emit({ type: "notice", message }))(pi);
                }
              });
            },
            this.history.asExtension(),
            this.nativeCompaction.asExtension(),
            this.confirmation.asExtension(),
            this.taskPlan.asExtension(),
            this.validationTool.asExtension(),
            this.managedProcessTool.asExtension(),
            this.codegraphTool.asExtension(),
          ],
          eventBus: this.extensionEventBus,
          appendSystemPromptOverride: (base) => [
            ...base,
            EDIT_TOOL_COMPATIBILITY_GUIDANCE,
            PARALLEL_TOOL_EXECUTION_GUIDANCE,
            VALIDATION_ORCHESTRATION_GUIDANCE,
          ],
          extensionsOverride: (base) => ({
            ...base,
            extensions: base.extensions.filter((extension) => (
              !extension.path.replaceAll("\\", "/").includes("/node_modules/pi-workspace-history/")
              && !extension.path.replaceAll("\\", "/").includes("/node_modules/pi-mcp-adapter/")
            )),
          }),
        },
      });
      await this.installToolStatistics(services.settingsManager);
      const sessionRuntime = await createAgentSessionFromServices({
        services,
        sessionManager,
        ...(sessionStartEvent ? { sessionStartEvent } : {}),
      });
      owner = sessionRuntime.session;
      this.sessionMcp.set(owner, mcp);
      // Keep parallel batching an explicit pi-ecode contract instead of relying on the SDK default.
      sessionRuntime.session.agent.toolExecution = "parallel";
      return {
        ...sessionRuntime,
        services,
        diagnostics: services.diagnostics,
      };
    };
  }

  private currentToolStatistics(session = this.runtime?.session): ToolStatistic[] {
    if (!session || !this.statistics) return [];
    return declaredToolStatistics(session.getAllTools(), session.getActiveToolNames(), this.statistics.current);
  }

  private publishMcpTools(session: AgentSession, tools: McpToolSummary[]): void {
    if (this.runtime?.session !== session) return;
    this.emit({ type: "mcp-tools", tools });
    // Withdrawal changes availability without completing another tool call.
    this.emit({ type: "tool-statistics", statistics: this.currentToolStatistics(session) });
  }

  private async installToolStatistics(settings: Pick<SettingsManager, "getOrCreateDeviceId">): Promise<void> {
    this.unsubscribeStatistics?.();
    this.statistics = undefined;
    this.statisticsError = null;
    try {
      const fileName = createHash("sha256").update(JSON.stringify([settings.getOrCreateDeviceId(), hostname(), process.platform, process.arch])).digest("hex");
      const statistics = toolStatisticsStore(join(getAgentDir(), "state", "pi-ecode-tool-statistics", `${fileName}.json`));
      await statistics.initialize();
      this.statistics = statistics;
      this.unsubscribeStatistics = statistics.subscribe(() => this.emit({ type: "tool-statistics", statistics: this.currentToolStatistics() }));
    } catch (error) {
      this.statisticsError = `本机工具统计不可用，已停用记录并保留原文件：${error instanceof Error ? error.message : String(error)}`;
      this.reportError(this.statisticsError);
    }
  }

  private requireRuntime(): AgentSessionRuntime {
    if (!this.runtime) throw new Error("Choose a project before starting a conversation.");
    return this.runtime;
  }

  private applyContextBudget(session: AgentSession): void {
    if (!session.model) return;
    const configuredReserve = configuredCompactionReserveTokens(
      session.settingsManager.getGlobalSettings(),
      session.settingsManager.getProjectSettings(),
    );
    session.settingsManager.applyOverrides({
      compaction: { reserveTokens: contextBudgetReserveTokens(session.model.contextWindow, configuredReserve) },
    });
  }

  private async bindSession(session: AgentSession): Promise<void> {
    this.sessionTitles.dispose();
    this.unsubscribe?.();
    this.applyContextBudget(session);
    this.visibleTimelineTurns = HISTORY_PAGE_TURNS;
    this.extensionUi.cancelPending();
    this.contextEstimate = this.nativeCompaction.storedEstimatedTokensAfter(session);
    this.compactionStatus = { status: "idle" };
    this.streamContinuity.install(session);
    this.confirmation.install(session);
    this.liveTools.clear();
    this.liveAssistantId = undefined;
    this.liveAssistantText = "";
    this.assistantStreaming = false;
    const fallbackUi = session.extensionRunner.getUIContext();
    await session.bindExtensions({ mode: "rpc", uiContext: this.extensionUi.createContext(fallbackUi) });
    this.unsubscribe = session.subscribe((event) => this.handleSessionEvent(session, event));
  }

  private handleSessionEvent(session: AgentSession, event: AgentSessionEvent): void {
    switch (event.type) {
      case "agent_start":
        this.liveAssistantId = undefined;
        this.liveAssistantText = "";
        if (!this.validationTool.consumePreservedAgentStart()) this.validation.invalidate();
        this.candidate.invalidate();
        this.emit({ type: "review", review: { ...EMPTY_AGENT_SNAPSHOT.review } });
        this.emit({ type: "state", patch: { isStreaming: true, error: null, canContinue: false } });
        break;
      case "agent_settled": {
        this.flushStreamItems();
        const failure = providerFailure(session.messages);
        this.emit({ type: "state", patch: {
          isStreaming: this.isAgentActive(session), workingStartedAt: this.workingStartedAt,
          pendingCount: session.pendingMessageCount,
          error: failure?.message ?? null, canContinue: failure?.canContinue ?? false,
        } });
        this.emitContext(session);
        const isCurrent = this.sessionGuard(session);
        void this.refreshInBackground(isCurrent, "会话列表刷新", () => this.refreshSessions(session));
        queueMicrotask(() => {
          void this.refreshInBackground(isCurrent, "历史状态刷新", () => this.emitHistory(session));
          void this.refreshInBackground(isCurrent, "变更评审刷新", () => this.refreshReview(session));
        });
        break;
      }
      case "queue_update":
        this.emit({ type: "state", patch: { pendingCount: event.steering.length + event.followUp.length } });
        break;
      case "auto_retry_start":
        this.emit({
          type: "state",
          patch: { error: `Connection interrupted · retrying ${event.attempt}/${event.maxAttempts}…`, canContinue: false },
        });
        break;
      case "auto_retry_end":
        this.emit({
          type: "state",
          patch: { error: event.success ? null : event.finalError ?? "Connection recovery failed." },
        });
        break;
      case "message_start":
        if (event.message.role === "assistant") {
          this.assistantStreaming = true;
          this.liveAssistantId = undefined;
          this.liveAssistantText = "";
        }
        break;
      case "message_update": {
        const update = event.assistantMessageEvent;
        if (update.type === "text_delta") {
          if (!this.liveAssistantId) {
            this.liveAssistantId = `live-assistant-${session.sessionId}-${this.liveAssistantSequence++}`;
            this.liveAssistantText = "";
          }
          this.liveAssistantText += update.delta;
          const message: ConversationMessage = {
            id: this.liveAssistantId,
            role: "assistant",
            text: this.liveAssistantText,
            timestamp: Date.now(),
          };
          this.pendingStreamContext = session;
          this.publishStreamItem(messageItem(message));
        } else {
          this.emitContext(session);
        }
        break;
      }
      case "message_end": {
        if (event.message.role === "assistant") this.assistantStreaming = false;
        this.flushStreamItems();
        if (event.message.role === "user") {
          const userMessage = event.message;
          // SDK 先通知 message_end 再同步追加会话条目。等落盘后发布，图片引用才能对上完整历史索引。
          queueMicrotask(() => {
            if (this.runtime?.session !== session) return;
            const messages = historyMessages(session.sessionManager.getBranch());
            const messageIndex = messages.indexOf(event.message);
            if (messageIndex < 0) return;
            const item = mapTimeline([event.message], messageIndex).at(0);
            if (item?.kind === "message") {
              this.emit({ type: "timeline-upsert", item });
              this.sessionTitles.start(session, textFromContent(userMessage.content), this.sessionGuard(session));
            }
          });
        }
        this.emitContext(session);
        break;
      }
      case "tool_execution_start": {
        this.flushStreamItems();
        const tool: ToolActivity = {
          id: event.toolCallId,
          name: event.toolName,
          title: toolTitle(event.toolName, event.args),
          input: formatToolInput(event.args),
          output: "",
          status: "running",
          startedAt: Date.now(),
        };
        this.liveTools.set(tool.id, tool);
        this.emit({ type: "timeline-upsert", item: toolItem(tool) });
        this.liveAssistantId = undefined;
        this.liveAssistantText = "";
        break;
      }
      case "tool_execution_update": {
        const current = this.liveTools.get(event.toolCallId);
        if (!current) break;
        const tool = { ...current, ...toolOutputView(textFromToolResult(event.partialResult)) };
        this.liveTools.set(tool.id, tool);
        this.publishStreamItem(toolItem(tool));
        break;
      }
      case "tool_execution_end": {
        this.flushStreamItems();
        const current = this.liveTools.get(event.toolCallId);
        const tool: ToolActivity = {
          id: event.toolCallId,
          name: event.toolName,
          title: current?.title ?? event.toolName,
          input: current?.input ?? "",
          ...toolOutputView(textFromToolResult(event.result)),
          status: event.isError ? "error" : "success",
          startedAt: current?.startedAt ?? Date.now(),
          endedAt: Date.now(),
        };
        this.liveTools.set(tool.id, tool);
        this.emit({ type: "timeline-upsert", item: toolItem(tool) });
        break;
      }
      case "compaction_start": {
        const current = this.compactionStatus.status === "running" ? this.compactionStatus : undefined;
        this.compactionStatus = {
          status: "running",
          reason: event.reason,
          method: this.compactionMethod(session),
          tokensBefore: current?.tokensBefore ?? session.getContextUsage()?.tokens ?? this.contextEstimate,
        };
        this.emitContext(session);
        break;
      }
      case "compaction_end": {
        const active = this.compactionStatus.status === "running" ? this.compactionStatus : undefined;
        const method = active?.method ?? this.compactionMethod(session);
        const tokensBefore = active?.tokensBefore ?? null;
        const nativeEstimate = this.nativeCompaction.consumeEstimatedTokensAfter();
        const estimatedTokensAfter = event.result
          ? nativeEstimate ?? event.result.estimatedTokensAfter ?? null
          : null;
        this.contextEstimate = estimatedTokensAfter;
        if (event.aborted) {
          this.compactionStatus = { status: "cancelled", reason: event.reason, method };
        } else if (event.errorMessage || !event.result) {
          this.compactionStatus = {
            status: "failed",
            reason: event.reason,
            method,
            message: event.errorMessage ?? "Context compaction did not produce a result.",
          };
        } else {
          this.compactionStatus = {
            status: "completed",
            reason: event.reason,
            method,
            tokensBefore,
            tokensAfter: estimatedTokensAfter,
            isEstimated: estimatedTokensAfter !== null,
          };
        }
        if (event.errorMessage) this.emit({ type: "error", message: event.errorMessage });
        this.emitContext(session);
        break;
      }
      case "thinking_level_changed":
        this.emitModelState(session);
        break;
      case "session_info_changed":
        this.emit({ type: "state", patch: { sessionTitle: event.name ?? null } });
        void this.refreshInBackground(this.sessionGuard(session), "会话列表刷新", () => this.refreshSessions(session));
        break;
    }
  }

  private compactionMethod(session: AgentSession): CompactionMethod {
    return this.nativeCompaction.supports(session.model) ? "native" : "summary";
  }

  private canCompact(session: AgentSession): boolean {
    return session.sessionManager.getBranch().at(-1)?.type !== "compaction";
  }

  private contextState(session: AgentSession, usage = session.getContextUsage()): import("../../shared/contracts.js").ContextState {
    const contextWindow = usage?.contextWindow ?? session.model?.contextWindow ?? null;
    if (usage?.tokens !== null && usage?.tokens !== undefined) this.contextEstimate = null;
    const tokens = usage?.tokens ?? this.contextEstimate;
    return {
      tokens,
      contextWindow,
      percent: usage?.percent ?? (tokens !== null && contextWindow ? tokens / contextWindow * 100 : null),
      canCompact: this.canCompact(session),
      isCompacting: this.compactionStatus.status === "running" || session.isCompacting,
      isEstimated: usage?.tokens == null && tokens !== null,
      compactionMethod: this.compactionStatus.status === "running"
        ? this.compactionStatus.method
        : session.isCompacting ? this.compactionMethod(session) : null,
      compaction: this.compactionStatus,
    };
  }

  private emitContext(session: AgentSession): void {
    this.emit({ type: "context", context: this.contextState(session) });
  }

  private emitModelState(session: AgentSession): void {
    const model = session.model;
    this.emit({
      type: "state",
      patch: {
        selectedModel: model ? `${model.provider}/${model.id}` : null,
        thinkingLevel: session.thinkingLevel,
        thinkingLevels: session.getAvailableThinkingLevels(),
      },
    });
  }

  private async loadSessionSummaries(): Promise<import("../../shared/contracts.js").SessionSummary[]> {
    const projectPath = this.projectPath;
    const session = this.runtime?.session;
    const isCurrent = session ? this.sessionGuard(session) : () => this.projectPath === projectPath;
    const revision = ++this.sessionSummaryRevision;
    // Legacy conversations keep their files in the old session directory even when their runtime uses the selected project.
    const sessions = await listSessionSummaries(session?.sessionManager.getHeader()?.cwd ?? projectPath, session?.sessionManager.getSessionDir());
    // SDK 会原地切换 session；旧项目、旧会话或较早刷新不得回写当前列表。
    if (projectPath && isCurrent() && revision === this.sessionSummaryRevision) {
      this.sessionSummaries = { projectPath, sessions };
    }
    return sessions;
  }

  private async refreshSessions(session = this.runtime?.session): Promise<void> {
    const projectPath = this.projectPath;
    const isCurrent = session ? this.sessionGuard(session) : () => this.projectPath === projectPath;
    if (!isCurrent()) return;
    const sessions = await this.loadSessionSummaries();
    if (isCurrent() && this.sessionSummaries?.sessions === sessions) this.emit({ type: "sessions", sessions });
  }

  respondExtensionUi(response: ExtensionUiResponse): boolean {
    return this.extensionUi.respond(response);
  }

  private async disposeRuntime(): Promise<void> {
    this.sessionTitles.dispose();
    this.unsubscribeStatistics?.();
    this.unsubscribeStatistics = undefined;
    await this.statistics?.flush().catch((error: unknown) => this.emit({ type: "notice", message: `工具统计保存失败：${errorText(error)}` }));
    this.sessionSummaries = undefined;
    this.sessionSummaryRevision += 1;
    if (this.streamTimer !== undefined) clearTimeout(this.streamTimer);
    this.streamTimer = undefined;
    this.pendingStreamItems.clear();
    this.pendingStreamContext = undefined;
    this.extensionUi.cancelPending();
    this.validationTool.reset();
    await this.validation.stop();
    // 项目切换与窗口关闭都必须先丢弃待启动意图，再停掉在途同步，否则旧目录可能被继续写入。
    this.codegraphSyncIntent = undefined;
    await this.cancelCodegraphSync();
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    if (this.runtime) await this.runtime.dispose();
    this.runtime = undefined;
    this.promptLifecycle.reset();
    this.liveTools.clear();
  }

  async dispose(): Promise<void> {
    await this.managedProcesses.dispose();
    this.auth.cancel();
    await this.disposeRuntime();
    this.removeQuestionnaireListener();
    this.extensionEventBus.clear();
    await this.validation.dispose();
    this.listeners.clear();
  }
}
