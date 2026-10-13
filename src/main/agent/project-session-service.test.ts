import { describe, expect, it, vi } from "vitest";
import type { AgentEvent, AgentSnapshot } from "../../shared/contracts.js";
import { AgentService } from "./agent-service.js";
import { ProjectSessionService } from "./project-session-service.js";
import { EMPTY_AGENT_SNAPSHOT } from "./empty-agent-snapshot.js";
import { SessionWorkspaceRegistry } from "./session-workspaces.js";

vi.mock("./session-summaries.js", () => ({ listSessionSummaries: async () => [] }));

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
    openProject: vi.fn(async (path: string, sessionPath?: string) => {
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
    stop: vi.fn(async () => { finish(); await Promise.resolve(); }),
    dispose: vi.fn(async () => { finish(); await Promise.resolve(); }),
  };
  return { service: service as unknown as AgentService, mock: service, publish };
}

async function fixture(configureChild?: (child: ReturnType<typeof serviceFixture>) => void) {
  const root = serviceFixture("root", "/project");
  const children: ReturnType<typeof serviceFixture>[] = [];
  const workspaces = { canCreate: true, current: [], configure: vi.fn(async () => undefined), create: vi.fn(async () => `/worktree/${children.length + 1}`) };
  const owner = new ProjectSessionService({ root: root.service, workspaces: workspaces as unknown as SessionWorkspaceRegistry,
    createService: () => { const child = serviceFixture(`child-${children.length + 1}`, ""); configureChild?.(child); children.push(child); return child.service; } });
  await owner.initialize();
  return { owner, root, children, workspaces };
}

describe("parallel project sessions", () => {
  it("keeps background runs alive, filters their events and stops only the registered target", async () => {
    const test = await fixture();
    const events: AgentEvent[] = [];
    test.owner.subscribe((event) => events.push(event));
    const rootRun = test.owner.prompt("root task");
    const childSnapshot = await test.owner.newSession();
    expect(childSnapshot).toMatchObject({ projectPath: "/project", workspacePath: "/worktree/1", parallel: { runningCount: 1 } });
    const childRun = test.owner.prompt("child task");
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
    await test.owner.stopSession("/worktree/1/child-1.jsonl");
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
    await test.owner.stopSession("/worktree/2/child-2.jsonl");
    await thirdRun;
    await test.owner.stopSession("/worktree/1/child-1.jsonl");
    await childRun;
    await test.owner.dispose();
  });

  it("rejects unowned session paths and serializes transitions", async () => {
    const test = await fixture();
    await expect(test.owner.switchSession("/outside/session.jsonl")).rejects.toThrow("active project");
    let finish!: (path: string) => void;
    test.workspaces.create.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    const creating = test.owner.newSession();
    await expect(test.owner.newSession()).rejects.toThrow("正在切换");
    await expect(test.owner.prompt("wrong target")).rejects.toThrow("切换完成");
    finish("/worktree/1");
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

  it("reopens an idle session in its registered worktree rather than the original project", async () => {
    const test = await fixture();
    const first = await test.owner.newSession();
    await test.owner.newSession();
    expect(test.children[0]!.mock.dispose).toHaveBeenCalledOnce();
    const restored = await test.owner.switchSession(first.sessionFile!);
    expect(test.children[2]!.mock.openProject).toHaveBeenCalledWith("/worktree/1", first.sessionFile);
    expect(restored.workspacePath).toBe("/worktree/1");
    await test.owner.dispose();
  });

  it("prevents historical sessions from executing beside a task in their shared original directory", async () => {
    const test = await fixture();
    const snapshot = await test.root.service.getSnapshot();
    const history = { path: "/project/history.jsonl", id: "history", title: "History", messageCount: 1, modifiedAt: 1 };
    test.root.publish({ type: "sessions", sessions: [...snapshot.sessions, history] });
    const running = test.owner.prompt("root task");
    await test.owner.switchSession(history.path);
    await expect(test.owner.prompt("unsafe shared task")).rejects.toThrow("共享目录");
    expect(test.children[0]!.mock.prompt).not.toHaveBeenCalled();
    await test.owner.stopSession("/project/root.jsonl");
    await running;
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

  it("preserves single-session behavior for non-Git projects", async () => {
    const test = await fixture();
    test.workspaces.canCreate = false;
    const running = test.owner.prompt("task");
    await expect(test.owner.newSession()).rejects.toThrow("非 Git 项目");
    await test.owner.stopSession("/project/root.jsonl");
    await running;
    await test.owner.newSession();
    expect(test.root.mock.newSession).toHaveBeenCalledOnce();
    expect(test.workspaces.create).not.toHaveBeenCalled();
    await test.owner.dispose();
  });
});
