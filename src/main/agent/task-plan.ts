import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext, InlineExtension, SessionEntry } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { TaskPlan, TaskPlanItem } from "../../shared/contracts.js";

const PLAN_ENTRY = "pi-ecode.task-plan-state";
const PLAN_DETAILS_KIND = "pi-ecode.task-plan";
const MAX_PLAN_ITEMS = 12;

interface TaskPlanDetails {
  kind: typeof PLAN_DETAILS_KIND;
  version: 1;
  plan: TaskPlan;
}

interface PlanStateEntry {
  version: 1;
  plan: TaskPlan | null;
}

const TaskPlanParameters = Type.Object({
  title: Type.String({ minLength: 1, maxLength: 120, description: "Short title for the current task" }),
  items: Type.Array(Type.Object({
    id: Type.String({ minLength: 1, maxLength: 40, description: "Stable short identifier" }),
    text: Type.String({ minLength: 1, maxLength: 200, description: "Concrete outcome for this step" }),
    status: StringEnum(["pending", "in_progress", "completed"] as const),
  }), { minItems: 1, maxItems: MAX_PLAN_ITEMS }),
});

function clonePlan(plan: TaskPlan | null): TaskPlan | null {
  return plan ? structuredClone(plan) : null;
}

function planFromDetails(details: unknown): TaskPlan | null {
  if (!details || typeof details !== "object") return null;
  const candidate = details as Partial<TaskPlanDetails>;
  if (candidate.kind !== PLAN_DETAILS_KIND || candidate.version !== 1 || !candidate.plan) return null;
  return clonePlan(candidate.plan);
}

function planFromEntry(entry: SessionEntry): TaskPlan | null | undefined {
  if (entry.type === "custom" && entry.customType === PLAN_ENTRY) {
    const state = entry.data as Partial<PlanStateEntry> | undefined;
    return state?.version === 1 ? clonePlan(state.plan ?? null) : undefined;
  }
  if (entry.type !== "message" || entry.message.role !== "toolResult" || entry.message.toolName !== "task_plan") {
    return undefined;
  }
  return planFromDetails(entry.message.details) ?? undefined;
}

function validatePlan(title: string, items: TaskPlanItem[], previous: TaskPlan | null): TaskPlan {
  const normalizedTitle = title.trim();
  if (!normalizedTitle) throw new Error("Task plan title cannot be empty.");
  const normalizedItems = items.map((item) => ({ ...item, id: item.id.trim(), text: item.text.trim() }));
  if (normalizedItems.some((item) => !item.id || !item.text)) throw new Error("Task plan item IDs and text cannot be empty.");
  if (new Set(normalizedItems.map((item) => item.id)).size !== normalizedItems.length) {
    throw new Error("Task plan item IDs must be unique.");
  }
  if (normalizedItems.filter((item) => item.status === "in_progress").length > 1) {
    throw new Error("Only one task plan item can be in progress.");
  }
  const previousById = new Map(previous?.items.map((item) => [item.id, item]));
  for (const item of normalizedItems) {
    if (previousById.get(item.id)?.status === "pending" && item.status === "completed") {
      throw new Error(`Task plan item ${item.id} must move through in_progress before completed.`);
    }
  }
  return { title: normalizedTitle, items: normalizedItems, updatedAt: Date.now() };
}

export class TaskPlanService {
  private plan: TaskPlan | null = null;

  constructor(private readonly onChange: (plan: TaskPlan | null) => void) {}

  get current(): TaskPlan | null {
    return clonePlan(this.plan);
  }

  asExtension(): InlineExtension {
    return { name: "pi-ecode-task-plan", factory: (pi) => this.register(pi) };
  }

  private setPlan(plan: TaskPlan | null): void {
    this.plan = clonePlan(plan);
    this.onChange(this.current);
  }

  private restore(context: ExtensionContext): void {
    let restored: TaskPlan | null = null;
    for (const entry of context.sessionManager.getBranch()) {
      const entryPlan = planFromEntry(entry);
      if (entryPlan !== undefined) restored = entryPlan;
    }
    this.setPlan(restored);
  }

  private register(pi: ExtensionAPI): void {
    pi.on("session_start", (_event, context) => this.restore(context));
    pi.on("session_tree", (_event, context) => this.restore(context));
    pi.on("input", (event) => {
      if (event.streamingBehavior !== undefined) return;
      this.setPlan(null);
      pi.appendEntry<PlanStateEntry>(PLAN_ENTRY, { version: 1, plan: null });
    });

    pi.registerTool({
      name: "task_plan",
      label: "Task plan",
      description: "Replace the current task plan with a complete ordered list of pending, in_progress, and completed steps.",
      promptSnippet: "Create or update the visible task plan for multi-step work",
      promptGuidelines: [
        "Use task_plan before the first implementation tool whenever coding, diagnosis, or research requires two or more concrete steps; simple answers do not need a plan.",
        "Keep at most one task_plan item in_progress, update it as work advances, and complete the plan before the final response.",
        "When a steering message changes scope or order, update task_plan before continuing implementation tools.",
      ],
      parameters: TaskPlanParameters,
      execute: async (_toolCallId, params, signal) => {
        signal?.throwIfAborted();
        const plan = validatePlan(params.title, params.items, this.plan);
        this.setPlan(plan);
        const completed = plan.items.filter((item) => item.status === "completed").length;
        return {
          content: [{ type: "text", text: `Task plan updated: ${completed}/${plan.items.length} completed.` }],
          details: { kind: PLAN_DETAILS_KIND, version: 1, plan: structuredClone(plan) } satisfies TaskPlanDetails,
        };
      },
    });
  }
}
