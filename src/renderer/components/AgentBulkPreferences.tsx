import { useState, type Dispatch, type SetStateAction } from "react";
import type { ProjectAgentDefinition, SetAllProjectAgentPreferencesRequest } from "@shared/agent-contracts";
import type { ModelOption, ThinkingLevel } from "@shared/contracts";
import { useI18n } from "../i18n/i18n";

const THINKING_LEVELS: ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

export function AgentBulkPreferences({ count, models, saving, setSaving, setDraft, onSetAllPreferences }: {
  count: number;
  models: ModelOption[];
  saving: boolean;
  setSaving: Dispatch<SetStateAction<boolean>>;
  setDraft: Dispatch<SetStateAction<ProjectAgentDefinition | null>>;
  onSetAllPreferences: (request: SetAllProjectAgentPreferencesRequest) => Promise<void>;
}) {
  const { t } = useI18n();
  const [selectedModel, setSelectedModel] = useState("inherit");
  const [thinkingLevel, setThinkingLevel] = useState<ThinkingLevel>("low");
  const [status, setStatus] = useState("");
  const apply = async (): Promise<void> => {
    if (saving) return;
    const separator = selectedModel.indexOf("/");
    const model: SetAllProjectAgentPreferencesRequest["model"] = selectedModel === "inherit"
      ? { mode: "inherit" }
      : { mode: "fixed", provider: selectedModel.slice(0, separator), modelId: selectedModel.slice(separator + 1) };
    setSaving(true);
    setStatus("");
    try {
      await onSetAllPreferences({ model, thinkingLevel });
      setDraft((current) => current ? { ...current, model: structuredClone(model), thinkingLevel } : current);
      setStatus(t("agent.all.saved"));
    } catch (error) {
      setStatus(`${t("agent.all.failed")}: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setSaving(false);
    }
  };
  return <section className="agent-manager-all" aria-label={t("agent.all.title")}>
    <strong>{t("agent.all.title")} · {count}</strong>
    <div className="agent-manager-all-fields">
      <label><span>{t("agent.model")}</span><select value={selectedModel} disabled={saving} onChange={(event) => { setSelectedModel(event.target.value); setStatus(""); }}><option value="inherit">{t("agent.model.inherit")}</option>{models.map((model) => <option key={`${model.provider}/${model.id}`} value={`${model.provider}/${model.id}`}>{model.name} · {model.provider}</option>)}</select></label>
      <label><span>{t("agent.thinking")}</span><select value={thinkingLevel} disabled={saving} onChange={(event) => { setThinkingLevel(event.target.value as ThinkingLevel); setStatus(""); }}>{THINKING_LEVELS.map((level) => <option value={level} key={level}>{level}</option>)}</select></label>
    </div>
    <button type="button" disabled={saving} onClick={() => void apply()}>{t("agent.all.apply")}</button>
    <small>{t("agent.all.help")}</small>
    {status && <p role="status">{status}</p>}
  </section>;
}
