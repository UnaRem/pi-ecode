import { describe, expect, it, vi } from "vitest";
import type { AgentEvent, AgentSnapshot } from "../../shared/contracts.js";
import { AgentService } from "./agent-service.js";
import { ProjectSessionService } from "./project-session-service.js";
import { EMPTY_AGENT_SNAPSHOT } from "./empty-agent-snapshot.js";
import { SessionWorkspaceRegistry } from "./session-workspaces.js";
import { listSessionSummaries } from "./session-summaries.js";

vi.mock("./session-summaries.js", () => ({ listSessionSummaries: vi.fn(async () => []) }));

function serviceFixture(id: string, cwd: string) {
  let busy = false;
  let finish = () => undefined as void;
  let snapshot: AgentSnapshot = { ...EMPTY_AGENT_SNAPSHOT, projectPath: cwd, projectName: "project", sessionId: id,
    sessionFile: `${cwd}/${id}.jsonl`, sessions: [{ path: `${cwd}/${id}.jsonl`, id, title: id, messageCount: 1, modifiedAt: 1, byteSize: 12 }] };
  const listeners = new Set<(event: AgentEvent) => void>();
  const publish = (event: AgentEvent) => {
    if (event.type === "state") snapshot = { ...snapshot, ...event.patch };
    for (const listener of listeners) listener(event);
  };
  const service = {
    agentDirectory: "/agent", get runtimeBusy() { return busy; }, hasBackgroundResources: false,
    get activeProjectPath() { return snapshot.projectPath ?? undefined; },
    getSnapshot: vi.fn(async () => snapshot),
    subscribe: (listener: (event: AgentEvent) => void) => { listeners.add(listener); return () => listeners.delete(listener); },
    subscribeAuth: () => () => undefined,
    openProject: vi.fn(async (path: string, sessionPath?: string, _startNewSession = false) => {
      snapshot = { ...snapshot, projectPath: path, sessionFile: sessionPath ?? `${path}/${id}.jsonl`,
        sessions: [{ path: sessionPath ?? `${path}/${id}.jsonl`, id, title: id, messageCount: 1, modifiedAt: 1, byteSize: 12 }] };
      publish({ type: "snapshot", snapshot });
      return snapshot;
    }),
    newSession: vi.fn(async () => snapshot),
    prompt: vi.fn(async () => {
      busy = true;
      publish({ type: "state", patch: { isStreaming: true } });
      await new Promise<void>((resolve) => { finish = resolve; });
      busy = false;
      publish({ type: "state", patch: { isStreaming: false } });
    }),
    undo: vi.fn(async () => ({ message: "restored" })),
    redo: vi.fn(async () => ({ message: "restored" })),
    rejectReviewFile: vi.fn(async (_path: string) => ({ available: false, baseCommit: null, headCommit: null, files: [], patch: "", truncated: false, message: null })),
    deleteSession: vi.fn(async (_path: string) => undefined),
    stop: vi.fn(async () => { finish(); await Promise.resolve(); }),
    dispose: vi.fn(async () => { finish(); await Promise.resolve(); }),
  };
  return { service: service as unknown as AgentService, mock: service, publish };
}

async function fixture(configureChild?: (child: ReturnType<typeof serviceFixture>) => void) {
  const root = serviceFixture("root", "/project");
  const children: ReturnType<typeof serviceFixture>[] = [];
  const workspaces = { current: [] as Array<{ cwd: string }>, configure: vi.fn(async () => undefined) };
  const owner = new ProjectSessionService({ root: root.service, workspaces: workspaces as unknown as SessionWorkspaceRegistry,
    createService: () => { const child = serviceFixture(`child-${children.length + 1}`, ""); configureChild?.(child); children.push(child); return child.service; } });
  await owner.initialize();
  return { owner, root, children, workspaces };
}

describe("parallel project sessions", () => {
  it("keeps unsaved session timestamps stable and prefers persisted file metadata", async () => {
    const createdAt = 1_800_000_000_000;
    const clock = vi.spyOn(Date, "now").mockReturnValue(createdAt);
    try {
      const test = await fixture();
      const blank = { ...await test.root.service.getSnapshot(), sessions: [] };
      test.root.mock.getSnapshot.mockResolvedValue(blank);
      test.root.publish({ type: "snapshot", snapshot: blank });
      const first = (await test.owner.getSnapshot()).sessions[0]!;
      expect(first).toMatchObject({ id: "root", title: "New conversation", modifiedAt: createdAt, byteSize: null, messageCount: 0 });
      clock.mockReturnValue(createdAt + 60_000);
      expect((await test.owner.getSnapshot()).sessions[0]).toEqual(first);

      const next = { ...blank, sessionId: "next", sessionFile: "/project/next.jsonl" };
      test.root.mock.getSnapshot.mockResolvedValue(next);
      test.root.publish({ type: "snapshot", snapshot: next });
      expect((await test.owner.getSnapshot()).sessions[0]).toMatchObject({ id: "next", modifiedAt: createdAt + 60_000 });
      const saved = { path: next.sessionFile, id: "next", title: "Saved", messageCount: 1, modifiedAt: createdAt + 90_000, byteSize: 128 };
      test.root.mock.getSnapshot.mockResolvedValue({ ...next, sessions: [saved] });
      expect((await test.owner.getSnapshot()).sessions[0]).toMatchObject(saved);
      await test.owner.dispose();
    } finally { clock.mockRestore(); }
  });

  it("counts live messages before a conversation file appears in the inventory", async () => {
    const test = await fixture();
    const snapshot = { ...await test.root.service.getSnapshot(), sessions: [], timeline: [
      { kind: "message" as const, id: "first-user", message: { id: "first-user", role: "user" as const, text: "First task", timestamp: Date.now() } },
    ] };
    test.root.mock.getSnapshot.mockResolvedValue(snapshot);
    expect((await test.owner.getSnapshot()).sessions[0]).toMatchObject({ title: "First task", messageCount: 1, byteSize: null, runStatus: "completed" });
    await test.owner.dispose();
  });

  it("keeps background runs alive, filters their events and stops only the registered target", async () => {
    const test = await fixture();
    const events: AgentEvent[] = [];
    test.owner.subscribe((event) => events.push(event));
    const rootRun = test.owner.prompt("root task");
    const childSnapshot = await test.owner.newSession();
    expect(childSnapshot).toMatchObject({ projectPath: "/project", workspacePath: "/project", parallel: { runningCount: 1 } });
    expect(childSnapshot.sessionFile).not.toBe("/project/root.jsonl");
    expect(test.children[0]!.mock.openProject).toHaveBeenCalledWith("/project", undefined, true);
    const childRun = test.owner.prompt("child task");
    const sharedSessions = [...(await test.root.service.getSnapshot()).sessions, ...(await test.children[0]!.service.getSnapshot()).sessions];
    test.root.publish({ type: "sessions", sessions: sharedSessions });
    test.children[0]!.publish({ type: "sessions", sessions: sharedSessions });
    expect((await test.owner.getSnapshot()).sessions.filter((session) => session.runStatus === "running")).toHaveLength(2);
    events.length = 0;
    test.root.publish({ type: "notice", message: "background only" });
    test.root.publish({ type: "extension-ui", request: { id: "root-question", method: "input", title: "Root input" } });
    expect(events.some((event) => event.type === "notice" || event.type === "extension-ui")).toBe(false);
    const accepted = { kind: "message" as const, id: "root-user", message: { id: "root-user", role: "user" as const, text: "root task", timestamp: 1 } };
    test.root.publish({ type: "timeline-upsert", item: accepted });
    expect(events).toContainEqual({ type: "timeline-upsert", item: accepted, sessionId: "root" });
    test.root.publish({ type: "timeline-upsert", item: { ...accepted, id: "root-answer", message: { ...accepted.message, id: "root-answer", role: "assistant" } } });
    expect(events.some((event) => event.type === "timeline-upsert" && event.item.id === "root-answer")).toBe(false);
    expect((await test.owner.getSnapshot()).sessions.find((session) => session.id === "root")?.runStatus).toBe("waiting");
    await test.owner.stopSession("/project/root.jsonl");
    await rootRun;
    expect(test.children[0]!.mock.stop).not.toHaveBeenCalled();
    expect(test.children[0]!.service.runtimeBusy).toBe(true);
    await test.owner.switchSession("/project/root.jsonl");
    expect(test.owner.activeService).toBe(test.root.service);
    await test.owner.stopSession("/project/child-1.jsonl");
    await childRun;
    await expect(test.owner.stopSession("/outside/session.jsonl")).rejects.toThrow("登记");
    await test.owner.dispose();
  });

  it("routes startup questions to the opening runtime without waiting for its completed snapshot", async () => {
    let release!: () => void;
    let questionShown!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const shown = new Promise<void>((resolve) => { questionShown = resolve; });
    const test = await fixture((child) => {
      const open = child.mock.openProject.getMockImplementation()!;
      child.mock.openProject.mockImplementation(async (path, sessionPath) => {
        const snapshot = await open(path, sessionPath);
        child.publish({ type: "extension-ui", request: { id: "startup", method: "input", title: "Startup input" } });
        questionShown();
        await gate;
        return snapshot;
      });
    });
    const events: AgentEvent[] = [];
    test.owner.subscribe((event) => events.push(event));
    const creating = test.owner.newSession();
    await shown;
    expect(events).toContainEqual({ type: "extension-ui", request: { id: "startup", method: "input", title: "Startup input" } });
    expect(test.owner.activeService).toBe(test.children[0]!.service);
    await expect(test.owner.prompt("wait")).rejects.toThrow("切换完成");
    release();
    expect((await creating).parallel?.canCreate).toBe(true);
    await test.owner.dispose();
  });

  it("rejects a third run while allowing an idle third session to be viewed", async () => {
    const test = await fixture();
    const rootRun = test.owner.prompt("root");
    await test.owner.newSession();
    const childRun = test.owner.prompt("child");
    await test.owner.newSession();
    await expect(test.owner.prompt("third")).rejects.toThrow("2 个会话");
    expect(test.children[1]!.mock.prompt).not.toHaveBeenCalled();
    await test.owner.stopSession("/project/root.jsonl");
    await rootRun;
    const thirdRun = test.owner.prompt("third allowed");
    await test.owner.stopSession("/project/child-2.jsonl");
    await thirdRun;
    await test.owner.stopSession("/project/child-1.jsonl");
    await childRun;
    await test.owner.dispose();
  });

  it("rejects unowned session paths and serializes transitions", async () => {
    let finish!: () => void;
    const gate = new Promise<void>((resolve) => { finish = resolve; });
    const test = await fixture((child) => {
      const open = child.mock.openProject.getMockImplementation()!;
      child.mock.openProject.mockImplementation(async (path, sessionPath, startNewSession) => {
        await gate;
        return open(path, sessionPath, startNewSession);
      });
    });
    await expect(test.owner.switchSession("/outside/session.jsonl")).rejects.toThrow("active project");
    const creating = test.owner.newSession();
    await expect(test.owner.newSession()).rejects.toThrow("正在切换");
    await expect(test.owner.prompt("wrong target")).rejects.toThrow("切换完成");
    finish();
    await creating;
    await test.owner.dispose();
  });

  it("keeps failed cleanup registered for retry and delays root disposal", async () => {
    const test = await fixture();
    await test.owner.newSession();
    test.children[0]!.mock.dispose.mockRejectedValueOnce(new Error("process stop failed"));
    await expect(test.owner.dispose()).rejects.toThrow("清理失败");
    expect(test.root.mock.dispose).not.toHaveBeenCalled();
    await test.owner.dispose();
    expect(test.children[0]!.mock.dispose).toHaveBeenCalledTimes(2);
    expect(test.root.mock.dispose).toHaveBeenCalledOnce();
  });

  it("reuses recently viewed idle sessions without rebuilding or duplicating snapshots", async () => {
    const test = await fixture();
    const first = await test.owner.newSession();
    await test.owner.newSession();
    test.children[0]!.mock.getSnapshot.mockClear();
    await test.owner.switchSession(first.sessionFile!);
    expect(test.children).toHaveLength(2);
    expect(test.children[0]!.mock.openProject).toHaveBeenCalledOnce();
    expect(test.children[0]!.mock.getSnapshot).toHaveBeenCalledOnce();
    expect(test.children[0]!.mock.dispose).not.toHaveBeenCalled();
    await test.owner.newSession();
    expect(test.children[1]!.mock.dispose).toHaveBeenCalledOnce();
    expect(test.children[0]!.mock.dispose).not.toHaveBeenCalled();
    await test.owner.dispose();
  });

  it("reopens an evicted idle session in the selected project directory", async () => {
    const test = await fixture();
    const first = await test.owner.newSession();
    await test.owner.newSession();
    await test.owner.newSession();
    expect(test.children[0]!.mock.dispose).toHaveBeenCalledOnce();
    const restored = await test.owner.switchSession(first.sessionFile!);
    expect(test.children[3]!.mock.openProject).toHaveBeenCalledWith("/project", first.sessionFile);
    expect(restored.workspacePath).toBe("/project");
    await test.owner.dispose();
  });

  it("allows historical sessions to run beside a task in the same original directory", async () => {
    const test = await fixture();
    const snapshot = await test.root.service.getSnapshot();
    const history = { path: "/project/history.jsonl", id: "history", title: "History", messageCount: 1, modifiedAt: 1 };
    test.root.publish({ type: "sessions", sessions: [...snapshot.sessions, history] });
    const running = test.owner.prompt("root task");
    await test.owner.switchSession(history.path);
    const historyRun = test.owner.prompt("shared task");
    expect(test.children[0]!.mock.prompt).toHaveBeenCalledOnce();
    expect((await test.owner.getSnapshot()).parallel?.runningCount).toBe(2);
    await test.owner.stopSession(history.path);
    await historyRun;
    expect(test.root.service.runtimeBusy).toBe(true);
    await test.owner.stopSession("/project/root.jsonl");
    await running;
    await test.owner.dispose();
  });

  it("resumes legacy worktree conversations in the selected project and preserves discovery for deletion", async () => {
    const test = await fixture();
    const legacy = { path: "/legacy/conversation.jsonl", id: "legacy", title: "Legacy", messageCount: 1, modifiedAt: 1 };
    test.workspaces.current = [{ cwd: "/legacy" }];
    vi.mocked(listSessionSummaries).mockResolvedValueOnce([legacy]);
    await test.owner.openProject("/project");
    const restored = await test.owner.switchSession(legacy.path);
    expect(test.children[0]!.mock.openProject).toHaveBeenCalledWith("/project", legacy.path);
    expect(restored.workspacePath).toBe("/project");
    await test.owner.newSession();
    await test.owner.newSession();
    expect(test.children[0]!.mock.dispose).toHaveBeenCalledOnce();
    await test.owner.deleteSession(legacy.path);
    expect(test.children[3]!.mock.openProject).toHaveBeenCalledWith("/legacy");
    expect(test.children[3]!.mock.deleteSession).toHaveBeenCalledWith(legacy.path);
    expect((await test.owner.getSnapshot()).sessions.some((session) => session.path === legacy.path)).toBe(false);
    await test.owner.dispose();
  });

  it.each(["undo", "redo", "rejectReviewFile"] as const)("blocks %s in an idle foreground while a background task owns the shared directory", async (operation) => {
    const test = await fixture();
    const running = test.owner.prompt("root task");
    await test.owner.newSession();
    const restore = () => operation === "rejectReviewFile" ? test.owner.rejectReviewFile("source.ts") : test.owner[operation]();
    await expect(restore()).rejects.toThrow("所有对话");
    expect(test.children[0]!.mock[operation]).not.toHaveBeenCalled();
    await test.owner.stopSession("/project/root.jsonl");
    await running;
    await restore();
    expect(test.children[0]!.mock[operation]).toHaveBeenCalledOnce();
    await test.owner.dispose();
  });

  it("waits for workspace restoration before switching, running or disposing", async () => {
    const test = await fixture();
    let release!: (result: { message: string }) => void;
    test.root.mock.undo.mockImplementation(() => new Promise((resolve) => { release = resolve; }));
    const restoring = test.owner.undo();
    expect((await test.owner.getSnapshot()).parallel?.canCreate).toBe(false);
    await expect(test.owner.newSession()).rejects.toThrow("文件恢复完成");
    await expect(test.owner.prompt("wait")).rejects.toThrow("文件恢复完成");
    const disposing = test.owner.dispose();
    expect(test.root.mock.dispose).not.toHaveBeenCalled();
    release({ message: "restored" });
    await restoring;
    await disposing;
    expect(test.root.mock.dispose).toHaveBeenCalledOnce();
  });

  it("selects a surviving runtime when another child prevents shutdown", async () => {
    const test = await fixture();
    await test.owner.newSession();
    const running = test.owner.prompt("retained task");
    await test.owner.newSession();
    test.children[0]!.mock.dispose.mockRejectedValueOnce(new Error("cleanup failed"));
    await expect(test.owner.dispose()).rejects.toThrow("清理失败");
    expect(test.children[1]!.mock.dispose).toHaveBeenCalledOnce();
    expect(test.owner.activeService).toBe(test.root.service);
    expect(test.root.mock.dispose).not.toHaveBeenCalled();
    await test.owner.dispose();
    await running;
  });

  it("creates additional shared-directory sessions without requiring a Git registry", async () => {
    const test = await fixture();
    const running = test.owner.prompt("task");
    expect((await test.owner.getSnapshot()).parallel).toMatchObject({ canCreate: true, reason: null });
    await test.owner.newSession();
    expect(test.children[0]!.mock.openProject).toHaveBeenCalledWith("/project", undefined, true);
    expect(test.root.mock.newSession).not.toHaveBeenCalled();
    await test.owner.stopSession("/project/root.jsonl");
    await running;
    await test.owner.dispose();
  });
});
