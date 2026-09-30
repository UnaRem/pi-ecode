import { Save } from "lucide-react";
import { useEffect, useState, type Dispatch, type SetStateAction } from "react";
import type { ProjectAgentDefinition, SetAllProjectAgentPreferencesRequest } from "@shared/agent-contracts";
import type { ModelOption, ThinkingLevel } from "@shared/contracts";
import { useI18n } from "../i18n/i18n";

const THINKING_LEVELS: ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

export function AgentBulkPreferences({ agents, models, saving, setSaving, setDraft, onSetAllPreferences }: {
  agents: ProjectAgentDefinition[];
  models: ModelOption[];
  saving: boolean;
  setSaving: Dispatch<SetStateAction<boolean>>;
  setDraft: Dispatch<SetStateAction<ProjectAgentDefinition | null>>;
  onSetAllPreferences: (request: SetAllProjectAgentPreferencesRequest) => Promise<void>;
}) {
  const { t } = useI18n();
  const modelValues = agents.map((agent) => agent.model.mode === "inherit" ? "inherit" : `${agent.model.provider}/${agent.model.modelId}`);
  const commonModel = new Set(modelValues).size === 1 ? modelValues[0]! : "";
  const commonThinking = new Set(agents.map((agent) => agent.thinkingLevel)).size === 1 ? agents[0]!.thinkingLevel : "";
  const [selectedModel, setSelectedModel] = useState(commonModel);
  const [thinkingLevel, setThinkingLevel] = useState<ThinkingLevel | "">(commonThinking);
  // 按字段同步共同值，避免另一字段的持久化变化覆盖尚未应用的批量草稿。
  useEffect(() => {
    setSelectedModel(commonModel);
  }, [commonModel]);
  useEffect(() => {
    setThinkingLevel(commonThinking);
  }, [commonThinking]);
  const [status, setStatus] = useState("");
  const apply = async (): Promise<void> => {
    if (saving || !selectedModel || !thinkingLevel || agents.length === 0) return;
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
    <strong>{t("agent.all.title")} · {agents.length}</strong>
    <div className="agent-manager-all-fields">
      <label><span>{t("agent.model")}</span><select value={selectedModel} disabled={saving} onChange={(event) => { setSelectedModel(event.target.value); setStatus(""); }}><option value="" disabled>{t("agent.all.mixed")}</option><option value="inherit">{t("agent.model.inherit")}</option>{selectedModel && selectedModel !== "inherit" && !models.some((model) => `${model.provider}/${model.id}` === selectedModel) && <option value={selectedModel}>{selectedModel}</option>}{models.map((model) => <option key={`${model.provider}/${model.id}`} value={`${model.provider}/${model.id}`}>{model.name} · {model.provider}</option>)}</select></label>
      <label><span>{t("agent.thinking")}</span><select value={thinkingLevel} disabled={saving} onChange={(event) => { setThinkingLevel(event.target.value as ThinkingLevel); setStatus(""); }}><option value="" disabled>{t("agent.all.mixed")}</option>{THINKING_LEVELS.map((level) => <option value={level} key={level}>{level}</option>)}</select></label>
    </div>
    <button type="button" disabled={saving || !selectedModel || !thinkingLevel || agents.length === 0} onClick={() => void apply()}><Save size={12} />{t("agent.all.apply")}</button>
    <small>{t("agent.all.help")}</small>
    {status && <p role="status">{status}</p>}
  </section>;
}
