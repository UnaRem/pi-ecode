import type { ExtensionAPI, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import type { TaskPlanItem } from "../../shared/contracts.js";
import { TaskPlanService } from "./task-plan.js";

type Handler = (event: Record<string, unknown>, context: ExtensionContext) => unknown;
type PlanTool = {
  execute: (
    id: string,
    params: { title: string; items: Array<TaskPlanItem & { completionCriteria?: string }> },
    signal: AbortSignal,
  ) => Promise<{ details: unknown }>;
};

type ProgressTool = {
  execute: (id: string, report: {
    planUpdatedAt: number; id: string; outcome: "in_progress" | "completed" | "blocked"; evidence: string; nextId?: string | null;
  }, signal: AbortSignal) => Promise<{ details: unknown }>;
};

function harness(service: TaskPlanService, branch: SessionEntry[] = []) {
  const appendEntry = vi.fn((customType: string, details: unknown) => {
    appended.push({ customType, data: details });
    return "entry";
  });
  const handlers = new Map<string, Handler>();
  const appended: Array<{ customType: string; data: unknown }> = [];
  let tool: PlanTool | undefined;
  let progressTool: ProgressTool | undefined;
  const pi = {
    on: (name: string, handler: Handler) => handlers.set(name, handler),
    appendEntry,
    registerTool: (definition: (PlanTool | ProgressTool) & { name: string }) => {
      if (definition.name === "task_plan") tool = definition as PlanTool;
      else progressTool = definition as ProgressTool;
    },
  } as unknown as ExtensionAPI;
  const extension = service.asExtension();
  void (typeof extension === "function" ? extension(pi) : extension.factory(pi));
  const notify = vi.fn();
  const abort = vi.fn();
  const context = { sessionManager: { getBranch: () => branch }, ui: { notify }, abort } as unknown as ExtensionContext;
  return { handlers, appended, appendEntry, context, notify, abort, getProgressTool: () => {
    if (!progressTool) throw new Error("Progress tool was not registered.");
    return progressTool;
  }, getTool: () => {
    if (!tool) throw new Error("Task plan tool was not registered.");
    return tool;
  } };
}

describe("TaskPlanService", () => {
  it("clears a plan for a new task but preserves it for steering", async () => {
    const changes = vi.fn();
    const service = new TaskPlanService(changes);
    const test = harness(service);

    await test.handlers.get("input")?.({}, test.context);
    expect(test.appended).toEqual([{ customType: "pi-ecode.task-plan-state", data: { version: 1, plan: null } }]);
    expect(changes).toHaveBeenLastCalledWith(null);

    await test.handlers.get("input")?.({ streamingBehavior: "steer" }, test.context);
    expect(test.appended).toHaveLength(1);
  });

  it("stores complete plan state and accepts truthful progress updates", async () => {
    const service = new TaskPlanService(vi.fn());
    const test = harness(service);
    const tool = test.getTool();
    const initial = await tool.execute("call-1", {
      title: "Implement feature",
      items: [{ id: "inspect", text: "Inspect current code", status: "pending" }],
    }, new AbortController().signal);

    expect(service.current).toMatchObject({ title: "Implement feature", items: [{ id: "inspect", status: "pending" }] });
    expect(initial.details).toMatchObject({ kind: "pi-ecode.task-plan", version: 1 });
    await tool.execute("call-2", {
      title: "Implement feature",
      items: [{ id: "inspect", text: "Inspect current code", status: "completed" }],
    }, new AbortController().signal);
    expect(service.current?.items).toEqual([{ id: "inspect", text: "Inspect current code", status: "completed" }]);
  });

  it("removes leading Markdown checkbox markers from task text", async () => {
    const service = new TaskPlanService(vi.fn());
    const tool = harness(service).getTool();

    await tool.execute("call-checkboxes", {
      title: "Normalize labels",
      items: [
        { id: "dash", text: "- [x] Finished", status: "completed" },
        { id: "asterisk", text: "* [X] Also finished", status: "completed" },
        { id: "plus", text: "+ [ ] Waiting", status: "pending" },
        { id: "bare", text: "[ ] Bare marker", status: "pending" },
        { id: "middle", text: "Explain [x] syntax", status: "pending" },
      ],
    }, new AbortController().signal);

    expect(service.current?.items.map((item) => item.text)).toEqual([
      "Finished",
      "Also finished",
      "Waiting",
      "Bare marker",
      "Explain [x] syntax",
    ]);
  });

  it("persists evidence-based progress and atomically starts the next task", async () => {
    const changes = vi.fn();
    const service = new TaskPlanService(changes);
    const test = harness(service);
    await test.getTool().execute("plan", { title: "Investigate", items: [
      { id: "reason", text: "Identify cause", completionCriteria: "Explain the failing path", status: "in_progress" },
      { id: "verify", text: "Verify result", completionCriteria: "Regression passes", status: "pending" },
    ] }, new AbortController().signal);
    const revision = service.current!.updatedAt;
    const report = { planUpdatedAt: revision, id: "reason", outcome: "completed" as const,
      evidence: "The event is forwarded without updating the slot cache.", nextId: "verify" };
    const result = await test.getProgressTool().execute("progress", report, new AbortController().signal);
    expect(service.current?.items.map((item) => item.status)).toEqual(["completed", "in_progress"]);
    expect(service.current!.updatedAt).toBeGreaterThan(revision);
    expect(test.appended.at(-1)).toMatchObject({ customType: "pi-ecode.task-plan-state", data: { plan: service.current } });
    expect(result.details).toMatchObject({ report, plan: service.current });
    expect(changes).toHaveBeenLastCalledWith(service.current);
    await expect(test.getProgressTool().execute("stale", report, new AbortController().signal)).rejects.toThrow("过期");
  });

  it("retains unfinished and blocked tasks and rejects invalid reports without publishing", async () => {
    const changes = vi.fn();
    const service = new TaskPlanService(changes);
    const test = harness(service);
    await test.getTool().execute("plan", { title: "Review", items: [
      { id: "review", text: "Review behavior", status: "in_progress" },
    ] }, new AbortController().signal);
    const base = { id: "review", outcome: "blocked" as const, evidence: "Waiting for validation to finish" };
    await test.getProgressTool().execute("blocked", { ...base, planUpdatedAt: service.current!.updatedAt }, new AbortController().signal);
    expect(service.current?.items[0]?.status).toBe("in_progress");
    const before = service.current;
    const report = { ...base, planUpdatedAt: before!.updatedAt };
    changes.mockClear();
    for (const invalid of [{ ...report, id: "unknown" }, { ...report, evidence: " " },
      { ...report, outcome: "completed" as const, nextId: "review" },
      { ...report, outcome: "completed" as const, nextId: "unknown" }]) {
      await expect(test.getProgressTool().execute("invalid", invalid, new AbortController().signal)).rejects.toThrow();
    }
    const cancelled = new AbortController();
    cancelled.abort();
    await expect(test.getProgressTool().execute("cancelled", report, cancelled.signal)).rejects.toThrow();
    expect(service.current).toEqual(before);
    expect(changes).not.toHaveBeenCalled();
  });

  it.each(["in_progress", "blocked"] as const)("ignores nextId for %s and releases the checkpoint without starting a sibling", async (outcome) => {
    const service = new TaskPlanService(vi.fn());
    const test = harness(service);
    await test.getTool().execute("plan", { title: "Review", items: [
      { id: "review", text: "Review behavior", status: "in_progress" },
      { id: "verify", text: "Verify behavior", status: "pending" },
    ] }, new AbortController().signal);
    for (const nextId of ["verify", "unknown", "review", null, undefined]) {
      test.handlers.get("turn_end")?.({ outcome: "completed", toolResults: [{ toolName: "read", durationMs: 1 }] }, test.context);
      expect(test.handlers.get("tool_call")?.({ toolName: "read" }, test.context)).toMatchObject({ block: true });
      const result = await test.getProgressTool().execute("progress", { planUpdatedAt: service.current!.updatedAt,
        id: "review", outcome, evidence: "More work is needed", ...(nextId !== undefined ? { nextId } : {}) }, new AbortController().signal);
      expect(result.details).toMatchObject({ report: { outcome, nextId: null } });
      expect(service.current?.items.map((item) => item.status)).toEqual(["in_progress", "pending"]);
      expect(test.handlers.get("tool_call")?.({ toolName: "read" }, test.context)).toBeUndefined();
    }
    expect(test.abort).not.toHaveBeenCalled();
  });

  it("accepts null nextId when completing the final task", async () => {
    const service = new TaskPlanService(vi.fn());
    const test = harness(service);
    await test.getTool().execute("plan", { title: "Review", items: [
      { id: "review", text: "Review behavior", status: "in_progress" },
    ] }, new AbortController().signal);
    const result = await test.getProgressTool().execute("progress", { planUpdatedAt: service.current!.updatedAt,
      id: "review", outcome: "completed", evidence: "Review finished", nextId: null }, new AbortController().signal);
    expect(result.details).toMatchObject({ report: { nextId: null } });
    expect(service.current?.items[0]?.status).toBe("completed");
    expect(test.appended.at(-1)).toMatchObject({ data: { plan: service.current } });
  });

  it("triggers a checkpoint for reasoning, blocks more work and stops after one failed repair", async () => {
    const service = new TaskPlanService(vi.fn());
    const test = harness(service);
    await test.getTool().execute("plan", { title: "Reason", items: [
      { id: "reason", text: "Explain cause", status: "in_progress" },
    ] }, new AbortController().signal);
    const boundary = { outcome: "completed", toolResults: [] };
    expect(test.handlers.get("turn_end")?.(boundary, test.context)).toMatchObject({ continue: true, entries: [
      { type: "custom_message", customType: "pi-ecode.task-checkpoint", display: false },
    ] });
    test.handlers.get("turn_start")?.({}, test.context);
    expect(test.handlers.get("tool_call")?.({ toolName: "read" }, test.context)).toMatchObject({ block: true });
    expect(test.handlers.get("tool_call")?.({ toolName: "task_progress" }, test.context)).toBeUndefined();
    test.handlers.get("turn_end")?.(boundary, test.context);
    expect(test.abort).toHaveBeenCalledTimes(1);
    expect(test.notify).toHaveBeenCalledWith(expect.stringContaining("待办进度同步失败"), "error");
    expect(service.current?.items[0]?.status).toBe("in_progress");
  });

  it("does not repair after stop, model errors or a successful confirmation request", async () => {
    const service = new TaskPlanService(vi.fn());
    const test = harness(service);
    await test.getTool().execute("plan", { title: "Reason", items: [
      { id: "reason", text: "Explain cause", status: "in_progress" },
    ] }, new AbortController().signal);
    for (const outcome of ["aborted", "error"]) {
      expect(test.handlers.get("turn_end")?.({ outcome, toolResults: [] }, test.context)).toBeUndefined();
    }
    const confirmation = { toolName: "request_confirmation", toolCallId: "confirmation", isError: false,
      details: { kind: "pi-ecode.confirmation", version: 1, status: "pending", requestId: "confirmation" } };
    expect(test.handlers.get("turn_end")?.({ outcome: "completed", toolResults: [confirmation] }, test.context)).toBeUndefined();
    expect(test.handlers.get("agent_before_settle")?.({ outcome: "completed" }, test.context)).toBeUndefined();
    expect(test.abort).not.toHaveBeenCalled();
  });

  it("clears checkpoint guidance for a new task while preserving it for steering", async () => {
    const service = new TaskPlanService(vi.fn());
    const test = harness(service);
    await test.getTool().execute("plan", { title: "Reason", items: [
      { id: "reason", text: "Explain cause", status: "in_progress" },
    ] }, new AbortController().signal);
    test.handlers.get("turn_end")?.({ outcome: "completed", toolResults: [] }, test.context);
    test.handlers.get("input")?.({ streamingBehavior: "steer" }, test.context);
    expect(test.handlers.get("context")?.({ messages: [] }, test.context)).toMatchObject({ messages: [
      { content: expect.stringContaining("A host checkpoint is pending") },
    ] });
    test.handlers.get("input")?.({}, test.context);
    expect(test.handlers.get("context")?.({ messages: [] }, test.context)).toBeUndefined();
    expect(test.handlers.get("tool_call")?.({ toolName: "read" }, test.context)).toBeUndefined();
  });

  it("keeps the checkpoint and visible state intact when persistence fails", async () => {
    const changes = vi.fn();
    const service = new TaskPlanService(changes);
    const test = harness(service);
    await test.getTool().execute("plan", { title: "Investigate", items: [
      { id: "reason", text: "Identify cause", status: "in_progress" },
    ] }, new AbortController().signal);
    test.handlers.get("turn_end")?.({ outcome: "completed", toolResults: [] }, test.context);
    const before = service.current;
    changes.mockClear();
    test.appendEntry.mockImplementationOnce(() => { throw new Error("Disk write failed"); });
    await expect(test.getProgressTool().execute("progress", { planUpdatedAt: before!.updatedAt, id: "reason",
      outcome: "completed", evidence: "The cause was found" }, new AbortController().signal)).rejects.toThrow("Disk write failed");
    expect(service.current).toEqual(before);
    expect(changes).not.toHaveBeenCalled();
    expect(test.handlers.get("tool_call")?.({ toolName: "read" }, test.context)).toMatchObject({ block: true });
  });

  it("restores progress criteria and keeps the resumed gate closed until a valid report", async () => {
    const plan = { title: "Resumed", items: [{ id: "research", text: "Research cause",
      completionCriteria: "Identify the exact failing path", status: "in_progress" as const }], updatedAt: 42 };
    const branch: SessionEntry[] = [{ type: "custom", customType: "pi-ecode.task-plan-state", data: { version: 1, plan },
      id: "plan-state", parentId: null, timestamp: "now" }];
    const service = new TaskPlanService(vi.fn());
    const test = harness(service, branch);
    test.handlers.get("session_start")?.({}, test.context);
    expect(service.current).toEqual(plan);
    expect(test.handlers.get("tool_call")?.({ toolName: "read" }, test.context)).toMatchObject({ block: true });
    await test.getProgressTool().execute("progress", { planUpdatedAt: 42, id: "research",
      outcome: "in_progress", evidence: "Need to inspect one more call site" }, new AbortController().signal);
    expect(test.handlers.get("tool_call")?.({ toolName: "read" }, test.context)).toBeUndefined();
    expect(service.current?.items[0]?.completionCriteria).toBe(plan.items[0]?.completionCriteria);
  });

  it("restores the latest plan from the active session branch", async () => {
    const plan = { title: "Restored", items: [{ id: "verify", text: "- [x] Run tests", status: "in_progress" as const }], updatedAt: 5 };
    const branch = [{
      type: "message",
      id: "result",
      parentId: null,
      timestamp: new Date().toISOString(),
      message: {
        role: "toolResult",
        toolCallId: "call-plan",
        toolName: "task_plan",
        content: [{ type: "text", text: "updated" }],
        details: { kind: "pi-ecode.task-plan", version: 1, plan },
        isError: false,
        timestamp: 5,
      },
    }] as SessionEntry[];
    const service = new TaskPlanService(vi.fn());
    const test = harness(service, branch);

    await test.handlers.get("session_start")?.({}, test.context);

    expect(service.current).toEqual({
      ...plan,
      items: [{ id: "verify", text: "Run tests", status: "in_progress" }],
    });
  });
});
