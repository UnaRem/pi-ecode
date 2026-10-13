import type { AuthFlowEvent } from "../../shared/settings-contracts.js";
import { basename, join } from "node:path";
import type { AgentEvent, AgentSnapshot, ImageAttachment, SessionSummary, ValidationState } from "../../shared/contracts.js";
import { findPendingConfirmation } from "../../shared/confirmation.js";
import { AgentService } from "./agent-service.js";
import { EMPTY_AGENT_SNAPSHOT } from "./empty-agent-snapshot.js";
import { listSessionSummaries } from "./session-summaries.js";
import { SessionWorkspaceRegistry } from "./session-workspaces.js";
import { ProjectRecommendationService } from "./project-recommendations.js";

interface SessionSlot {
  service: AgentService;
  snapshot: AgentSnapshot;
  createdAt: number;
  unsubscribe: () => void;
}
interface ProjectSessionOptions {
  root: AgentService;
  createService: () => AgentService;
  workspaces?: SessionWorkspaceRegistry;
}

export class ProjectSessionService {
  private readonly root: AgentService;
  private readonly workspaces: SessionWorkspaceRegistry;
  private readonly slots = new Set<SessionSlot>();
  private readonly listeners = new Set<(event: AgentEvent) => void>();
  private readonly authListeners = new Set<(event: AuthFlowEvent) => void>();
  private readonly reservations = new Set<AgentService>();
  private readonly recommendations = new ProjectRecommendationService(() => this.publishRecommendations());
  private active: SessionSlot;
  private projectPath: string | undefined;
  private persistedSessions: SessionSummary[] = [];
  private transitioning = false;
  private workspaceOperation: Promise<unknown> | undefined;

  constructor(private readonly options: ProjectSessionOptions) {
    this.root = options.root;
    this.workspaces = options.workspaces ?? new SessionWorkspaceRegistry(join(this.root.agentDirectory, "state", "pi-ecode-session-workspaces"));
    this.active = this.addSlot(this.root);
  }

  get activeService(): AgentService { return this.active.service; }
  get rootService(): AgentService { return this.root; }
  get activeProjectPath(): string | undefined { return this.projectPath; }
  get runtimeBusy(): boolean { return this.runningServices().size > 0; }

  async initialize(): Promise<void> {
    const snapshot = await this.root.getSnapshot();
    this.active.snapshot = snapshot;
    this.projectPath = snapshot.projectPath ?? undefined;
    if (this.projectPath) await this.loadWorkspaces(this.projectPath);
    this.refreshRecommendations();
  }

  subscribe(listener: (event: AgentEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  subscribeAuth(listener: (event: AuthFlowEvent) => void): () => void {
    this.authListeners.add(listener);
    return () => this.authListeners.delete(listener);
  }

  async reloadRuntimeConfiguration(): Promise<void> {
    if (this.runtimeBusy) throw new Error("请等待所有会话结束后应用运行时配置。");
    await this.transition(async () => {
      const foreground = this.active;
      try {
        for (const slot of this.slots) {
          this.active = slot;
          await slot.service.reloadRuntimeConfiguration();
        }
      } finally { this.active = foreground; }
      return this.activeService.getSnapshot();
    });
  }

  private emit(event: AgentEvent): void {
    for (const listener of this.listeners) listener(event);
  }

  private addSlot(service: AgentService): SessionSlot {
    const slot: SessionSlot = { service, snapshot: { ...EMPTY_AGENT_SNAPSHOT }, createdAt: Date.now(), unsubscribe: () => undefined };
    const unsubscribe = service.subscribe((event) => this.handleEvent(slot, event));
    const unsubscribeAuth = service.subscribeAuth((event) => {
      if (slot === this.active) for (const listener of this.authListeners) listener(event);
    });
    slot.unsubscribe = () => { unsubscribe(); unsubscribeAuth(); };
    this.slots.add(slot);
    return slot;
  }

  private handleEvent(slot: SessionSlot, event: AgentEvent): void {
    if (event.type === "snapshot") {
      // Blank sessions have no file timestamp yet; retain their creation time until persisted metadata is available.
      if (event.snapshot.sessionId !== slot.snapshot.sessionId) slot.createdAt = Date.now();
      slot.snapshot = event.snapshot;
    }
    if (event.type === "sessions") slot.snapshot = { ...slot.snapshot, sessions: event.sessions };
    if (event.type === "state") slot.snapshot = { ...slot.snapshot, ...event.patch };
    if (event.type === "error") slot.snapshot = { ...slot.snapshot, error: event.message };
    if (event.type === "extension-ui") slot.snapshot = { ...slot.snapshot, extensionUi: event.request };
    if (event.type === "timeline-upsert") {
      const index = slot.snapshot.timeline.findIndex((item) => item.id === event.item.id);
      const timeline = index < 0 ? [...slot.snapshot.timeline, event.item] : slot.snapshot.timeline.map((item, position) => position === index ? event.item : item);
      slot.snapshot = { ...slot.snapshot, timeline: timeline.slice(-200) };
    }
    if (this.transitioning) {
      // session_start hooks may await UI input; it must reach the runtime currently being opened.
      if (slot === this.active && event.type === "extension-ui") this.emit({ type: "extension-ui", request: event.request });
      return;
    }
    if (slot === this.active) {
      if (event.type === "snapshot") this.emit({ type: "snapshot", snapshot: this.projectSnapshot(slot.snapshot) });
      else if (event.type !== "sessions") this.emit({ ...event, ...(slot.snapshot.sessionId ? { sessionId: slot.snapshot.sessionId } : {}) });
    } else if (event.type === "timeline-upsert" && event.item.kind === "message" && event.item.message.role === "user" && slot.snapshot.sessionId) {
      // Acknowledge accepted background sends; the renderer filters these from the foreground timeline.
      this.emit({ ...event, sessionId: slot.snapshot.sessionId });
    }
    if (event.type === "state" && event.patch.selectedModel !== undefined && slot === this.active) {
      this.refreshRecommendations();
      this.publishRecommendations();
    }
    const acceptedUser = event.type === "timeline-upsert" && event.item.kind === "message" && event.item.message.role === "user";
    if (acceptedUser || ["sessions", "state", "error", "extension-ui", "snapshot"].includes(event.type)) this.publishSessionList();
  }

  private publishSessionList(): void {
    if (this.transitioning) return;
    this.emit({ type: "sessions", sessions: this.sessionSummaries() });
    this.emit({ type: "parallel", parallel: this.projectSnapshot(this.active.snapshot).parallel! });
  }

  private sessionSummaries(): SessionSummary[] {
    const sessions = new Map(this.persistedSessions.map((session) => [session.path, session]));
    for (const slot of this.slots) {
      for (const summary of slot.snapshot.sessions) sessions.set(summary.path, { ...summary, workspacePath: slot.snapshot.projectPath ?? this.projectPath! });
    }
    const firstUserBySession = new Map([...this.slots].map((slot) => [slot.snapshot.sessionFile,
      slot.snapshot.timeline.find((item) => item.kind === "message" && item.message.role === "user")]));
    for (const [path, summary] of sessions) {
      if (summary.messageCount === 0 && !firstUserBySession.get(path)) sessions.delete(path);
    }
    // Shared-directory inventories overlap; apply live statuses after all inventory rows to keep background stop controls.
    for (const slot of this.slots) {
      const snapshot = slot.snapshot;
      if (!snapshot.sessionFile || !snapshot.sessionId) continue;
      const existing = sessions.get(snapshot.sessionFile);
      const firstUser = firstUserBySession.get(snapshot.sessionFile);
      if (!existing && !firstUser) continue;
      const liveMessageCount = snapshot.timeline.filter((item) => item.kind === "message").length;
      const status = this.sessionStatus(slot);
      sessions.set(snapshot.sessionFile, { path: snapshot.sessionFile, id: snapshot.sessionId,
        title: snapshot.sessionTitle ?? existing?.title ?? (firstUser?.kind === "message" ? firstUser.message.text : "New conversation"),
        messageCount: Math.max(existing?.messageCount ?? 0, liveMessageCount),
        modifiedAt: existing?.modifiedAt ?? slot.createdAt, byteSize: existing?.byteSize ?? null,
        workspacePath: snapshot.projectPath ?? this.projectPath!, runStatus: status });
    }
    return [...sessions.values()].sort((left, right) => right.modifiedAt - left.modifiedAt);
  }

  private sessionStatus(slot: SessionSlot): NonNullable<SessionSummary["runStatus"]> {
    if (slot.snapshot.extensionUi || findPendingConfirmation(slot.snapshot.timeline)) return "waiting";
    if (slot.service.runtimeBusy || this.reservations.has(slot.service)) return "running";
    if (slot.snapshot.error) return "failed";
    return slot.snapshot.timeline.length ? "completed" : "idle";
  }

  private projectSnapshot(snapshot: AgentSnapshot): AgentSnapshot {
    const runningCount = this.runningServices().size;
    return { ...snapshot, projectPath: this.projectPath ?? snapshot.projectPath,
      projectName: this.projectPath ? basename(this.projectPath) : snapshot.projectName,
      workspacePath: snapshot.projectPath, sessions: this.sessionSummaries(),
      ...(snapshot.projectProfile ? { projectProfile: { ...snapshot.projectProfile, recommendations: this.recommendations.state } } : {}),
      parallel: { maxRunning: 2, runningCount, canCreate: !this.transitioning && !this.workspaceOperation,
        reason: null } };
  }

  async getSnapshot(): Promise<AgentSnapshot> {
    const active = this.active;
    const snapshot = await active.service.getSnapshot();
    active.snapshot = snapshot;
    if (active !== this.active) return this.getSnapshot();
    this.refreshRecommendations();
    return this.projectSnapshot(snapshot);
  }

  private refreshRecommendations(): void {
    if (!this.projectPath || this.active.snapshot.timeline.length) return;
    this.recommendations.start({ projectPath: this.projectPath, sessions: this.sessionSummaries(),
      context: this.active.service.recommendationContext });
  }

  private publishRecommendations(): void {
    if (this.transitioning || !this.projectPath || this.active.snapshot.timeline.length) return;
    const active = this.active;
    const projectPath = this.projectPath;
    // Read the authoritative service snapshot; a cached slot may not include newer history/validation events.
    void active.service.getSnapshot().then((snapshot) => {
      if (this.transitioning || active !== this.active || projectPath !== this.projectPath
        || this.active.snapshot.timeline.length || snapshot.timeline.length) return;
      active.snapshot = snapshot;
      this.emit({ type: "snapshot", snapshot: this.projectSnapshot(snapshot) });
    }).catch((error: unknown) => {
      if (active === this.active && projectPath === this.projectPath) {
        this.emit({ type: "notice", message: `近期推荐更新失败：${error instanceof Error ? error.message : String(error)}` });
      }
    });
  }

  private async loadWorkspaces(projectPath: string): Promise<void> {
    await this.workspaces.configure(projectPath);
    const sessions = await Promise.all(this.workspaces.current.map(async (workspace) =>
      (await listSessionSummaries(workspace.cwd)).map((summary) => ({ ...summary, workspacePath: workspace.cwd }))));
    this.persistedSessions = sessions.flat();
  }

  async openProject(path: string): Promise<AgentSnapshot> {
    return this.transition(async () => {
      this.recommendations.cancel();
      await this.disposeChildren();
      this.active = [...this.slots].find((slot) => slot.service === this.root)!;
      const snapshot = await this.root.openProject(path);
      this.projectPath = snapshot.projectPath ?? undefined;
      this.active.snapshot = snapshot;
      this.persistedSessions = [];
      if (this.projectPath) await this.loadWorkspaces(this.projectPath);
      return snapshot;
    });
  }

  async newSession(): Promise<AgentSnapshot> {
    return this.transition(async () => {
      if (!this.projectPath) throw new Error("No project selected.");
      const slot = this.addSlot(this.options.createService());
      const previous = this.active;
      this.active = slot;
      try {
        slot.snapshot = await slot.service.openProject(this.projectPath, undefined, true);
        await this.releaseIdleChildren();
        return slot.snapshot;
      } catch (error) {
        this.active = previous;
        await this.removeSlot(slot);
        throw error;
      }
    });
  }

  async switchSession(path: string): Promise<AgentSnapshot> {
    return this.transition(async () => {
      const known = this.sessionSummaries().find((summary) => summary.path === path);
      if (!known || !this.projectPath) throw new Error("That session does not belong to the active project.");
      const cached = [...this.slots].find((slot) => slot.snapshot.sessionFile === path);
      if (cached) {
        this.active = cached;
        this.slots.delete(cached);
        this.slots.add(cached);
        cached.snapshot = await cached.service.getSnapshot();
      } else {
        const slot = this.addSlot(this.options.createService());
        const previous = this.active;
        this.active = slot;
        try { slot.snapshot = await slot.service.openProject(this.projectPath, path); }
        catch (error) { this.active = previous; await this.removeSlot(slot); throw error; }
      }
      await this.releaseIdleChildren();
      return this.active.snapshot;
    });
  }

  private async transition(operation: () => Promise<AgentSnapshot>): Promise<AgentSnapshot> {
    if (this.transitioning) throw new Error("会话正在切换，请稍后重试。");
    if (this.workspaceOperation) throw new Error("请等待文件恢复完成后切换会话。");
    this.transitioning = true;
    try {
      const snapshot = await operation();
      this.active.snapshot = snapshot;
    } finally {
      this.refreshRecommendations();
      this.transitioning = false;
      const snapshot = this.projectSnapshot(this.active.snapshot);
      this.emit({ type: "snapshot", snapshot });
    }
    return this.projectSnapshot(this.active.snapshot);
  }

  private runningServices(): Set<AgentService> {
    return new Set([...this.slots].filter((slot) => slot.service.runtimeBusy || this.reservations.has(slot.service)).map((slot) => slot.service));
  }

  private assertCanRun(service: AgentService): void {
    if (this.transitioning) throw new Error("请等待会话切换完成。");
    if (this.workspaceOperation) throw new Error("请等待文件恢复完成。");
    const running = this.runningServices();
    if (!running.has(service) && running.size >= 2) throw new Error("已有 2 个会话执行中，请先停止或等待其中一个完成。");
  }

  async prompt(message: string, images: ImageAttachment[] = []): Promise<void> {
    const service = this.activeService;
    this.assertCanRun(service);
    const reserve = !this.reservations.has(service);
    if (reserve) this.reservations.add(service);
    try { await service.prompt(message, images); }
    finally {
      if (reserve) this.reservations.delete(service);
      this.publishSessionList();
    }
  }

  async continueAfterError(): Promise<void> {
    const service = this.activeService;
    this.assertCanRun(service);
    this.reservations.add(service);
    try { await service.continueAfterError(); }
    finally { this.reservations.delete(service); this.publishSessionList(); }
  }

  async runValidation(): Promise<ValidationState> {
    const service = this.activeService;
    this.assertCanRun(service);
    this.reservations.add(service);
    try { return await service.runValidation(); }
    finally { this.reservations.delete(service); this.publishSessionList(); }
  }

  undo(): ReturnType<AgentService["undo"]> { return this.changeWorkspace((service) => service.undo()); }
  redo(): ReturnType<AgentService["redo"]> { return this.changeWorkspace((service) => service.redo()); }
  rejectReviewFile(path: string): ReturnType<AgentService["rejectReviewFile"]> {
    return this.changeWorkspace((service) => service.rejectReviewFile(path));
  }

  private async changeWorkspace<T>(operation: (service: AgentService) => Promise<T>): Promise<T> {
    const service = this.activeService;
    this.assertCanRun(service);
    if (this.runningServices().size > 0) throw new Error("请等待所有对话结束后恢复共享项目文件。");
    this.reservations.add(service);
    const pending = operation(service);
    this.workspaceOperation = pending;
    try { return await pending; }
    finally {
      this.workspaceOperation = undefined;
      this.reservations.delete(service);
      this.publishSessionList();
    }
  }

  async stopSession(path: string): Promise<void> {
    const slot = [...this.slots].find((entry) => entry.snapshot.sessionFile === path);
    if (!slot) throw new Error("该会话没有当前项目登记的运行时。");
    await slot.service.stop();
    slot.snapshot = await slot.service.getSnapshot();
    this.publishSessionList();
  }

  async deleteSession(path: string): Promise<void> {
    await this.transition(async () => {
      await this.deleteInactiveSession(path);
      return this.active.snapshot;
    });
  }

  private async deleteInactiveSession(path: string): Promise<void> {
    const summary = this.sessionSummaries().find((session) => session.path === path);
    if (!summary || path === this.active.snapshot.sessionFile) throw new Error("不能删除当前会话或项目外的会话。");
    const loaded = [...this.slots].find((slot) => slot.snapshot.sessionFile === path);
    if (loaded?.service.runtimeBusy || (loaded && this.reservations.has(loaded.service))) throw new Error("请先停止该会话的任务。");
    if (loaded?.service === this.root) {
      await this.root.newSession();
      await this.root.deleteSession(path);
    } else {
      // Cancel pending titles and finish cleanup before deleting their session file.
      if (loaded) await this.removeSlot(loaded);
      const service = this.options.createService();
      try {
        // Legacy transcript discovery still needs its original cwd; this temporary service never starts a task.
        const sourceCwd = this.persistedSessions.find((session) => session.path === path)?.workspacePath ?? this.projectPath!;
        await service.openProject(sourceCwd);
        if ((await service.getSnapshot()).sessionFile === path) await service.newSession();
        await service.deleteSession(path);
      } finally { await service.dispose(); }
    }
    this.persistedSessions = this.persistedSessions.filter((session) => session.path !== path);
    for (const slot of this.slots) slot.snapshot = { ...slot.snapshot, sessions: slot.snapshot.sessions.filter((session) => session.path !== path) };
    this.publishSessionList();
  }

  private async releaseIdleChildren(): Promise<void> {
    // Keep two recently viewed idle children; running services and owned resources cannot be evicted.
    const idleChildren = [...this.slots].filter((slot) => slot.service !== this.root
      && !slot.service.runtimeBusy && !slot.service.hasBackgroundResources && !this.reservations.has(slot.service));
    for (const slot of idleChildren.slice(0, Math.max(0, idleChildren.length - 2))) {
      if (slot !== this.active) await this.removeSlot(slot);
    }
  }

  private async removeSlot(slot: SessionSlot): Promise<void> {
    await slot.service.dispose();
    this.persistedSessions = [...this.persistedSessions.filter((summary) => !slot.snapshot.sessions.some((session) => session.path === summary.path)),
      ...slot.snapshot.sessions.map((summary) => ({ ...summary, workspacePath:
        this.persistedSessions.find((session) => session.path === summary.path)?.workspacePath ?? slot.snapshot.projectPath ?? this.projectPath! }))];
    slot.unsubscribe();
    if (slot === this.active) this.active = [...this.slots].find((entry) => entry.service === this.root)!;
    this.slots.delete(slot);
  }

  private async disposeChildren(): Promise<void> {
    const results = await Promise.allSettled([...this.slots].filter((slot) => slot.service !== this.root).map((slot) => this.removeSlot(slot)));
    const failures = results.filter((result): result is PromiseRejectedResult => result.status === "rejected");
    if (failures.length) throw new AggregateError(failures.map((failure) => failure.reason), "会话清理失败，请重试。");
  }

  async dispose(): Promise<void> {
    this.recommendations.cancel();
    this.transitioning = true;
    try {
      await this.workspaceOperation?.catch(() => undefined);
      await this.disposeChildren();
      await this.root.dispose();
      for (const slot of this.slots) slot.unsubscribe();
      this.slots.clear();
      this.listeners.clear();
      this.authListeners.clear();
    } finally {
      this.transitioning = false;
      if (this.slots.size) this.emit({ type: "snapshot", snapshot: this.projectSnapshot(this.active.snapshot) });
    }
  }
}
