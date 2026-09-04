import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { LoaderCircle, PanelLeftOpen, Pencil, ShieldCheck } from "lucide-react";
import type { ModelOption, RuntimePolicy, ThinkingLevel, ValidationState } from "@shared/contracts";
import { useI18n } from "../i18n/i18n";
import { GitPushButton } from "./GitPushButton";
import { TopbarSelect, type TopbarSelectOption } from "./TopbarSelect";

interface TopbarProps {
  sidebarOpen: boolean;
  projectName: string;
  projectPath: string;
  sessionTitle: string | null;
  models: ModelOption[];
  selectedModel: string | null;
  thinkingLevel: ThinkingLevel;
  thinkingLevels: ThinkingLevel[];
  disabled: boolean;
  validation: ValidationState;
  policy: RuntimePolicy;
  onOpenSidebar: () => void;
  onRenameSession: (title: string) => void;
  onSetModel: (value: string) => void;
  onSetThinking: (value: ThinkingLevel) => void;
  onToggleValidation: () => void;
}

export function normalizeSessionTitle(title: string): string {
  return title.replace(/\s+/gu, " ").trim().slice(0, 80);
}

export function thinkingSelectOptions(levels: ThinkingLevel[]): TopbarSelectOption[] {
  return levels.map((level) => ({ value: level, label: level }));
}

function SessionTitleEditor(props: { title: string; onRename: (title: string) => void }) {
  const { t } = useI18n();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(props.title);
  const inputRef = useRef<HTMLInputElement>(null);
  const cancelledRef = useRef(false);

  useEffect(() => {
    if (!editing) setDraft(props.title);
    else requestAnimationFrame(() => inputRef.current?.select());
  }, [editing, props.title]);

  const finish = (): void => {
    setEditing(false);
    if (cancelledRef.current) {
      cancelledRef.current = false;
      setDraft(props.title);
      return;
    }
    const normalizedTitle = normalizeSessionTitle(draft);
    if (normalizedTitle !== props.title) props.onRename(normalizedTitle);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === "Enter") event.currentTarget.blur();
    if (event.key !== "Escape") return;
    cancelledRef.current = true;
    event.currentTarget.blur();
  };

  if (editing) return <input ref={inputRef} className="session-title-input" value={draft} maxLength={80} onChange={(event) => setDraft(event.target.value)} onBlur={finish} onKeyDown={onKeyDown} aria-label={t("topbar.renameSession")} />;
  return (
    <span className="session-title-display">
      <strong title={props.title}>{props.title}</strong>
      <button onClick={() => setEditing(true)} aria-label={t("topbar.renameSession")} title={t("topbar.renameSession")}><Pencil size={12} /></button>
    </span>
  );
}

export function Topbar(props: TopbarProps) {
  const { t } = useI18n();
  const modelSeparator = props.selectedModel?.indexOf("/") ?? -1;
  const selectedProvider = modelSeparator > 0 ? props.selectedModel?.slice(0, modelSeparator) ?? "" : props.models[0]?.provider ?? "";
  const providers = [...new Set(props.models.map((model) => model.provider))];
  const providerModels = props.models.filter((model) => model.provider === selectedProvider);
  const providerOptions = providers.map((provider) => ({ value: provider, label: provider }));
  const modelOptions = providerModels.map((model) => ({ value: `${model.provider}/${model.id}`, label: model.name }));
  const thinkingOptions = thinkingSelectOptions(props.thinkingLevels);
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
        <SessionTitleEditor title={props.sessionTitle || t("topbar.newThread")} onRename={props.onRenameSession} />
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
        <GitPushButton projectKey={props.projectPath} disabled={props.disabled} validationStatus={props.validation.status} />
        <TopbarSelect
          className="provider-select"
          label={t("topbar.provider")}
          value={selectedProvider}
          options={providerOptions}
          disabled={props.disabled || providerOptions.length === 0}
          placeholder={t("topbar.noModel")}
          onChange={selectProvider}
        />
        <TopbarSelect
          className="model-select"
          label={t("topbar.model")}
          value={props.selectedModel ?? ""}
          options={modelOptions}
          disabled={props.disabled || modelOptions.length === 0}
          placeholder={t("topbar.noModel")}
          onChange={props.onSetModel}
        />
        <TopbarSelect
          className="thinking-select"
          label={t("topbar.thinking")}
          value={props.thinkingLevel}
          options={thinkingOptions}
          disabled={props.disabled || thinkingOptions.length <= 1}
          onChange={(value) => props.onSetThinking(value as ThinkingLevel)}
        />
      </div>
    </header>
  );
}
