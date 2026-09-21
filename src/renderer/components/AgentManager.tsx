import { ArrowLeft, Plus, Save, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import type { AgentRole, CreateProjectAgentRequest, ProjectAgentCatalog, ProjectAgentDefinition } from "@shared/agent-contracts";
import type { ModelOption, ThinkingLevel } from "@shared/contracts";
import { useI18n } from "../i18n/i18n";

const ROLES: AgentRole[] = ["explorer", "validator", "reviewer", "editor"];
const THINKING_LEVELS: ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
const TOOLS = ["read", "ffgrep", "fffind", "run_validation", "edit", "write"];

export function AgentManager({
  catalog,
  models,
  onBack,
  onSave,
  onCreate,
  onRemove,
  onSetConcurrency,
}: {
  catalog: ProjectAgentCatalog;
  models: ModelOption[];
  onBack: () => void;
  onSave: (agent: ProjectAgentDefinition) => Promise<void>;
  onCreate: (request: CreateProjectAgentRequest) => Promise<void>;
  onRemove: (agentId: string) => Promise<void>;
  onSetConcurrency: (value: number) => Promise<void>;
}) {
  const { t } = useI18n();
  const [selectedId, setSelectedId] = useState(catalog.agents[0]?.id ?? null);
  const selected = catalog.agents.find((agent) => agent.id === selectedId) ?? catalog.agents[0] ?? null;
  const [draft, setDraft] = useState<ProjectAgentDefinition | null>(() => selected ? structuredClone(selected) : null);
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    if (selected) setDraft(structuredClone(selected));
  }, [selected?.id, selected?.updatedAt]);

  const update = (patch: Partial<ProjectAgentDefinition>): void => {
    setDraft((current) => current ? { ...current, ...patch } : current);
  };
  const modelValue = draft?.model.mode === "fixed" ? `${draft.model.provider}/${draft.model.modelId}` : "inherit";
  const save = async (): Promise<void> => {
    if (!draft || saving) return;
    setSaving(true);
    try { await onSave(draft); } finally { setSaving(false); }
  };
  const add = async (): Promise<void> => {
    if (saving) return;
    setSaving(true);
    try { await onCreate({ name: `${t("agent.role.explorer")} ${catalog.agents.length + 1}`, role: "explorer" }); }
    finally { setSaving(false); }
  };

  return <section className="agent-manager" aria-label={t("agent.manage")}>
    <header className="agent-manager-header">
      <button type="button" onClick={onBack}><ArrowLeft size={13} />{t("agent.back")}</button>
      <strong>{t("agent.manage")}</strong>
    </header>
    <label className="agent-manager-concurrency">
      <span>{t("agent.concurrent")}</span>
      <select value={catalog.maxConcurrent} disabled={saving} onChange={(event) => void onSetConcurrency(Number(event.target.value))}>
        {[1, 2, 3, 4, 5, 6, 7].map((value) => <option value={value} key={value}>{value}</option>)}
      </select>
    </label>
    <div className="agent-definition-list">
      {catalog.agents.map((agent) => <button type="button" key={agent.id} className={agent.id === selected?.id ? "selected" : ""} onClick={() => setSelectedId(agent.id)}>
        <strong>{agent.name}</strong><small>{t(`agent.role.${agent.role}`)}</small>
      </button>)}
      <button type="button" className="agent-add" disabled={saving} onClick={() => void add()}><Plus size={12} />{t("agent.add")}</button>
    </div>
    {draft && <form className="agent-editor" onSubmit={(event) => { event.preventDefault(); void save(); }}>
      <label><span>{t("agent.name")}</span><input value={draft.name} maxLength={80} onChange={(event) => update({ name: event.target.value })} /></label>
      <label><span>{t("agent.role")}</span><select value={draft.role} onChange={(event) => update({ role: event.target.value as AgentRole })}>{ROLES.map((role) => <option key={role} value={role}>{t(`agent.role.${role}`)}</option>)}</select></label>
      <label className="agent-check"><input type="checkbox" checked={draft.enabled} onChange={(event) => update({ enabled: event.target.checked })} /><span>{t("agent.enabled")}</span></label>
      <label><span>{t("agent.model")}</span><select value={modelValue} onChange={(event) => {
        if (event.target.value === "inherit") update({ model: { mode: "inherit" } });
        else {
          const separator = event.target.value.indexOf("/");
          update({ model: { mode: "fixed", provider: event.target.value.slice(0, separator), modelId: event.target.value.slice(separator + 1) } });
        }
      }}><option value="inherit">{t("agent.model.inherit")}</option>{models.map((model) => <option key={`${model.provider}/${model.id}`} value={`${model.provider}/${model.id}`}>{model.name} · {model.provider}</option>)}</select></label>
      <label><span>{t("agent.thinking")}</span><select value={draft.thinkingLevel} onChange={(event) => update({ thinkingLevel: event.target.value as ThinkingLevel })}>{THINKING_LEVELS.map((level) => <option value={level} key={level}>{level}</option>)}</select></label>
      <fieldset><legend>{t("agent.compaction")}</legend>
        <label className="agent-check"><input type="checkbox" checked={draft.autoCompaction.enabled} onChange={(event) => update({ autoCompaction: { ...draft.autoCompaction, enabled: event.target.checked } })} /><span>{t("agent.compaction")}</span></label>
        <label><span>{t("agent.compaction.inherit")}</span><select value={draft.autoCompaction.thresholdPercent ?? "inherit"} disabled={!draft.autoCompaction.enabled} onChange={(event) => update({ autoCompaction: { ...draft.autoCompaction, thresholdPercent: event.target.value === "inherit" ? null : Number(event.target.value) } })}><option value="inherit">{t("agent.compaction.inherit")}</option>{[50, 60, 70, 80, 90].map((value) => <option value={value} key={value}>{value}%</option>)}</select></label>
      </fieldset>
      <label><span>{t("agent.prompt")}</span><textarea rows={8} value={draft.prompt} maxLength={20_000} onChange={(event) => update({ prompt: event.target.value })} /></label>
      <fieldset><legend>{t("agent.tools")}</legend><small>{t("agent.tools.help")}</small><div className="agent-tool-grid">{TOOLS.map((tool) => <label className="agent-check" key={tool}><input type="checkbox" checked={draft.disabledTools.includes(tool)} onChange={(event) => update({ disabledTools: event.target.checked ? [...draft.disabledTools, tool] : draft.disabledTools.filter((name) => name !== tool) })} /><code>{tool}</code></label>)}</div></fieldset>
      <div className="agent-editor-actions">
        {!draft.builtIn && <button type="button" className="danger" disabled={saving} onClick={() => void onRemove(draft.id)}><Trash2 size={12} />{t("agent.delete")}</button>}
        <button type="submit" disabled={saving || !draft.name.trim() || !draft.prompt.trim()}><Save size={12} />{t("agent.save")}</button>
      </div>
    </form>}
  </section>;
}
