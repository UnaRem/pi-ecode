import { basename, join, resolve } from "node:path";
import { stat } from "node:fs/promises";
import {
  type AgentSession,
  type AgentSessionEvent,
  type AgentSessionRuntime,
  type CreateAgentSessionRuntimeFactory,
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
  ConversationMessage,
  ImageAttachment,
  ModelOption,
  SessionSummary,
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
import { formatToolInput, mapMessages, textFromContent, textFromToolResult, toolTitle } from "./message-mapper.js";
import { mapTimeline, messageItem, toolItem } from "./timeline-mapper.js";
import { NativeCompaction } from "./native-compaction.js";
import { StreamContinuity } from "./stream-continuity.js";
import { TaskPlanService } from "./task-plan.js";
import { ExtensionUiBridge } from "./extension-ui-bridge.js";
import { AuthService } from "./auth-service.js";
import { PromptLifecycle } from "./prompt-lifecycle.js";

const EMPTY_SNAPSHOT: AgentSnapshot = {
  projectPath: null,
  projectName: null,
  sessionId: null,
  sessionFile: null,
  sessionTitle: null,
  sessions: [],
  messages: [],
  tools: [],
  timeline: [],
  models: [],
  selectedModel: null,
  thinkingLevel: "off",
  thinkingLevels: ["off"],
  isStreaming: false,
  pendingCount: 0,
  error: null,
  taskPlan: null,
  extensionUi: null,
  history: { available: false, canUndo: false, canRedo: false, isBusy: false, message: null },
  validation: {
    supported: false,
    isSelfProject: false,
    status: "idle",
    runId: null,
    activeStep: null,
    steps: [],
    verifiedAt: null,
    message: null,
  },
  review: {
    available: false,
    baseCommit: null,
    headCommit: null,
    files: [],
    patch: "",
    truncated: false,
    message: null,
  },
  candidate: {
    status: "idle",
    candidateId: null,
    candidatePath: null,
    preparedAt: null,
    message: null,
    history: [],
  },
  context: {
    tokens: null,
    contextWindow: null,
    percent: null,
    isCompacting: false,
    isEstimated: false,
    compactionMethod: null,
    compaction: { status: "idle" },
  },
  policy: { contextFiles: [], workflow: "manual-review", gitCommits: "required-after-verification" },
};

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class AgentService {
  private runtime: AgentSessionRuntime | undefined;
  private projectPath: string | undefined;
  private startupError: string | undefined;
  private unsubscribe: (() => void) | undefined;
  private readonly listeners = new Set<(event: AgentEvent) => void>();
  private readonly authListeners = new Set<(event: AuthFlowEvent) => void>();
  private readonly auth: AuthService;
  private readonly liveTools = new Map<string, ToolActivity>();
  private liveAssistantId: string | undefined;
  private liveAssistantText = "";
  private liveAssistantSequence = 0;
  private readonly promptLifecycle = new PromptLifecycle((session) => {
    const isStreaming = this.isPromptActive(session);
    this.emit({
      type: "state",
      patch: { isStreaming, pendingCount: session.pendingMessageCount, ...(isStreaming ? { error: null } : {}) },
    });
  });
  private compactOperation: Promise<void> | undefined;
  private contextEstimate: number | null = null;
  private compactionStatus: CompactionStatus = { status: "idle" };
  private readonly nativeCompaction = new NativeCompaction(
    () => this.runtime?.session,
    fetch,
    (message) => this.emit({ type: "error", message }),
  );
  private readonly streamContinuity = new StreamContinuity();
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
  private readonly validation = new ValidationService((validation) => {
    if (validation.status === "stale") this.candidate.invalidate();
    this.emit({ type: "validation", validation });
  });
  private readonly candidate = new CandidateService(
    join(getAgentDir(), "state", "pi-ecode-self-update"),
    (candidate) => this.emit({ type: "candidate", candidate }),
  );

  constructor(openExternal: (url: string) => Promise<void> = async () => undefined) {
    this.auth = new AuthService(
      () => this.runtime?.session.modelRuntime,
      (event) => {
        for (const listener of this.authListeners) listener(event);
      },
      openExternal,
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

  async openProject(inputPath: string): Promise<AgentSnapshot> {
    const cwd = resolve(inputPath);
    const details = await stat(cwd);
    if (!details.isDirectory()) throw new Error("Selected project is not a directory.");

    await this.disposeRuntime();
    this.projectPath = cwd;
    this.startupError = undefined;

    try {
      this.runtime = await createAgentSessionRuntime(this.createRuntimeFactory(), {
        cwd,
        agentDir: getAgentDir(),
        sessionManager: SessionManager.continueRecent(cwd),
      });
      this.runtime.setRebindSession(async (session) => this.bindSession(session));
      await this.bindSession(this.runtime.session);
      await this.validation.configure(cwd);
      this.candidate.configure(cwd);
      const snapshot = await this.getSnapshot();
      this.emit({ type: "snapshot", snapshot });
      return snapshot;
    } catch (error) {
      await this.disposeRuntime();
      this.projectPath = undefined;
      throw error;
    }
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

  get runtimeBusy(): boolean {
    const session = this.runtime?.session;
    return Boolean(session && (this.promptLifecycle.isActive(session) || session.isCompacting));
  }

  async reloadRuntimeConfiguration(): Promise<void> {
    const previousRuntime = this.requireRuntime();
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
    if (!this.runtime || !this.projectPath) {
      return { ...EMPTY_SNAPSHOT, error: this.startupError ?? null };
    }
    const session = this.runtime.session;
    const [sessions, availableModels, history, review] = await Promise.all([
      this.listSessions(),
      session.modelRuntime.getAvailable().catch(() => session.modelRuntime.getAvailableSnapshot()),
      this.history.getState(session),
      this.history.getReview(session),
    ]);
    const mapped = mapMessages(session.messages);
    const timeline = mapTimeline(session.messages);
    const model = session.model;
    const usage = session.getContextUsage();
    const contextFiles = session.resourceLoader.getAgentsFiles().agentsFiles.map((file) => file.path);

    return {
      projectPath: this.projectPath,
      projectName: basename(this.projectPath),
      sessionId: session.sessionId,
      sessionFile: session.sessionFile ?? null,
      sessionTitle: session.sessionName ?? null,
      sessions,
      messages: mapped.messages,
      tools: mapped.tools,
      timeline,
      models: availableModels.map<ModelOption>((item) => ({
        id: item.id,
        provider: item.provider,
        name: item.name,
        reasoning: item.reasoning,
      })),
      selectedModel: model ? `${model.provider}/${model.id}` : null,
      thinkingLevel: session.thinkingLevel,
      thinkingLevels: session.getAvailableThinkingLevels(),
      isStreaming: this.isPromptActive(session),
      pendingCount: session.pendingMessageCount,
      error: this.runtime.modelFallbackMessage ?? this.runtime.diagnostics.at(0)?.message ?? null,
      taskPlan: this.taskPlan.current,
      extensionUi: this.extensionUi.current,
      history,
      validation: this.validation.getState(),
      review,
      candidate: this.candidate.getState(),
      context: this.contextState(session, usage),
      policy: { contextFiles, workflow: "manual-review", gitCommits: "required-after-verification" },
    };
  }

  async newSession(): Promise<AgentSnapshot> {
    const runtime = this.requireRuntime();
    await runtime.newSession();
    const snapshot = await this.getSnapshot();
    this.emit({ type: "snapshot", snapshot });
    return snapshot;
  }

  async switchSession(sessionPath: string): Promise<AgentSnapshot> {
    const runtime = this.requireRuntime();
    const sessions = await this.listSessions();
    if (!sessions.some((session) => session.path === sessionPath)) {
      throw new Error("That session does not belong to the active project.");
    }
    await runtime.switchSession(sessionPath);
    const snapshot = await this.getSnapshot();
    this.emit({ type: "snapshot", snapshot });
    return snapshot;
  }

  async prompt(message: string, images: ImageAttachment[] = []): Promise<void> {
    const session = this.requireRuntime().session;
    const text = message.trim();
    if (!text && images.length === 0) return;
    const promptText = text || "Describe the attached image.";
    const sdkImages = images.map((image) => ({ type: "image" as const, data: image.data, mimeType: image.mimeType }));
    try {
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
    this.extensionUi.cancelPending();
    if (session.isCompacting) session.abortCompaction();
    await this.promptLifecycle.stop(session);
    await this.history.settlePending(session);
    await this.emitHistory(session);
  }

  async setModel(provider: string, modelId: string): Promise<void> {
    const session = this.requireRuntime().session;
    const model = session.modelRuntime.getModel(provider, modelId);
    if (!model) throw new Error(`Model not found: ${provider}/${modelId}`);
    await session.setModel(model);
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
    const session = this.requireRuntime().session;
    await this.history.checkpoint(session, "validation input");
    this.candidate.invalidate();
    const result = await this.validation.run();
    const review = await this.history.getReview(session);
    this.emit({ type: "review", review });
    return result;
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
    const validation = this.validation.getState();
    if (!validation.isSelfProject) throw new Error("Candidate updates are available only for the pi-ecode source project.");
    if (validation.status !== "passed") throw new Error("Run verification successfully before preparing a candidate.");
    return this.candidate.prepare();
  }

  async activateCandidate(): Promise<void> {
    const validation = this.validation.getState();
    if (validation.status !== "passed") throw new Error("The verified result is stale. Run verification again.");
    await this.candidate.activate();
  }

  async rendererReady(): Promise<void> {
    await this.candidate.rendererReady();
  }

  private async refreshReview(session: AgentSession): Promise<void> {
    this.emit({ type: "review", review: await this.history.getReview(session) });
  }

  private async emitHistory(session: AgentSession, result?: import("../../shared/contracts.js").HistoryOperationResult): Promise<void> {
    const history = await this.history.getState(session);
    this.emit({
      type: "history",
      history,
      ...(result?.editorText !== undefined ? { editorText: result.editorText } : {}),
      ...(result?.editorImages ? { editorImages: result.editorImages } : {}),
      ...(result?.message ? { notice: result.message } : {}),
    });
  }

  private isPromptActive(session: AgentSession): boolean {
    return this.promptLifecycle.isActive(session);
  }

  private createRuntimeFactory(): CreateAgentSessionRuntimeFactory {
    return async ({ cwd: targetCwd, sessionManager, sessionStartEvent }) => {
      const services = await createAgentSessionServices({
        cwd: targetCwd,
        resourceLoaderOptions: {
          extensionFactories: [this.history.asExtension(), this.nativeCompaction.asExtension(), this.taskPlan.asExtension()],
          eventBus: this.extensionEventBus,
          extensionsOverride: (base) => ({
            ...base,
            extensions: base.extensions.filter((extension) => (
              !extension.path.replaceAll("\\", "/").includes("/node_modules/pi-workspace-history/")
            )),
          }),
        },
      });
      return {
        ...(await createAgentSessionFromServices({
          services,
          sessionManager,
          ...(sessionStartEvent ? { sessionStartEvent } : {}),
        })),
        services,
        diagnostics: services.diagnostics,
      };
    };
  }

  private requireRuntime(): AgentSessionRuntime {
    if (!this.runtime) throw new Error("Choose a project before starting a conversation.");
    return this.runtime;
  }

  private async bindSession(session: AgentSession): Promise<void> {
    this.unsubscribe?.();
    this.extensionUi.cancelPending();
    this.contextEstimate = this.nativeCompaction.storedEstimatedTokensAfter(session);
    this.compactionStatus = { status: "idle" };
    this.streamContinuity.install(session);
    this.liveTools.clear();
    this.liveAssistantId = undefined;
    this.liveAssistantText = "";
    const fallbackUi = session.extensionRunner.getUIContext();
    await session.bindExtensions({ mode: "rpc", uiContext: this.extensionUi.createContext(fallbackUi) });
    this.unsubscribe = session.subscribe((event) => this.handleSessionEvent(session, event));
  }

  private handleSessionEvent(session: AgentSession, event: AgentSessionEvent): void {
    switch (event.type) {
      case "agent_start":
        this.liveAssistantId = undefined;
        this.liveAssistantText = "";
        this.validation.invalidate();
        this.candidate.invalidate();
        this.emit({ type: "state", patch: { isStreaming: true, error: null } });
        break;
      case "agent_settled":
        this.emit({ type: "state", patch: { isStreaming: this.isPromptActive(session), pendingCount: session.pendingMessageCount } });
        this.emitContext(session);
        void this.refreshSessions();
        queueMicrotask(() => {
          void this.emitHistory(session);
          void this.refreshReview(session);
        });
        break;
      case "queue_update":
        this.emit({ type: "state", patch: { pendingCount: event.steering.length + event.followUp.length } });
        break;
      case "auto_retry_start":
        this.emit({
          type: "state",
          patch: { error: `Connection interrupted · retrying ${event.attempt}/${event.maxAttempts}…` },
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
          this.liveAssistantId = undefined;
          this.liveAssistantText = "";
        }
        break;
      case "message_update":
        if (event.assistantMessageEvent.type === "text_delta") {
          if (!this.liveAssistantId) {
            this.liveAssistantId = `live-assistant-${session.sessionId}-${this.liveAssistantSequence++}`;
            this.liveAssistantText = "";
          }
          this.liveAssistantText += event.assistantMessageEvent.delta;
          const message: ConversationMessage = {
            id: this.liveAssistantId,
            role: "assistant",
            text: this.liveAssistantText,
            timestamp: Date.now(),
          };
          this.emit({ type: "timeline-upsert", item: messageItem(message) });
          this.emit({ type: "assistant-delta", delta: event.assistantMessageEvent.delta });
        }
        this.emitContext(session);
        break;
      case "message_end": {
        if (event.message.role === "user") {
          const item = mapTimeline([event.message]).at(0);
          if (item?.kind === "message") {
            this.emit({ type: "message", message: item.message });
            this.emit({ type: "timeline-upsert", item });
          }
        }
        this.emitContext(session);
        break;
      }
      case "tool_execution_start": {
        const tool: ToolActivity = {
          id: event.toolCallId,
          name: event.toolName,
          title: toolTitle(event.toolName, event.args),
          input: formatToolInput(event.args),
          output: "",
          status: "running",
        };
        this.liveTools.set(tool.id, tool);
        this.emit({ type: "tool", tool });
        this.emit({ type: "timeline-upsert", item: toolItem(tool) });
        this.liveAssistantId = undefined;
        this.liveAssistantText = "";
        break;
      }
      case "tool_execution_update": {
        const current = this.liveTools.get(event.toolCallId);
        if (!current) break;
        const tool = { ...current, output: textFromToolResult(event.partialResult) };
        this.liveTools.set(tool.id, tool);
        this.emit({ type: "tool", tool });
        this.emit({ type: "timeline-upsert", item: toolItem(tool) });
        break;
      }
      case "tool_execution_end": {
        const current = this.liveTools.get(event.toolCallId);
        const tool: ToolActivity = {
          id: event.toolCallId,
          name: event.toolName,
          title: current?.title ?? event.toolName,
          input: current?.input ?? "",
          output: textFromToolResult(event.result),
          status: event.isError ? "error" : "success",
        };
        this.liveTools.set(tool.id, tool);
        this.emit({ type: "tool", tool });
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
    }
  }

  private compactionMethod(session: AgentSession): CompactionMethod {
    return this.nativeCompaction.supports(session.model) ? "native" : "summary";
  }

  private contextState(session: AgentSession, usage = session.getContextUsage()): import("../../shared/contracts.js").ContextState {
    const contextWindow = usage?.contextWindow ?? session.model?.contextWindow ?? null;
    if (usage?.tokens !== null && usage?.tokens !== undefined) this.contextEstimate = null;
    const tokens = usage?.tokens ?? this.contextEstimate;
    return {
      tokens,
      contextWindow,
      percent: usage?.percent ?? (tokens !== null && contextWindow ? tokens / contextWindow * 100 : null),
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

  private async listSessions(): Promise<SessionSummary[]> {
    if (!this.projectPath) return [];
    const sessions = await SessionManager.list(this.projectPath);
    return sessions.map((session) => ({
      path: session.path,
      id: session.id,
      title: session.name || session.firstMessage || "New conversation",
      modifiedAt: session.modified.getTime(),
      messageCount: session.messageCount,
    }));
  }

  private async refreshSessions(): Promise<void> {
    this.emit({ type: "sessions", sessions: await this.listSessions() });
  }

  respondExtensionUi(response: ExtensionUiResponse): boolean {
    return this.extensionUi.respond(response);
  }

  private async disposeRuntime(): Promise<void> {
    this.extensionUi.cancelPending();
    await this.validation.stop();
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    if (this.runtime) await this.runtime.dispose();
    this.runtime = undefined;
    this.promptLifecycle.reset();
    this.liveTools.clear();
  }

  async dispose(): Promise<void> {
    this.auth.cancel();
    await this.disposeRuntime();
    this.removeQuestionnaireListener();
    this.extensionEventBus.clear();
    await this.validation.dispose();
    this.listeners.clear();
  }
}
