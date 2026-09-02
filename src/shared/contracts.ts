export const IPC_CHANNELS = {
  chooseProject: "desktop:choose-project",
  openProject: "agent:open-project",
  getSnapshot: "agent:get-snapshot",
  newSession: "agent:new-session",
  switchSession: "agent:switch-session",
  prompt: "agent:prompt",
  stop: "agent:stop",
  setModel: "agent:set-model",
  setThinkingLevel: "agent:set-thinking-level",
  createCheckpoint: "history:create-checkpoint",
  undo: "history:undo",
  redo: "history:redo",
  runValidation: "validation:run",
  stopValidation: "validation:stop",
  getReview: "review:get",
  rejectReviewFile: "review:reject-file",
  prepareCandidate: "self-update:prepare",
  activateCandidate: "self-update:activate",
  rendererReady: "desktop:renderer-ready",
  compact: "agent:compact",
  cancelCompact: "agent:cancel-compact",
  event: "agent:event",
} as const;

export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export interface ModelOption {
  id: string;
  provider: string;
  name: string;
  reasoning: boolean;
}

export interface SessionSummary {
  path: string;
  id: string;
  title: string;
  modifiedAt: number;
  messageCount: number;
}

export interface ImageAttachment {
  id: string;
  fileName: string;
  mimeType: "image/png" | "image/jpeg" | "image/gif" | "image/webp";
  data: string;
}

export interface ConversationMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
  timestamp: number;
  images?: ImageAttachment[];
  isError?: boolean;
}

export interface ToolActivity {
  id: string;
  name: string;
  title: string;
  input: string;
  output: string;
  status: "running" | "success" | "error";
}

export type ConversationItem =
  | { kind: "message"; id: string; message: ConversationMessage }
  | { kind: "tool"; id: string; tool: ToolActivity };

export interface ContextState {
  tokens: number | null;
  contextWindow: number | null;
  percent: number | null;
  isCompacting: boolean;
  isEstimated: boolean;
  compactionMethod: "native" | "summary" | null;
}

export interface RuntimePolicy {
  contextFiles: string[];
  workflow: "manual-review";
  gitCommits: "required-after-verification";
}

export interface WorkspaceHistoryState {
  available: boolean;
  canUndo: boolean;
  canRedo: boolean;
  isBusy: boolean;
  message: string | null;
}

export interface HistoryOperationResult {
  editorText?: string;
  editorImages?: ImageAttachment[];
  message: string;
}

export type ValidationStepId = "typecheck" | "test" | "build";
export type ValidationRunStatus = "idle" | "running" | "passed" | "failed" | "cancelled" | "stale";
export type ValidationStepStatus = "pending" | "running" | "passed" | "failed" | "cancelled" | "skipped";

export interface ValidationStep {
  id: ValidationStepId;
  label: string;
  command: string;
  status: ValidationStepStatus;
  output: string;
  exitCode: number | null;
  durationMs: number | null;
}

export interface ValidationState {
  supported: boolean;
  isSelfProject: boolean;
  status: ValidationRunStatus;
  runId: string | null;
  activeStep: ValidationStepId | null;
  steps: ValidationStep[];
  verifiedAt: number | null;
  message: string | null;
}

export interface ChangedFile {
  path: string;
  previousPath?: string;
  status: "added" | "modified" | "deleted" | "renamed" | "unknown";
  additions: number | null;
  deletions: number | null;
}

export interface ChangeReview {
  available: boolean;
  baseCommit: string | null;
  headCommit: string | null;
  files: ChangedFile[];
  patch: string;
  truncated: boolean;
  message: string | null;
}

export interface UpdateRecord {
  id: string;
  status: "prepared" | "activating" | "active" | "failed" | "discarded";
  path: string;
  sourceRoot: string;
  preparedAt: number;
  updatedAt: number;
  message: string | null;
}

export interface CandidateState {
  status: "idle" | "preparing" | "ready" | "activating" | "failed";
  candidateId: string | null;
  candidatePath: string | null;
  preparedAt: number | null;
  message: string | null;
  history: UpdateRecord[];
}

export interface AgentSnapshot {
  projectPath: string | null;
  projectName: string | null;
  sessionId: string | null;
  sessionFile: string | null;
  sessionTitle: string | null;
  sessions: SessionSummary[];
  messages: ConversationMessage[];
  tools: ToolActivity[];
  timeline: ConversationItem[];
  models: ModelOption[];
  selectedModel: string | null;
  thinkingLevel: ThinkingLevel;
  thinkingLevels: ThinkingLevel[];
  isStreaming: boolean;
  pendingCount: number;
  error: string | null;
  history: WorkspaceHistoryState;
  validation: ValidationState;
  review: ChangeReview;
  candidate: CandidateState;
  context: ContextState;
  policy: RuntimePolicy;
}

export type AgentEvent =
  | { type: "snapshot"; snapshot: AgentSnapshot }
  | { type: "assistant-delta"; delta: string }
  | { type: "message"; message: ConversationMessage }
  | { type: "tool"; tool: ToolActivity }
  | { type: "timeline-upsert"; item: ConversationItem }
  | { type: "context"; context: ContextState }
  | { type: "state"; patch: Partial<Pick<AgentSnapshot, "isStreaming" | "pendingCount" | "selectedModel" | "thinkingLevel" | "thinkingLevels" | "error">> }
  | { type: "sessions"; sessions: SessionSummary[] }
  | { type: "history"; history: WorkspaceHistoryState; editorText?: string; editorImages?: ImageAttachment[]; notice?: string }
  | { type: "validation"; validation: ValidationState }
  | { type: "review"; review: ChangeReview }
  | { type: "candidate"; candidate: CandidateState }
  | { type: "notice"; message: string }
  | { type: "error"; message: string };

export interface DesktopApi {
  chooseProject(): Promise<string | null>;
  openProject(path: string): Promise<AgentSnapshot>;
  getSnapshot(): Promise<AgentSnapshot>;
  newSession(): Promise<AgentSnapshot>;
  switchSession(path: string): Promise<AgentSnapshot>;
  prompt(message: string, images?: ImageAttachment[]): Promise<void>;
  stop(): Promise<void>;
  setModel(provider: string, modelId: string): Promise<void>;
  setThinkingLevel(level: ThinkingLevel): Promise<void>;
  createCheckpoint(label?: string): Promise<HistoryOperationResult>;
  undo(): Promise<HistoryOperationResult>;
  redo(): Promise<HistoryOperationResult>;
  runValidation(): Promise<ValidationState>;
  stopValidation(): Promise<void>;
  getReview(): Promise<ChangeReview>;
  rejectReviewFile(path: string): Promise<ChangeReview>;
  prepareCandidate(): Promise<CandidateState>;
  activateCandidate(): Promise<void>;
  rendererReady(): Promise<void>;
  compact(): Promise<void>;
  cancelCompact(): Promise<void>;
  subscribe(listener: (event: AgentEvent) => void): () => void;
}
