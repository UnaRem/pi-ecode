import type { AgentEvent, AgentSnapshot, AgentTimelinePage, ConversationItem, ImageAttachment } from "@shared/contracts";
import { parsePastedTexts } from "../../shared/pasted-text";

export interface PendingPrompt {
  id: string;
  text: string;
  images: ImageAttachment[];
  timestamp: number;
  settled: boolean;
}

export type AgentViewEvent = AgentEvent
  | { type: "prompt-started"; prompt: Omit<PendingPrompt, "settled"> }
  | { type: "prompt-finished"; id: string }
  | { type: "prompt-failed"; id: string; error: string }
  | { type: "editor-restored"; version: number }
  | { type: "timeline-page"; page: AgentTimelinePage };

export interface AgentViewState extends AgentSnapshot {
  restoredEditorText: string | null;
  restoredEditorImages: ImageAttachment[];
  editorRestoreVersion: number;
  notice: string | null;
  pendingPrompts: PendingPrompt[];
  editorRestoreMode: "replace" | "merge";
}

export const INITIAL_AGENT_STATE: AgentViewState = {
  projectPath: null,
  projectName: null,
  sessionId: null,
  sessionFile: null,
  sessionTitle: null,
  sessions: [],
  timelineHasMore: false,
  models: [],
  selectedModel: null,
  thinkingLevel: "off",
  thinkingLevels: ["off"],
  isStreaming: false,
  workingStartedAt: null,
  pendingCount: 0,
  error: null,
  canContinue: false,
  taskPlan: null,
  explorers: [],
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
  timeline: [],
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
    canCompact: false,
    isCompacting: false,
    isEstimated: false,
    compactionMethod: null,
    compaction: { status: "idle" },
  },
  policy: { contextFiles: [], workflow: "manual-review", gitCommits: "required-after-verification" },
  pendingPrompts: [],
  editorRestoreMode: "replace",
  restoredEditorText: null,
  restoredEditorImages: [],
  editorRestoreVersion: 0,
  notice: null,
};

function upsertTimeline(
  timeline: AgentViewState["timeline"],
  next: AgentViewState["timeline"][number],
): AgentViewState["timeline"] {
  const index = timeline.findIndex((item) => item.id === next.id);
  if (index < 0) return [...timeline, next];
  return timeline.map((item, itemIndex) => itemIndex === index ? next : item);
}

function restorePendingPrompts(state: AgentViewState, prompts: PendingPrompt[]): AgentViewState {
  if (prompts.length === 0) return state;
  return {
    ...state,
    restoredEditorText: [
      ...(state.editorRestoreMode === "merge" ? [state.restoredEditorText] : []),
      ...prompts.map((prompt) => prompt.text),
    ].filter(Boolean).join("\n\n"),
    restoredEditorImages: [
      ...(state.editorRestoreMode === "merge" ? state.restoredEditorImages : []),
      ...prompts.flatMap((prompt) => prompt.images),
    ],
    editorRestoreMode: "merge",
    editorRestoreVersion: state.editorRestoreVersion + 1,
  };
}

export function optimisticTimeline(state: AgentViewState): ConversationItem[] {
  if (state.pendingPrompts.length === 0) return state.timeline;
  return [...state.timeline, ...state.pendingPrompts.map((prompt): ConversationItem => {
    const parsed = parsePastedTexts(prompt.text);
    return {
      kind: "message",
      id: prompt.id,
      message: {
        id: prompt.id, role: "user", timestamp: prompt.timestamp,
        text: parsed.message, images: prompt.images, pastedTexts: parsed.attachments,
      },
    };
  })];
}

function userMessageKey(item: ConversationItem): string | null {
  return item.kind === "message" && item.message.role === "user"
    ? JSON.stringify([item.message.timestamp, item.message.text]) : null;
}

function newlyPublishedUsers(previous: ConversationItem[], incoming: ConversationItem[]): number {
  // SDK snapshot IDs include array indexes, unlike live IDs. Compare message identity
  // and occurrence counts so refreshing a snapshot cannot confirm another queued send.
  const known = new Map<string, number>();
  for (const item of previous) {
    const key = userMessageKey(item);
    if (key !== null) known.set(key, (known.get(key) ?? 0) + 1);
  }
  let count = 0;
  for (const item of incoming) {
    const key = userMessageKey(item);
    if (key === null) continue;
    const occurrences = known.get(key) ?? 0;
    if (occurrences > 0) known.set(key, occurrences - 1);
    else count++;
  }
  return count;
}

function finishPendingPrompt(
  state: AgentViewState,
  event: Extract<AgentViewEvent, { type: "prompt-failed" | "prompt-finished" }>,
): AgentViewState {
  const pending = state.pendingPrompts.find((prompt) => prompt.id === event.id);
  if (!pending) return state; // Already accepted, or the user switched sessions.
  if (event.type === "prompt-finished" && state.isStreaming) {
    return { ...state, pendingPrompts: state.pendingPrompts.map((prompt) => prompt.id === event.id ? { ...prompt, settled: true } : prompt) };
  }
  const next = { ...state, pendingPrompts: state.pendingPrompts.filter((prompt) => prompt.id !== event.id) };
  return event.type === "prompt-failed"
    ? restorePendingPrompts({ ...next, error: event.error }, [pending]) : next;
}

export function reduceAgentEvent(state: AgentViewState, event: AgentViewEvent): AgentViewState {
  if (event.type === "timeline-page") {
    return { ...state, timeline: event.page.timeline, timelineHasMore: event.page.hasMore };
  }
  if (event.type === "editor-restored") {
    return event.version === state.editorRestoreVersion
      ? { ...state, restoredEditorText: null, restoredEditorImages: [], editorRestoreMode: "replace" } : state;
  }
  if (event.type === "prompt-started") {
    return { ...state, error: null, pendingPrompts: [...state.pendingPrompts, { ...event.prompt, settled: false }] };
  }
  if (event.type === "prompt-failed" || event.type === "prompt-finished") return finishPendingPrompt(state, event);
  let next = reduceServerEvent(state, event);
  if (event.type === "timeline-upsert" && event.item.kind === "message"
    && event.item.message.role === "user" && state.pendingPrompts.length > 0) {
    // User messages are published in submission order, after extension transforms.
    next = { ...next, pendingPrompts: state.pendingPrompts.slice(newlyPublishedUsers(state.timeline, [event.item])) };
  }
  if (event.type === "state" && event.patch.isStreaming === false) {
    const cancelled = next.pendingPrompts.filter((prompt) => prompt.settled);
    next = restorePendingPrompts({ ...next, pendingPrompts: next.pendingPrompts.filter((prompt) => !prompt.settled) }, cancelled);
  }
  return next;
}

function reduceServerEvent(state: AgentViewState, event: AgentEvent): AgentViewState {
  switch (event.type) {
    case "snapshot":
      return {
        ...event.snapshot,
        pendingPrompts: event.snapshot.sessionId === state.sessionId && event.snapshot.projectPath === state.projectPath
          ? state.pendingPrompts.slice(newlyPublishedUsers(state.timeline, event.snapshot.timeline)) : [],
        editorRestoreMode: "replace",
        restoredEditorText: null,
        restoredEditorImages: [],
        editorRestoreVersion: state.editorRestoreVersion,
        notice: null,
      };
    case "timeline-upsert":
      return { ...state, timeline: upsertTimeline(state.timeline, event.item) };
    case "context":
      return { ...state, context: event.context };
    case "task-plan":
      return { ...state, taskPlan: event.taskPlan };
    case "explorers":
      return { ...state, explorers: event.explorers };
    case "extension-ui":
      return { ...state, extensionUi: event.request };
    case "state":
      return { ...state, ...event.patch };
    case "sessions":
      return { ...state, sessions: event.sessions };
    case "history":
      return {
        ...state,
        history: event.history,
        editorRestoreMode: event.editorText !== undefined || event.editorImages !== undefined ? "replace" : state.editorRestoreMode,
        restoredEditorText: event.editorText ?? state.restoredEditorText,
        restoredEditorImages: event.editorImages ?? state.restoredEditorImages,
        editorRestoreVersion: event.editorText !== undefined || event.editorImages !== undefined
          ? state.editorRestoreVersion + 1
          : state.editorRestoreVersion,
        notice: event.notice ?? null,
      };
    case "validation":
      return { ...state, validation: event.validation };
    case "review":
      return { ...state, review: event.review };
    case "candidate":
      return { ...state, candidate: event.candidate };
    case "notice":
      return { ...state, notice: event.message, error: null };
    case "error":
      return { ...state, error: event.message };
  }
}
