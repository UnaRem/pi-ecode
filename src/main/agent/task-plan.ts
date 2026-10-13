import { StringEnum } from "@earendil-works/pi-ai";
import type {
  AgentActivityOutcome, AgentSession, BoundaryResult, ExtensionAPI, ExtensionContext, InlineExtension, SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { CONFIRMATION_TOOL_NAME, parseConfirmationMarker } from "../../shared/confirmation.js";
import type { TaskPlan, TaskPlanItem } from "../../shared/contracts.js";

const PLAN_ENTRY = "pi-ecode.task-plan-state";
const PLAN_DETAILS_KIND = "pi-ecode.task-plan";
const MAX_PLAN_ITEMS = 12;

// Completion criteria are host/model protocol metadata; the renderer only consumes the existing status contract.
type PlannedTask = TaskPlanItem & { completionCriteria?: string };
type PlannedTaskPlan = Omit<TaskPlan, "items"> & { items: PlannedTask[] };

interface TaskPlanDetails {
  kind: typeof PLAN_DETAILS_KIND;
  version: 1;
  plan: PlannedTaskPlan;
}

interface PlanStateEntry {
  version: 1;
  plan: PlannedTaskPlan | null;
}

const TaskPlanParameters = Type.Object({
  title: Type.String({ minLength: 1, maxLength: 120, description: "Short title for the current task" }),
  items: Type.Array(Type.Object({
    id: Type.String({ minLength: 1, maxLength: 40, description: "Stable short identifier" }),
    text: Type.String({ minLength: 1, maxLength: 200, description: "Concrete outcome for this step" }),
    completionCriteria: Type.String({ minLength: 1, maxLength: 400, description: "Evidence required to consider this task complete" }),
    status: StringEnum(["pending", "in_progress", "completed"] as const),
  }), { minItems: 1, maxItems: MAX_PLAN_ITEMS }),
});

const TaskProgressParameters = Type.Object({
  planUpdatedAt: Type.Integer({ minimum: 0, description: "Current plan revision from request context; stale reports are rejected" }),
  id: Type.String({ minLength: 1, maxLength: 40, description: "Task ID in the current plan" }),
  outcome: StringEnum(["in_progress", "completed", "blocked"] as const),
  evidence: Type.String({ minLength: 1, maxLength: 1000, description: "Observed results against the completion criteria, or remaining work/blocker" }),
  nextId: Type.Optional(Type.String({ minLength: 1, maxLength: 40, description: "Task to start after completing this task" })),
});
type TaskProgressReport = Static<typeof TaskProgressParameters>;

function clonePlan(plan: PlannedTaskPlan | null): PlannedTaskPlan | null {
  return plan ? structuredClone(plan) : null;
}

function planFromDetails(details: unknown): PlannedTaskPlan | null {
  if (!details || typeof details !== "object") return null;
  const candidate = details as Partial<TaskPlanDetails>;
  if (candidate.kind !== PLAN_DETAILS_KIND || candidate.version !== 1 || !candidate.plan) return null;
  return clonePlan(candidate.plan);
}

function planFromEntry(entry: SessionEntry): PlannedTaskPlan | null | undefined {
  if (entry.type === "custom" && entry.customType === PLAN_ENTRY) {
    const state = entry.data as Partial<PlanStateEntry> | undefined;
    return state?.version === 1 ? clonePlan(state.plan ?? null) : undefined;
  }
  if (entry.type !== "message" || entry.message.role !== "toolResult" || entry.message.isError
    || !["task_plan", "task_progress"].includes(entry.message.toolName)) {
    return undefined;
  }
  return planFromDetails(entry.message.details) ?? undefined;
}

function normalizeTaskText(text: string): string {
  return text.trim().replace(/^(?:[-*+]\s+)?\[[ xX]\]\s+/u, "");
}

function validatePlan(title: string, items: PlannedTask[], previousRevision = 0): PlannedTaskPlan {
  const normalizedTitle = title.trim();
  if (!normalizedTitle) throw new Error("Task plan title cannot be empty.");
  const normalizedItems = items.map((item) => ({ ...item, id: item.id.trim(), text: normalizeTaskText(item.text),
    ...(item.completionCriteria !== undefined ? { completionCriteria: item.completionCriteria.trim() } : {}) }));
  if (normalizedItems.some((item) => item.completionCriteria === "")) throw new Error("Task completion criteria cannot be empty.");
  if (normalizedItems.some((item) => !item.id || !item.text)) throw new Error("Task plan item IDs and text cannot be empty.");
  if (new Set(normalizedItems.map((item) => item.id)).size !== normalizedItems.length) {
    throw new Error("Task plan item IDs must be unique.");
  }
  if (normalizedItems.filter((item) => item.status === "in_progress").length > 1) {
    throw new Error("Only one task plan item can be in progress.");
  }
  return { title: normalizedTitle, items: normalizedItems, updatedAt: Math.max(Date.now(), previousRevision + 1) };
}

export class TaskPlanService {
  private plan: PlannedTaskPlan | null = null;
  private readonly installedSessions = new WeakSet<AgentSession>();
  private checkpointFailed = false;
  private workSinceProgress = false;
  private progressCurrent = false;
  private checkpointPending = false;
  private checkpointTurn = false;
  private repairRequested = false;
  private pausedForConfirmation = false;

  constructor(private readonly onChange: (plan: TaskPlan | null) => void) {}

  get current(): PlannedTaskPlan | null {
    return clonePlan(this.plan);
  }

  asExtension(): InlineExtension {
    return { name: "pi-ecode-task-plan", factory: (pi) => this.register(pi) };
  }

  install(session: AgentSession): void {
    if (this.installedSessions.has(session)) return;
    const previousFinishTurn = session.agent.finishTurn;
    session.agent.finishTurn = async (turn, signal) => {
      const previous = await previousFinishTurn?.(turn, signal);
      if (!this.checkpointFailed) return previous || undefined;
      // Extension abort marks the run cancelled; finishTurn must also end the low-level tool loop.
      session.clearQueue();
      void session.abort();
      return { action: "end" };
    };
    this.installedSessions.add(session);
  }

  private setPlan(plan: PlannedTaskPlan | null): void {
    const copiedPlan = clonePlan(plan);
    this.plan = copiedPlan ? {
      ...copiedPlan,
      items: copiedPlan.items.map((item) => ({ ...item, text: normalizeTaskText(item.text) })),
    } : null;
    this.onChange(this.current);
  }

  private restore(context: ExtensionContext): void {
    let restored: PlannedTaskPlan | null = null;
    for (const entry of context.sessionManager.getBranch()) {
      const entryPlan = planFromEntry(entry);
      if (entryPlan !== undefined) restored = entryPlan;
    }
    this.resetCheckpoint();
    this.setPlan(restored);
    // A resumed unfinished task must report its state before executing more work.
    this.checkpointPending = restored?.items.some((item) => item.status !== "completed") ?? false;
    this.workSinceProgress = this.checkpointPending;
    this.progressCurrent = Boolean(restored) && !this.checkpointPending;
  }

  private resetCheckpoint(): void {
    this.workSinceProgress = false;
    this.progressCurrent = false;
    this.checkpointFailed = false;
    this.checkpointPending = false;
    this.checkpointTurn = false;
    this.repairRequested = false;
    this.pausedForConfirmation = false;
  }

  private requestCheckpoint(context: ExtensionContext, outcome: AgentActivityOutcome): BoundaryResult | undefined {
    if (!this.plan || !this.workSinceProgress || this.pausedForConfirmation
      || outcome !== "completed" || context.signal?.aborted) return;
    this.checkpointPending = true;
    if (this.repairRequested) {
      // One repair request is enough; abort instead of repeatedly asking an uncooperative model.
      this.checkpointFailed = true;
      context.ui.notify("待办进度同步失败：模型未提交有效报告，已停止后续执行。待办保留原状态。", "error");
      context.abort();
      return;
    }
    this.repairRequested = true;
    return { continue: true, entries: [{ type: "custom_message", customType: "pi-ecode.task-checkpoint", display: false,
      content: "主程序待办检查点：本批工作已结束。下一条回复必须单独调用 task_progress，按当前计划 ID 和完成标准报告 completed、in_progress 或 blocked，并提供依据。未满足标准就报告剩余工作，不能把工具成功等同于任务完成。补报成功后才可继续执行或交付。",
    }] };
  }

  private registerHooks(pi: ExtensionAPI): void {
    pi.on("turn_start", () => { this.checkpointTurn = this.checkpointPending; });
    pi.on("tool_call", (event, context) => {
      if (event.toolName === "task_progress") {
        const latest = context.sessionManager.getBranch().findLast((entry) => entry.type === "message" && entry.message.role === "assistant");
        if (latest?.type === "message" && latest.message.role === "assistant"
          && latest.message.content.filter((block) => block.type === "toolCall").length > 1) {
          return { block: true, reason: "task_progress 必须单独报告，不能与尚未获取结果的其他工具同批执行。" };
        }
        return;
      }
      if (!(this.checkpointPending || this.checkpointTurn) || event.toolName === CONFIRMATION_TOOL_NAME) return;
      return { block: true, reason: "待办检查点尚未同步；请在独立回复中先调用 task_progress，报告当前任务进度。" };
    });
    pi.on("tool_execution_end", (event) => {
      if (this.plan && event.durationMs !== undefined
        && !["task_plan", "task_progress", CONFIRMATION_TOOL_NAME].includes(event.toolName)) {
        this.workSinceProgress = true;
        this.progressCurrent = false;
      }
    });
    pi.on("context", (event) => {
      if (!this.plan) return;
      // Request-local state survives compaction without adding a full plan to history on every request.
      return { messages: [...event.messages, { role: "custom", customType: "pi-ecode.task-progress-context", display: false,
        timestamp: Date.now(), details: undefined,
        content: `Current authoritative task plan: ${JSON.stringify(this.plan)}\n${this.checkpointPending
          ? "A host checkpoint is pending. Call task_progress alone before further work or final delivery."
          : "Report progress with task_progress after work batches and before delivery. Use observed evidence; blocked or unfinished work must remain incomplete."}`,
      }] };
    });
    this.registerBoundaryHooks(pi);
  }

  private registerBoundaryHooks(pi: ExtensionAPI): void {
    pi.on("turn_end", (event, context) => {
      this.pausedForConfirmation = event.toolResults.some((result) => result.toolName === CONFIRMATION_TOOL_NAME
        && !result.isError && parseConfirmationMarker(result.details)?.requestId === result.toolCallId);
      // A same-batch report cannot certify sibling work whose results were not yet available to the model.
      const businessResults = event.toolResults.some((result) => result.durationMs !== undefined
        && !["task_plan", "task_progress", CONFIRMATION_TOOL_NAME].includes(result.toolName));
      if (this.plan && businessResults) {
        this.workSinceProgress = true;
        this.progressCurrent = false;
      }
      // Pure reasoning and final answers also need a report; progress-only rounds must not trigger themselves.
      if (this.plan && event.toolResults.length === 0 && !this.progressCurrent) this.workSinceProgress = true;
      return this.requestCheckpoint(context, event.outcome);
    });
    pi.on("agent_before_settle", (event, context) => this.requestCheckpoint(context, event.outcome));
  }

  private validateNextTask(report: TaskProgressReport): void {
    if (report.nextId === undefined) return;
    if (report.outcome !== "completed" || report.nextId === report.id
      || !this.plan?.items.some((item) => item.id === report.nextId && item.status !== "completed")) {
      throw new Error("仅在完成当前任务后才能开始另一个未完成的有效待办。");
    }
  }

  private applyProgress(report: TaskProgressReport): PlannedTaskPlan {
    if (!this.plan || report.planUpdatedAt !== this.plan.updatedAt) throw new Error("待办报告已过期；请读取当前计划版本后重新报告。");
    if (!report.evidence.trim()) throw new Error("待办报告必须说明完成依据、剩余工作或阻塞原因。");
    if (!this.plan.items.some((item) => item.id === report.id)) throw new Error("待办 ID 不属于当前计划。");
    const activeTask = this.plan.items.find((item) => item.status === "in_progress");
    if (activeTask && activeTask.id !== report.id) throw new Error("请先报告当前进行中的任务，不能以其他待办释放检查点。");
    this.validateNextTask(report);
    const items = this.plan.items.map((item): PlannedTask => item.id === report.id
      ? { ...item, status: report.outcome === "completed" ? "completed" : "in_progress" }
      : item.id === report.nextId ? { ...item, status: "in_progress" } : item);
    return validatePlan(this.plan.title, items, this.plan.updatedAt);
  }

  private registerProgressTool(pi: ExtensionAPI): void {
    pi.registerTool({
      name: "task_progress", label: "Task progress", exposure: "model-only", executionMode: "sequential",
      description: "Report evidence-based progress for a task in the current plan. The host validates the plan revision, persists the updated state and releases a pending checkpoint.",
      promptSnippet: "Synchronize task progress at host checkpoints",
      promptGuidelines: [
        "When a host task checkpoint is pending, call task_progress alone before other tools or final delivery.",
        "Use the current planUpdatedAt revision and task ID from request context. Report observed evidence against completionCriteria; use in_progress or blocked when unfinished.",
        "A blocked report keeps the task incomplete. A launched background validation is still running; only its final result can establish success.",
      ],
      parameters: TaskProgressParameters,
      execute: async (_toolCallId, report, signal) => {
        signal?.throwIfAborted();
        const plan = this.applyProgress(report);
        // Persist before publishing; a failed write must not advance the sidebar or release the gate.
        pi.appendEntry<PlanStateEntry>(PLAN_ENTRY, { version: 1, plan });
        this.setPlan(plan);
        this.workSinceProgress = false;
        this.progressCurrent = true;
        this.checkpointPending = false;
        this.repairRequested = false;
        return { content: [{ type: "text", text: `任务 ${report.id}：${report.outcome}。${report.evidence.trim()}\n计划版本：${plan.updatedAt}` }],
          details: { kind: PLAN_DETAILS_KIND, version: 1, plan: structuredClone(plan), report } };
      },
    });
  }

  private register(pi: ExtensionAPI): void {
    pi.on("session_start", (_event, context) => this.restore(context));
    pi.on("session_tree", (_event, context) => this.restore(context));
    pi.on("input", (event) => {
      if (event.streamingBehavior !== undefined) return;
      this.resetCheckpoint();
      pi.appendEntry<PlanStateEntry>(PLAN_ENTRY, { version: 1, plan: null });
      this.setPlan(null);
    });
    this.registerHooks(pi);
    this.registerProgressTool(pi);

    pi.registerTool({
      name: "task_plan",
      label: "Task plan",
      description: "Replace the current task plan with a complete ordered list of steps and their completion criteria.",
      promptSnippet: "Create or update the visible task plan for multi-step work",
      promptGuidelines: [
        "Use task_plan before the first implementation tool whenever coding, diagnosis, or research requires two or more concrete steps; simple answers do not need a plan.",
        "Keep at most one task_plan item in_progress, update it as work advances, and complete the plan before the final response.",
        "Submit the current truthful state; an item may move directly from pending to completed if it finishes between plan updates.",
        "When a steering message changes scope or order, update task_plan before continuing implementation tools.",
        "Define completionCriteria for every task, including research, reasoning, implementation, verification and delivery. Criteria must describe evidence, not just a tool or file name.",
        "Use task_plan to create or restructure the plan; use task_progress to report task outcomes at host checkpoints.",
      ],
      executionMode: "sequential",
      parameters: TaskPlanParameters,
      execute: async (_toolCallId, params, signal) => {
        signal?.throwIfAborted();
        const plan = validatePlan(params.title, params.items, this.plan?.updatedAt);
        pi.appendEntry<PlanStateEntry>(PLAN_ENTRY, { version: 1, plan });
        this.setPlan(plan);
        this.progressCurrent = false;
        const completed = plan.items.filter((item) => item.status === "completed").length;
        return {
          content: [{ type: "text", text: `Task plan updated: ${completed}/${plan.items.length} completed.` }],
          details: { kind: PLAN_DETAILS_KIND, version: 1, plan: structuredClone(plan) } satisfies TaskPlanDetails,
        };
      },
    });
  }
}
