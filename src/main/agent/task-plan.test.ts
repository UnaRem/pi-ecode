import type { ExtensionAPI, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import type { TaskPlanItem } from "../../shared/contracts.js";
import { TaskPlanService } from "./task-plan.js";

type Handler = (event: { streamingBehavior?: "steer" }, context: ExtensionContext) => Promise<void> | void;
type PlanTool = {
  execute: (
    id: string,
    params: { title: string; items: TaskPlanItem[] },
    signal: AbortSignal,
  ) => Promise<{ details: unknown }>;
};

function harness(service: TaskPlanService, branch: SessionEntry[] = []) {
  const handlers = new Map<string, Handler>();
  const appended: Array<{ customType: string; data: unknown }> = [];
  let tool: PlanTool | undefined;
  const pi = {
    on: (name: string, handler: Handler) => handlers.set(name, handler),
    appendEntry: (customType: string, data: unknown) => {
      appended.push({ customType, data });
      return "entry";
    },
    registerTool: (definition: PlanTool) => { tool = definition; },
  } as unknown as ExtensionAPI;
  const extension = service.asExtension();
  void (typeof extension === "function" ? extension(pi) : extension.factory(pi));
  const context = { sessionManager: { getBranch: () => branch } } as unknown as ExtensionContext;
  return { handlers, appended, context, getTool: () => {
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

  it("restores the latest plan from the active session branch", async () => {
    const plan = { title: "Restored", items: [{ id: "verify", text: "Run tests", status: "in_progress" as const }], updatedAt: 5 };
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

    expect(service.current).toEqual(plan);
  });
});
