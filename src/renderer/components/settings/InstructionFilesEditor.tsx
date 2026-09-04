import { FileText, Globe2, Save, Undo2 } from "lucide-react";
import { useEffect, useState } from "react";
import type {
  InstructionFileDocument,
  InstructionFileTarget,
  SaveInstructionFileRequest,
  SettingsSnapshot,
} from "@shared/settings-contracts";
import { useI18n } from "../../i18n/i18n";

interface InstructionFilesEditorProps {
  documents: Record<InstructionFileTarget, InstructionFileDocument>;
  loading: boolean;
  onDirtyChange: (dirty: boolean) => void;
  onSave: (request: SaveInstructionFileRequest) => Promise<SettingsSnapshot | undefined>;
}

const FILE_TARGETS: InstructionFileTarget[] = ["project-agents", "global-append-system"];

function InstructionFileTabs(props: { target: InstructionFileTarget; onChange: (target: InstructionFileTarget) => void }) {
  const { t } = useI18n();
  return (
    <div className="instruction-file-tabs" role="tablist" aria-label={t("settings.instructions")}>
      {FILE_TARGETS.map((fileTarget) => (
        <button
          key={fileTarget}
          className={fileTarget === props.target ? "active" : ""}
          role="tab"
          aria-selected={fileTarget === props.target}
          onClick={() => props.onChange(fileTarget)}
        >
          {fileTarget === "project-agents" ? <FileText size={14} /> : <Globe2 size={14} />}
          {fileTarget === "project-agents" ? t("settings.projectAgents") : t("settings.globalAppendSystem")}
        </button>
      ))}
    </div>
  );
}

export function InstructionFilesEditor(props: InstructionFilesEditorProps) {
  const { t } = useI18n();
  const [target, setTarget] = useState<InstructionFileTarget>("project-agents");
  const [draft, setDraft] = useState(() => props.documents["project-agents"].content);
  const [baseRevision, setBaseRevision] = useState<string | null>(() => props.documents["project-agents"].revision);
  const [dirty, setDirty] = useState(false);
  const [externalChange, setExternalChange] = useState(false);
  const document = props.documents[target];

  useEffect(() => {
    props.onDirtyChange(dirty);
    return () => props.onDirtyChange(false);
  }, [dirty, props.onDirtyChange]);

  useEffect(() => {
    if (dirty && document.revision !== baseRevision) {
      setExternalChange(true);
      return;
    }
    if (!dirty) {
      setDraft(document.content);
      setBaseRevision(document.revision);
      setExternalChange(false);
    }
  }, [baseRevision, dirty, document]);

  const reset = (): void => {
    setDraft(document.content);
    setBaseRevision(document.revision);
    setDirty(false);
    setExternalChange(false);
  };

  const changeTarget = (nextTarget: InstructionFileTarget): void => {
    if (nextTarget === target) return;
    if (dirty && !window.confirm(t("settings.confirmDiscard"))) return;
    setDirty(false);
    setExternalChange(false);
    setTarget(nextTarget);
  };

  const save = async (): Promise<void> => {
    const next = await props.onSave({ target, content: draft, expectedRevision: baseRevision });
    if (!next) return;
    const saved = next.instructionFiles[target];
    setDraft(saved.content);
    setBaseRevision(saved.revision);
    setDirty(false);
    setExternalChange(false);
  };

  return (
    <div className="instruction-files-editor">
      <InstructionFileTabs target={target} onChange={changeTarget} />
      <section className="instruction-file-card">
        <header>
          <div>
            <strong>{target === "project-agents" ? t("settings.projectAgents") : t("settings.globalAppendSystem")}</strong>
            <code title={document.path}>{document.path}</code>
          </div>
          <span className={document.exists ? "exists" : "missing"}>
            {document.exists ? t("settings.fileExists") : t("settings.fileMissing")}
          </span>
        </header>
        {document.error && <div className="settings-error">{document.error}</div>}
        {externalChange && (
          <div className="settings-conflict">
            {t("settings.externalChanged")}<button onClick={reset}>{t("settings.loadDisk")}</button>
          </div>
        )}
        <p>{target === "project-agents" ? t("settings.projectAgentsHint") : t("settings.globalAppendSystemHint")}</p>
        <textarea
          value={draft}
          maxLength={1_000_000}
          disabled={props.loading || Boolean(document.error)}
          aria-label={target === "project-agents" ? t("settings.projectAgents") : t("settings.globalAppendSystem")}
          spellCheck={false}
          onChange={(event) => { setDraft(event.target.value); setDirty(true); }}
        />
      </section>
      <footer className="instruction-file-actions">
        <span>{dirty ? t("settings.unsaved") : t("settings.synced")}</span>
        <button onClick={reset} disabled={!dirty || props.loading}><Undo2 size={14} />{t("settings.discard")}</button>
        <button className="primary" onClick={() => void save()} disabled={!dirty || props.loading || externalChange || Boolean(document.error)}>
          <Save size={14} />{t("settings.save")}
        </button>
      </footer>
    </div>
  );
}
