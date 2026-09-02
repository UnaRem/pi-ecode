import { ChevronDown, LoaderCircle, PanelLeftOpen, ShieldCheck } from "lucide-react";
import type { ModelOption, RuntimePolicy, ThinkingLevel, ValidationState } from "@shared/contracts";
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
  validation: ValidationState;
  policy: RuntimePolicy;
  onOpenSidebar: () => void;
  onSetModel: (value: string) => void;
  onSetThinking: (value: ThinkingLevel) => void;
  onToggleValidation: () => void;
}

export function Topbar(props: TopbarProps) {
  const { t } = useI18n();
  const modelSeparator = props.selectedModel?.indexOf("/") ?? -1;
  const selectedProvider = modelSeparator > 0 ? props.selectedModel?.slice(0, modelSeparator) ?? "" : props.models[0]?.provider ?? "";
  const providers = [...new Set(props.models.map((model) => model.provider))];
  const providerModels = props.models.filter((model) => model.provider === selectedProvider);
  const selectProvider = (provider: string): void => {
    const model = props.models.find((option) => option.provider === provider);
    if (model) props.onSetModel(`${model.provider}/${model.id}`);
  };
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
        <label className="select-shell provider-select">
          <span className="sr-only">{t("topbar.provider")}</span>
          <select value={selectedProvider} disabled={props.disabled || providers.length === 0} onChange={(event) => selectProvider(event.target.value)}>
            {providers.length === 0 && <option value="">{t("topbar.noModel")}</option>}
            {providers.map((provider) => <option key={provider} value={provider}>{provider}</option>)}
          </select>
          <ChevronDown size={14} aria-hidden="true" />
        </label>
        <label className="select-shell model-select">
          <span className="sr-only">{t("topbar.model")}</span>
          <select value={props.selectedModel ?? ""} disabled={props.disabled || providerModels.length === 0} onChange={(event) => props.onSetModel(event.target.value)}>
            {providerModels.map((model) => (
              <option key={`${model.provider}/${model.id}`} value={`${model.provider}/${model.id}`}>{model.name}</option>
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
