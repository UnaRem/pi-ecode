import { BookmarkPlus, ChevronDown, LoaderCircle, PanelLeftOpen, Redo2, ShieldCheck, Undo2 } from "lucide-react";
import type { ModelOption, RuntimePolicy, ThinkingLevel, ValidationState, WorkspaceHistoryState } from "@shared/contracts";

interface TopbarProps {
  sidebarOpen: boolean;
  projectName: string;
  sessionTitle: string | null;
  models: ModelOption[];
  selectedModel: string | null;
  thinkingLevel: ThinkingLevel;
  thinkingLevels: ThinkingLevel[];
  disabled: boolean;
  history: WorkspaceHistoryState;
  validation: ValidationState;
  policy: RuntimePolicy;
  onOpenSidebar: () => void;
  onSetModel: (value: string) => void;
  onSetThinking: (value: ThinkingLevel) => void;
  onCheckpoint: () => void;
  onUndo: () => void;
  onRedo: () => void;
  onToggleValidation: () => void;
}

export function Topbar(props: TopbarProps) {
  return (
    <header className="topbar">
      <div className="topbar-title">
        {!props.sidebarOpen && (
          <button className="icon-button" onClick={props.onOpenSidebar} aria-label="Open sidebar">
            <PanelLeftOpen size={18} />
          </button>
        )}
        <strong>{props.sessionTitle || "New thread"}</strong>
        <span>/</span>
        <small>{props.projectName}</small>
        <span
          className={`policy-indicator ${props.policy.contextFiles.length > 0 ? "loaded" : "missing"}`}
          title={props.policy.contextFiles.length > 0
            ? `Loaded context:\n${props.policy.contextFiles.join("\n")}\nWorkflow: manual review\nGit commits: required after verification`
            : "No AGENTS.md context loaded"}
        >
          {props.policy.contextFiles.length > 0 ? "AGENTS loaded" : "No project prompt"}
        </span>
      </div>
      <div className="topbar-controls">
        <button
          className={`validation-toggle ${props.validation.status}`}
          onClick={props.onToggleValidation}
          aria-label="Open verification panel"
          title="Project verification"
        >
          {props.validation.status === "running"
            ? <LoaderCircle className="spin" size={15} />
            : <ShieldCheck size={15} />}
          <span>{props.validation.status === "passed" ? "Verified" : props.validation.status === "stale" ? "Stale" : "Verify"}</span>
        </button>
        <div className="history-controls" aria-label="Workspace history">
          <button
            className="icon-button"
            onClick={props.onCheckpoint}
            disabled={props.disabled || props.history.isBusy || !props.history.available}
            aria-label="Create workspace checkpoint"
            title="Create workspace checkpoint"
          >
            <BookmarkPlus size={16} />
          </button>
          <button
            className="icon-button"
            onClick={props.onUndo}
            disabled={props.disabled || props.history.isBusy || !props.history.canUndo}
            aria-label="Undo last agent turn"
            title="Undo last agent turn"
          >
            <Undo2 size={16} />
          </button>
          <button
            className="icon-button"
            onClick={props.onRedo}
            disabled={props.disabled || props.history.isBusy || !props.history.canRedo}
            aria-label="Redo agent turn"
            title="Redo agent turn"
          >
            <Redo2 size={16} />
          </button>
        </div>
        <label className="select-shell">
          <span className="sr-only">Model</span>
          <select
            value={props.selectedModel ?? ""}
            disabled={props.disabled || props.models.length === 0}
            onChange={(event) => props.onSetModel(event.target.value)}
          >
            {props.models.length === 0 && <option value="">No configured model</option>}
            {props.models.map((model) => (
              <option key={`${model.provider}/${model.id}`} value={`${model.provider}/${model.id}`}>
                {model.name}
              </option>
            ))}
          </select>
          <ChevronDown size={14} aria-hidden="true" />
        </label>
        <label className="select-shell thinking-select">
          <span className="sr-only">Thinking level</span>
          <select
            value={props.thinkingLevel}
            disabled={props.disabled || props.thinkingLevels.length <= 1}
            onChange={(event) => props.onSetThinking(event.target.value as ThinkingLevel)}
          >
            {props.thinkingLevels.map((level) => (
              <option key={level} value={level}>{level === "off" ? "No thinking" : `${level} thinking`}</option>
            ))}
          </select>
          <ChevronDown size={14} aria-hidden="true" />
        </label>
      </div>
    </header>
  );
}
