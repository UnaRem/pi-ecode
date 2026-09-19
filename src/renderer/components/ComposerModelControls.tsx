import type { ModelOption, ThinkingLevel } from "@shared/contracts";
import { useI18n } from "../i18n/i18n";
import { TopbarSelect, type TopbarSelectOption } from "./TopbarSelect";

export function thinkingSelectOptions(levels: ThinkingLevel[]): TopbarSelectOption[] {
  return levels.map((level) => ({ value: level, label: level }));
}

interface ComposerModelControlsProps {
  models: ModelOption[];
  selectedModel: string | null;
  thinkingLevel: ThinkingLevel;
  thinkingLevels: ThinkingLevel[];
  disabled: boolean;
  onSetModel: (value: string) => void;
  onSetThinking: (value: ThinkingLevel) => void;
}

export function ComposerModelControls(props: ComposerModelControlsProps) {
  const { t } = useI18n();
  const separator = props.selectedModel?.indexOf("/") ?? -1;
  const selectedProvider = separator > 0
    ? props.selectedModel?.slice(0, separator) ?? ""
    : props.models[0]?.provider ?? "";
  const providers = [...new Set(props.models.map((model) => model.provider))];
  const providerModels = props.models.filter((model) => model.provider === selectedProvider);
  const providerOptions = providers.map((provider) => ({ value: provider, label: provider }));
  const modelOptions = providerModels.map((model) => ({ value: `${model.provider}/${model.id}`, label: model.name }));
  const selectProvider = (provider: string): void => {
    const model = props.models.find((option) => option.provider === provider);
    if (model) props.onSetModel(`${model.provider}/${model.id}`);
  };

  return (
    <div className="composer-model-controls">
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
        options={thinkingSelectOptions(props.thinkingLevels)}
        disabled={props.disabled || props.thinkingLevels.length <= 1}
        onChange={(value) => props.onSetThinking(value as ThinkingLevel)}
      />
    </div>
  );
}
