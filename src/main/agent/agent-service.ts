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
  getAgentDir,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
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
  context: { tokens: null, contextWindow: null, percent: null, isCompacting: false, isEstimated: false, compactionMethod: null },
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
  private readonly liveTools = new Map<string, ToolActivity>();
  private liveAssistantId: string | undefined;
  private liveAssistantText = "";
  private liveAssistantSequence = 0;
  private compactOperation: Promise<void> | undefined;
  private compactCancelRequested = false;
  private contextEstimate: number | null = null;
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
  private readonly history = new WorkspaceHistory(join(getAgentDir(), "state", "pi-ecode-workspace-history"));
  private readonly validation = new ValidationService((validation) => {
    if (validation.status === "stale") this.candidate.invalidate();
    this.emit({ type: "validation", validation });
  });
  private readonly candidate = new CandidateService(
    join(getAgentDir(), "state", "pi-ecode-self-update"),
    (candidate) => this.emit({ type: "candidate", candidate }),
  );

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

    const createRuntime: CreateAgentSessionRuntimeFactory = async ({ cwd: targetCwd, sessionManager, sessionStartEvent }) => {
      const services = await createAgentSessionServices({
        cwd: targetCwd,
        resourceLoaderOptions: {
          extensionFactories: [this.history.asExtension(), this.nativeCompaction.asExtension(), this.taskPlan.asExtension()],
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

    try {
      this.runtime = await createAgentSessionRuntime(createRuntime, {
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
      isStreaming: session.isStreaming,
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
    const sdkImages = images.map((image) => ({
      type: "image" as const,
      data: image.data,
      mimeType: image.mimeType,
    }));
    try {
      await session.prompt(text || "Describe the attached image.", {
        ...(session.isStreaming ? { streamingBehavior: "steer" as const } : {}),
        ...(sdkImages.length > 0 ? { images: sdkImages } : {}),
      });
    } catch (error) {
      const message = errorText(error);
      this.emit({ type: "error", message });
      this.emit({ type: "state", patch: { isStreaming: session.isStreaming, error: message } });
      throw error;
    }
  }

  compact(): Promise<void> {
    if (this.compactOperation) return this.compactOperation;
    const session = this.requireRuntime().session;
    this.compactCancelRequested = false;
    if (session.isStreaming) return Promise.reject(new Error("Stop the active agent run before compacting context."));
    this.emit({
      type: "context",
      context: {
        tokens: session.getContextUsage()?.tokens ?? null,
        contextWindow: session.getContextUsage()?.contextWindow ?? session.model?.contextWindow ?? null,
        percent: session.getContextUsage()?.percent ?? null,
        isCompacting: true,
        isEstimated: false,
        compactionMethod: this.nativeCompaction.supports(session.model) ? "native" : "summary",
      },
    });
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
    this.compactCancelRequested = true;
    session.abortCompaction();
  }

  async stop(): Promise<void> {
    const session = this.requireRuntime().session;
    this.extensionUi.cancelPending();
    if (session.isCompacting) {
      this.compactCancelRequested = true;
      session.abortCompaction();
    }
    session.clearQueue();
    await session.abort();
    this.emit({ type: "state", patch: { isStreaming: false, pendingCount: 0 } });
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

  async createCheckpoint(label?: string): Promise<{ editorText?: string; message: string }> {
    const session = this.requireRuntime().session;
    const operation = this.history.checkpoint(session, label ?? "manual checkpoint");
    await this.emitHistory(session);
    try {
      const result = await operation;
      await this.emitHistory(session, result);
      return result;
    } catch (error) {
      await this.emitHistory(session);
      throw error;
    }
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

  private requireRuntime(): AgentSessionRuntime {
    if (!this.runtime) throw new Error("Choose a project before starting a conversation.");
    return this.runtime;
  }

  private async bindSession(session: AgentSession): Promise<void> {
    this.unsubscribe?.();
    this.extensionUi.cancelPending();
    this.contextEstimate = this.nativeCompaction.storedEstimatedTokensAfter(session);
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
        this.emit({ type: "state", patch: { isStreaming: false, pendingCount: session.pendingMessageCount } });
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
      case "compaction_start":
        this.emitContext(session);
        break;
      case "compaction_end": {
        if (event.aborted && this.compactCancelRequested) {
          this.emit({ type: "notice", message: "Context compaction cancelled." });
        }
        this.compactCancelRequested = false;
        const nativeEstimate = this.nativeCompaction.consumeEstimatedTokensAfter();
        this.contextEstimate = event.result
          ? nativeEstimate ?? event.result.estimatedTokensAfter ?? null
          : null;
        if (event.errorMessage) this.emit({ type: "error", message: event.errorMessage });
        this.emitContext(session);
        break;
      }
      case "thinking_level_changed":
        this.emitModelState(session);
        break;
    }
  }

  private contextState(session: AgentSession, usage = session.getContextUsage()): import("../../shared/contracts.js").ContextState {
    const contextWindow = usage?.contextWindow ?? session.model?.contextWindow ?? null;
    if (usage?.tokens !== null && usage?.tokens !== undefined) this.contextEstimate = null;
    const tokens = usage?.tokens ?? this.contextEstimate;
    return {
      tokens,
      contextWindow,
      percent: usage?.percent ?? (tokens !== null && contextWindow ? tokens / contextWindow * 100 : null),
      isCompacting: session.isCompacting,
      isEstimated: usage?.tokens == null && tokens !== null,
      compactionMethod: session.isCompacting
        ? (this.nativeCompaction.supports(session.model) ? "native" : "summary")
        : null,
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
    this.liveTools.clear();
  }

  async dispose(): Promise<void> {
    await this.disposeRuntime();
    await this.validation.dispose();
    this.listeners.clear();
  }
}
