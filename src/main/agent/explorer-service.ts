import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  createAgentSessionFromServices,
  createAgentSessionServices,
  getAgentDir,
  type AgentSession,
  type ExtensionAPI,
  type ExtensionContext,
  type InlineExtension,
  type SessionEntry,
  SessionManager,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { ExplorerTask } from "../../shared/contracts.js";
import { textFromContent } from "./message-mapper.js";

const EXPLORER_STATE_ENTRY = "pi-ecode.explorer-state";
const EXPLORER_RESULT_MESSAGE = "pi-ecode.explorer-result";
const MAX_CONCURRENT_EXPLORERS = 3;
const MAX_DISPATCH_TASKS = 8;
const MAX_FINAL_TEXT_LENGTH = 16 * 1024;
const TERMINAL_STATUSES = new Set<ExplorerTask["status"]>(["completed", "failed", "interrupted"]);
export const EXPLORER_TOOL_NAMES = ["read", "ffgrep", "fffind"] as const;

const EXPLORER_CHILD_GUIDANCE = `## PiECode read-only Explorer
You are a leaf Explorer working for a parent coding agent.
- Investigate only the delegated objective and scope.
- You can only use the parent's read, ffgrep, and fffind tools. Never claim to edit files or execute commands.
- Other Explorers may be running concurrently. Report only evidence you personally verified.
- Cite relevant file paths and finish with a concise, actionable result for the parent agent.
- If the task cannot be answered with the available read-only tools, state the blocker instead of guessing.`;

interface ExplorerStateEntry {
  version: 1;
  tasks: ExplorerTask[];
  deliveredToolCallIds: string[];
}

interface ExplorerRequest {
  task_name: string;
  title: string;
  objective: string;
  scope: string;
  deliverable: string;
}

interface ExplorerRunResult {
  sessionId: string;
  finalText: string;
}

interface ExplorerServiceOptions {
  getParentSession: () => AgentSession | undefined;
  onChange: (tasks: ExplorerTask[]) => void;
  runExplorer?: (request: ExplorerRequest, parent: AgentSession, signal: AbortSignal) => Promise<ExplorerRunResult>;
  now?: () => number;
}

const ExplorerParameters = Type.Object({
  description: Type.String({ minLength: 1, maxLength: 160, description: "Short reason for this parallel investigation" }),
  explorers: Type.Array(Type.Object({
    task_name: Type.String({ minLength: 1, maxLength: 40, pattern: "^[a-z][a-z0-9_]*$", description: "Unique snake_case task identifier" }),
    title: Type.String({ minLength: 1, maxLength: 100, description: "Short user-visible task title" }),
    objective: Type.String({ minLength: 1, maxLength: 800, description: "One concrete question this Explorer must answer" }),
    scope: Type.String({ minLength: 1, maxLength: 800, description: "Exact files, directories, or modules this Explorer may inspect" }),
    deliverable: Type.String({ minLength: 1, maxLength: 800, description: "Evidence and result the parent needs back" }),
  }), { minItems: 1, maxItems: MAX_DISPATCH_TASKS }),
});

function cloneTasks(tasks: Iterable<ExplorerTask>): ExplorerTask[] {
  return [...tasks].map((task) => ({ ...task }));
}

function restoredState(entries: readonly SessionEntry[]): ExplorerStateEntry | null {
  let restored: ExplorerStateEntry | null = null;
  for (const entry of entries) {
    if (entry.type !== "custom" || entry.customType !== EXPLORER_STATE_ENTRY) continue;
    const state = entry.data as Partial<ExplorerStateEntry> | undefined;
    if (state?.version !== 1 || !Array.isArray(state.tasks) || !Array.isArray(state.deliveredToolCallIds)) continue;
    restored = {
      version: 1,
      tasks: state.tasks.map((task) => ({ ...task })),
      deliveredToolCallIds: [...state.deliveredToolCallIds],
    };
  }
  return restored;
}

export function explorerToolDefinitions(parent: Pick<AgentSession, "getToolDefinition">): ToolDefinition[] {
  return EXPLORER_TOOL_NAMES.map((name) => {
    const definition = parent.getToolDefinition(name);
    if (!definition) throw new Error(`Explorer requires the parent ${name} tool, but it is not available.`);
    return definition;
  });
}

function compactFinalText(text: string): string {
  if (text.length <= MAX_FINAL_TEXT_LENGTH) return text;
  return `${text.slice(0, MAX_FINAL_TEXT_LENGTH)}\n…[Explorer result truncated]`;
}

function taskPrompt(request: ExplorerRequest): string {
  return `<explorer_task>
<task_name>${request.task_name}</task_name>
<objective>${request.objective}</objective>
<scope>${request.scope}</scope>
<deliverable>${request.deliverable}</deliverable>
</explorer_task>`;
}

export class ExplorerService {
  private readonly tasks = new Map<string, ExplorerTask>();
  private readonly queue: string[] = [];
  private readonly controllers = new Map<string, AbortController>();
  private readonly operations = new Set<Promise<void>>();
  private readonly deliveredToolCallIds = new Set<string>();
  private readonly now: () => number;
  private readonly runExplorer: (request: ExplorerRequest, parent: AgentSession, signal: AbortSignal) => Promise<ExplorerRunResult>;
  private extensionApi: ExtensionAPI | undefined;
  private disposed = false;

  constructor(private readonly options: ExplorerServiceOptions) {
    this.now = options.now ?? Date.now;
    this.runExplorer = options.runExplorer ?? ((request, parent, signal) => this.runChildSession(request, parent, signal));
  }

  get current(): ExplorerTask[] {
    return cloneTasks(this.tasks.values());
  }

  get isActive(): boolean {
    return this.current.some((task) => task.status === "queued" || task.status === "running");
  }

  get workingStartedAt(): number | null {
    const starts = this.current
      .filter((task) => task.status === "queued" || task.status === "running")
      .map((task) => task.startedAt ?? task.queuedAt);
    return starts.length > 0 ? Math.min(...starts) : null;
  }

  asExtension(): InlineExtension {
    return { name: "pi-ecode-explorers", factory: (pi) => this.register(pi) };
  }

  async interruptAll(): Promise<void> {
    const interruptedBatches = new Set<string>();
    for (const task of this.tasks.values()) {
      if (task.status !== "queued" && task.status !== "running") continue;
      task.status = "interrupted";
      task.endedAt = this.now();
      interruptedBatches.add(task.originToolCallId);
      this.controllers.get(task.id)?.abort();
    }
    for (const toolCallId of interruptedBatches) this.deliveredToolCallIds.add(toolCallId);
    this.queue.length = 0;
    this.publish();
    await Promise.allSettled([...this.operations]);
  }

  async reset(): Promise<void> {
    this.disposed = true;
    await this.interruptAll();
    this.tasks.clear();
    this.controllers.clear();
    this.deliveredToolCallIds.clear();
    this.extensionApi = undefined;
    this.disposed = false;
    this.options.onChange([]);
  }

  private register(pi: ExtensionAPI): void {
    this.extensionApi = pi;
    pi.on("session_start", (_event, context) => this.restore(context));
    pi.on("session_tree", (_event, context) => this.restore(context));
    pi.registerTool({
      name: "dispatch_explorers",
      label: "Dispatch explorers",
      description: "Dispatch independent read-only repository investigations in parallel. Returns immediately; one hidden batch result is delivered after every Explorer finishes.",
      promptSnippet: "Dispatch up to eight independent read-only investigations; at most three run concurrently",
      promptGuidelines: [
        "Use dispatch_explorers only when a task has at least two independent, non-overlapping repository questions that each require substantial reading or searching.",
        "Give every Explorer one objective, an exact read-only scope, and a concrete evidence-based deliverable. Explorers cannot edit files or execute shell commands.",
        "Do not call wait tools or repeatedly poll after dispatch. Continue independent work or end the turn; the completed batch is delivered automatically.",
        "Do not dispatch sequential questions, duplicate scopes, simple lookups, or work the root agent can finish with a few parallel read/search tool calls.",
      ],
      executionMode: "sequential",
      parameters: ExplorerParameters,
      execute: async (toolCallId, params, signal) => {
        signal?.throwIfAborted();
        const snapshots = this.dispatch(toolCallId, params.explorers);
        return {
          content: [{
            type: "text",
            text: `Dispatched ${snapshots.length} read-only Explorer(s). Up to ${MAX_CONCURRENT_EXPLORERS} run concurrently; results will be delivered automatically.`,
          }],
          details: { kind: "pi-ecode.explorer-dispatch", version: 1, explorers: snapshots },
        };
      },
    });
  }

  private dispatch(toolCallId: string, requests: ExplorerRequest[]): ExplorerTask[] {
    if (this.disposed) throw new Error("Explorer service is unavailable.");
    const parent = this.options.getParentSession();
    if (!parent?.model) throw new Error("Select a model before dispatching Explorers.");
    const names = new Set<string>();
    for (const request of requests) {
      if (names.has(request.task_name)) throw new Error(`Duplicate Explorer task_name: ${request.task_name}`);
      names.add(request.task_name);
    }

    const created = requests.map((request): ExplorerTask => {
      const task: ExplorerTask = {
        id: randomUUID(),
        taskName: request.task_name,
        title: request.title.trim(),
        objective: request.objective.trim(),
        scope: request.scope.trim(),
        deliverable: request.deliverable.trim(),
        status: "queued",
        originToolCallId: toolCallId,
        queuedAt: this.now(),
      };
      this.tasks.set(task.id, task);
      this.queue.push(task.id);
      return task;
    });
    this.publish();
    this.drainQueue();
    return cloneTasks(created);
  }

  private drainQueue(): void {
    if (this.disposed) return;
    while (this.controllers.size < MAX_CONCURRENT_EXPLORERS) {
      const id = this.queue.shift();
      if (!id) return;
      const task = this.tasks.get(id);
      if (!task || task.status !== "queued") continue;
      const request: ExplorerRequest = {
        task_name: task.taskName,
        title: task.title,
        objective: task.objective,
        scope: task.scope,
        deliverable: task.deliverable,
      };
      const controller = new AbortController();
      this.controllers.set(id, controller);
      task.status = "running";
      task.startedAt = this.now();
      this.publish();
      const operation = this.executeTask(task, request, controller);
      this.operations.add(operation);
      void operation.finally(() => this.operations.delete(operation));
    }
  }

  private async executeTask(task: ExplorerTask, request: ExplorerRequest, controller: AbortController): Promise<void> {
    const parent = this.options.getParentSession();
    try {
      if (!parent) throw new Error("Parent session is no longer available.");
      const result = await this.runExplorer(request, parent, controller.signal);
      if (task.status === "interrupted") return;
      task.status = "completed";
      task.sessionId = result.sessionId;
      task.finalText = compactFinalText(result.finalText);
      task.endedAt = this.now();
    } catch (error) {
      if (task.status === "interrupted") return;
      task.status = controller.signal.aborted ? "interrupted" : "failed";
      task.errorMessage = error instanceof Error ? error.message : String(error);
      task.endedAt = this.now();
    } finally {
      this.controllers.delete(task.id);
      this.publish();
      this.notifyBatchIfReady(task.originToolCallId);
      this.drainQueue();
    }
  }

  private async runChildSession(request: ExplorerRequest, parent: AgentSession, signal: AbortSignal): Promise<ExplorerRunResult> {
    const cwd = parent.sessionManager.getCwd();
    const sessionRoot = parent.sessionFile
      ? join(dirname(parent.sessionFile), ".explorers", parent.sessionId)
      : join(getAgentDir(), "state", "pi-ecode-explorers", parent.sessionId);
    await mkdir(sessionRoot, { recursive: true });
    signal.throwIfAborted();
    const services = await createAgentSessionServices({
      cwd,
      agentDir: getAgentDir(),
      settingsManager: parent.settingsManager,
      modelRuntime: parent.modelRuntime,
      resourceLoaderOptions: {
        extensionFactories: [],
        appendSystemPromptOverride: (base) => [...base, EXPLORER_CHILD_GUIDANCE],
        extensionsOverride: (base) => ({ ...base, extensions: [] }),
      },
    });
    const model = parent.model;
    if (!model) throw new Error("Explorer cannot start without a selected parent model.");
    const customTools = explorerToolDefinitions(parent);
    const created = await createAgentSessionFromServices({
      services,
      sessionManager: SessionManager.create(cwd, sessionRoot, {
        ...(parent.sessionFile ? { parentSession: parent.sessionFile } : {}),
      }),
      model,
      thinkingLevel: parent.thinkingLevel,
      tools: [...EXPLORER_TOOL_NAMES],
      customTools,
    });
    const child = created.session;
    const abortChild = (): void => { void child.abort(); };
    signal.addEventListener("abort", abortChild, { once: true });
    try {
      child.agent.toolExecution = "parallel";
      await child.bindExtensions({ mode: "rpc" });
      await child.prompt(taskPrompt(request));
      signal.throwIfAborted();
      const response = child.messages.findLast((message) => message.role === "assistant");
      if (!response || response.role !== "assistant") throw new Error("Explorer returned no assistant response.");
      const text = textFromContent(response.content).trim();
      if (response.stopReason === "error") throw new Error(response.errorMessage || text || "Explorer failed.");
      if (!text) throw new Error("Explorer returned an empty result.");
      return { sessionId: child.sessionId, finalText: text };
    } finally {
      signal.removeEventListener("abort", abortChild);
      child.dispose();
    }
  }

  private notifyBatchIfReady(toolCallId: string): void {
    if (this.disposed || this.deliveredToolCallIds.has(toolCallId)) return;
    const batch = this.current.filter((task) => task.originToolCallId === toolCallId);
    if (batch.length === 0 || batch.some((task) => !TERMINAL_STATUSES.has(task.status))) return;
    this.deliveredToolCallIds.add(toolCallId);
    this.persist();
    const body = batch.map((task) => {
      const result = task.finalText ?? task.errorMessage ?? "No result was produced.";
      return `<explorer task_name="${task.taskName}" status="${task.status}">\n${result}\n</explorer>`;
    }).join("\n\n");
    this.extensionApi?.sendMessage({
      customType: EXPLORER_RESULT_MESSAGE,
      content: [{ type: "text", text: `<explorer_batch origin_tool_call_id="${toolCallId}">\n${body}\n</explorer_batch>` }],
      display: false,
      details: { originToolCallId: toolCallId, explorers: batch },
    }, { triggerTurn: true, deliverAs: "followUp" });
  }

  private restore(context: ExtensionContext): void {
    for (const controller of this.controllers.values()) controller.abort();
    this.tasks.clear();
    this.queue.length = 0;
    this.controllers.clear();
    this.deliveredToolCallIds.clear();
    const state = restoredState(context.sessionManager.getBranch());
    let changed = false;
    if (state) {
      for (const restored of state.tasks) {
        const task = { ...restored };
        if (task.status === "queued" || task.status === "running") {
          task.status = "interrupted";
          task.endedAt = this.now();
          task.errorMessage = "Explorer was interrupted when the parent session closed.";
          this.deliveredToolCallIds.add(task.originToolCallId);
          changed = true;
        }
        this.tasks.set(task.id, task);
      }
      for (const id of state.deliveredToolCallIds) this.deliveredToolCallIds.add(id);
    }
    this.options.onChange(this.current);
    if (changed) this.persist();
  }

  private publish(): void {
    const snapshot = this.current;
    this.options.onChange(snapshot);
    this.persist();
  }

  private persist(): void {
    if (!this.extensionApi) return;
    this.extensionApi.appendEntry<ExplorerStateEntry>(EXPLORER_STATE_ENTRY, {
      version: 1,
      tasks: this.current,
      deliveredToolCallIds: [...this.deliveredToolCallIds],
    });
  }
}
