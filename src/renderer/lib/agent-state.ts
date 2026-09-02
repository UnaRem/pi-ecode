import type { AgentEvent, AgentSnapshot, ToolActivity } from "@shared/contracts";

export interface AgentViewState extends AgentSnapshot {
  liveAssistant: string;
  restoredEditorText: string | null;
  editorRestoreVersion: number;
  notice: string | null;
}

export const INITIAL_AGENT_STATE: AgentViewState = {
  projectPath: null,
  projectName: null,
  sessionId: null,
  sessionFile: null,
  sessionTitle: null,
  sessions: [],
  messages: [],
  tools: [],
  models: [],
  selectedModel: null,
  thinkingLevel: "off",
  thinkingLevels: ["off"],
  isStreaming: false,
  pendingCount: 0,
  error: null,
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
  context: { tokens: null, contextWindow: null, percent: null, isCompacting: false },
  policy: { contextFiles: [], workflow: "manual-review", gitCommits: "on-request" },
  liveAssistant: "",
  restoredEditorText: null,
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

function upsertTool(tools: ToolActivity[], next: ToolActivity): ToolActivity[] {
  const index = tools.findIndex((tool) => tool.id === next.id);
  if (index < 0) return [...tools, next];
  return tools.map((tool, toolIndex) => (toolIndex === index ? next : tool));
}

export function reduceAgentEvent(state: AgentViewState, event: AgentEvent): AgentViewState {
  switch (event.type) {
    case "snapshot":
      return {
        ...event.snapshot,
        liveAssistant: "",
        restoredEditorText: null,
        editorRestoreVersion: state.editorRestoreVersion,
        notice: null,
      };
    case "assistant-delta":
      return { ...state, liveAssistant: state.liveAssistant + event.delta };
    case "message": {
      const exists = state.messages.some((message) => message.id === event.message.id);
      return {
        ...state,
        messages: exists ? state.messages : [...state.messages, event.message],
        liveAssistant: event.message.role === "assistant" ? "" : state.liveAssistant,
      };
    }
    case "tool":
      return { ...state, tools: upsertTool(state.tools, event.tool) };
    case "timeline-upsert":
      return { ...state, timeline: upsertTimeline(state.timeline, event.item) };
    case "context":
      return { ...state, context: event.context };
    case "state":
      return { ...state, ...event.patch };
    case "sessions":
      return { ...state, sessions: event.sessions };
    case "history":
      return {
        ...state,
        history: event.history,
        restoredEditorText: event.editorText ?? state.restoredEditorText,
        editorRestoreVersion: event.editorText ? state.editorRestoreVersion + 1 : state.editorRestoreVersion,
        notice: event.notice ?? null,
      };
    case "validation":
      return { ...state, validation: event.validation };
    case "review":
      return { ...state, review: event.review };
    case "candidate":
      return { ...state, candidate: event.candidate };
    case "error":
      return { ...state, error: event.message, isStreaming: false };
  }
}
