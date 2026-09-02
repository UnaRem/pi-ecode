import { BookmarkPlus, ChevronDown, LoaderCircle, PanelLeftOpen, ShieldCheck } from "lucide-react";
import type { ModelOption, RuntimePolicy, ThinkingLevel, ValidationState, WorkspaceHistoryState } from "@shared/contracts";
import { useI18n } from "../i18n/i18n";
import type { MessageKey } from "../i18n/messages";

const THINKING_KEYS: Record<ThinkingLevel, MessageKey> = {
  off: "thinking.off",
  minimal: "thinking.minimal",
  low: "thinking.low",
  medium: "thinking.medium",
  high: "thinking.high",
  xhigh: "thinking.xhigh",
  max: "thinking.max",
};

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
  onToggleValidation: () => void;
}

export function Topbar(props: TopbarProps) {
  const { t } = useI18n();
  return (
    <header className="topbar">
      <div className="topbar-title">
        {!props.sidebarOpen && (
          <button className="icon-button" onClick={props.onOpenSidebar} aria-label={t("topbar.openSidebar")}>
            <PanelLeftOpen size={18} />
          </button>
        )}
        <strong>{props.sessionTitle || t("topbar.newThread")}</strong>
        <span>/</span>
        <small>{props.projectName}</small>
        <span
          className={`policy-indicator ${props.policy.contextFiles.length > 0 ? "loaded" : "missing"}`}
          title={props.policy.contextFiles.length > 0
            ? t("topbar.loadedContext", { files: props.policy.contextFiles.join("\n") })
            : t("topbar.noContext")}
        >
          {props.policy.contextFiles.length > 0 ? t("topbar.contextLoaded") : t("topbar.noPrompt")}
        </span>
      </div>
      <div className="topbar-controls">
        <button
          className={`validation-toggle ${props.validation.status}`}
          onClick={props.onToggleValidation}
          aria-label={t("topbar.openVerification")}
          title={t("topbar.projectVerification")}
        >
          {props.validation.status === "running"
            ? <LoaderCircle className="spin" size={15} />
            : <ShieldCheck size={15} />}
          <span>{props.validation.status === "passed" ? t("topbar.verified") : props.validation.status === "stale" ? t("topbar.stale") : t("topbar.verify")}</span>
        </button>
        <div className="history-controls" aria-label={t("topbar.workspaceHistory")}>
          <button
            className="icon-button"
            onClick={props.onCheckpoint}
            disabled={props.disabled || props.history.isBusy || !props.history.available}
            aria-label={t("topbar.checkpoint")}
            title={t("topbar.checkpoint")}
          >
            <BookmarkPlus size={16} />
          </button>
        </div>
        <label className="select-shell">
          <span className="sr-only">{t("topbar.model")}</span>
          <select
            value={props.selectedModel ?? ""}
            disabled={props.disabled || props.models.length === 0}
            onChange={(event) => props.onSetModel(event.target.value)}
          >
            {props.models.length === 0 && <option value="">{t("topbar.noModel")}</option>}
            {props.models.map((model) => (
              <option key={`${model.provider}/${model.id}`} value={`${model.provider}/${model.id}`}>
                {model.name}
              </option>
            ))}
          </select>
          <ChevronDown size={14} aria-hidden="true" />
        </label>
        <label className="select-shell thinking-select">
          <span className="sr-only">{t("topbar.thinking")}</span>
          <select
            value={props.thinkingLevel}
            disabled={props.disabled || props.thinkingLevels.length <= 1}
            onChange={(event) => props.onSetThinking(event.target.value as ThinkingLevel)}
          >
            {props.thinkingLevels.map((level) => (
              <option key={level} value={level}>{level === "off"
                ? t("topbar.noThinking")
                : t("topbar.thinkingValue", { level: t(THINKING_KEYS[level]) })}</option>
            ))}
          </select>
          <ChevronDown size={14} aria-hidden="true" />
        </label>
      </div>
    </header>
  );
}
