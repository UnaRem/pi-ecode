import { ArrowLeft, LoaderCircle, RefreshCw, Save, Settings2, Undo2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { ConfigDocument, ConfigTarget, JsonObject } from "@shared/settings-contracts";
import { useSettings } from "../../hooks/use-settings";
import { useI18n, type Translate, type UiLanguage } from "../../i18n/i18n";
import { GeneralSettingsForm } from "./GeneralSettingsForm";
import { ModelsSettingsForm } from "./ModelsSettingsForm";
import { AuthSettingsPanel } from "./AuthSettingsPanel";
import { FffSettingsForm } from "./FffSettingsForm";
import { InstructionFilesEditor } from "./InstructionFilesEditor";

type SettingsSection = ConfigTarget | "instructions" | "auth";

interface SettingsPageProps {
  onClose: () => void;
  onDirtyChange: (dirty: boolean) => void;
}

type SettingsController = ReturnType<typeof useSettings>;

function SettingsNavigation(props: { target: SettingsSection; effectiveCount: number; onChange: (target: SettingsSection) => void }) {
  const { language, setLanguage, t } = useI18n();
  const sections: Array<[SettingsSection, string]> = [
    ["global-settings", t("settings.global")],
    ["project-settings", t("settings.project")],
    ["models", t("settings.models")],
    ["instructions", t("settings.instructions")],
    ["auth", t("settings.auth")],
    ["pi-fff", t("settings.fff")],
  ];
  return (
    <nav className="settings-nav" aria-label={t("settings.category")}>
      {sections.map(([section, label]) => (
        <button key={section} className={props.target === section ? "active" : ""} onClick={() => props.onChange(section)}>
          <Settings2 size={14} /><span>{label}</span>
        </button>
      ))}
      <div className="settings-nav-note">{t("settings.effectiveCount", { count: props.effectiveCount })}</div>
      <label className="settings-language">
        <span>{t("sidebar.language")}</span>
        <select value={language} onChange={(event) => setLanguage(event.target.value as UiLanguage)}>
          <option value="zh-CN">{t("language.zh")}</option>
          <option value="en">{t("language.en")}</option>
        </select>
      </label>
    </nav>
  );
}

interface SettingsContentProps {
  target: SettingsSection;
  heading: string;
  document: ConfigDocument | null;
  draft: JsonObject;
  readOnly: boolean;
  externalChange: boolean;
  settings: SettingsController;
  onDraftChange: (value: JsonObject) => void;
  onDirtyChange: (dirty: boolean) => void;
  onReset: () => void;
}

function SettingsContent(props: SettingsContentProps) {
  const { t } = useI18n();
  const settingsTarget = props.target === "global-settings" || props.target === "project-settings";
  const settings = props.settings;
  return (
    <section className="settings-content">
      <div className="settings-content-title">
        <div><h2>{props.heading}</h2><code title={props.document?.path}>{props.document?.path}</code></div>
        {settings.snapshot?.pendingReload && <span className="settings-pending"><LoaderCircle className="spin" size={12} />{t("settings.pending")}</span>}
      </div>
      {settings.error && <div className="settings-error">{settings.error}</div>}
      {settings.snapshot?.error && <div className="settings-error">{settings.snapshot.error}</div>}
      {props.document?.error && !settings.snapshot?.error && <div className="settings-error">{props.document.error}</div>}
      {props.externalChange && <div className="settings-conflict">{t("settings.externalChanged")}<button onClick={props.onReset}>{t("settings.loadDisk")}</button></div>}
      {props.target === "auth" ? (
        <AuthSettingsPanel providers={settings.snapshot?.providers ?? []} flow={settings.authFlow} disabled={settings.loading} onLogin={(id, type) => void settings.login(id, type)} onLogout={(id) => void settings.logout(id)} onRespond={(response) => void settings.respondAuth(response)} onCancel={() => void settings.cancelAuth()} />
      ) : props.target === "instructions" && settings.snapshot ? (
        <InstructionFilesEditor
          documents={settings.snapshot.instructionFiles}
          loading={settings.loading}
          onDirtyChange={props.onDirtyChange}
          onSave={settings.saveInstructionFile}
        />
      ) : !props.document ? (
        <div className="settings-loading"><LoaderCircle className="spin" size={18} />{t("settings.loading")}</div>
      ) : settingsTarget ? (
        <GeneralSettingsForm value={props.draft} disabled={props.readOnly || settings.loading} readOnly={props.readOnly} onChange={props.onDraftChange} />
      ) : props.target === "models" ? (
        <ModelsSettingsForm value={props.draft} disabled={settings.loading} onChange={props.onDraftChange} />
      ) : (
        <FffSettingsForm value={props.draft} loaded={settings.snapshot?.fffLoaded ?? false} disabled={settings.loading} onChange={props.onDraftChange} />
      )}
    </section>
  );
}

function settingsHeading(target: SettingsSection, t: Translate): string {
  if (target === "global-settings") return t("settings.global");
  if (target === "project-settings") return t("settings.project");
  if (target === "models") return t("settings.models");
  if (target === "instructions") return t("settings.instructions");
  if (target === "auth") return t("settings.auth");
  return t("settings.fff");
}

function SettingsActions(props: { dirty: boolean; loading: boolean; canSave: boolean; onReset: () => void; onSave: () => void }) {
  const { t } = useI18n();
  return (
    <footer className="settings-actions">
      <span>{props.dirty ? t("settings.unsaved") : t("settings.synced")}</span>
      <button onClick={props.onReset} disabled={!props.dirty || props.loading}><Undo2 size={14} />{t("settings.discard")}</button>
      <button className="primary" onClick={props.onSave} disabled={!props.canSave}><Save size={14} />{t("settings.save")}</button>
    </footer>
  );
}

export function SettingsPage(props: SettingsPageProps) {
  const { t } = useI18n();
  const settings = useSettings(true);
  const [target, setTarget] = useState<SettingsSection>("global-settings");
  const [draft, setDraft] = useState<JsonObject>({});
  const [baseRevision, setBaseRevision] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [externalChange, setExternalChange] = useState(false);
  const document = target === "auth" || target === "instructions" ? null : settings.documentFor(target);

  useEffect(() => props.onDirtyChange(dirty), [dirty, props.onDirtyChange]);

  useEffect(() => {
    if (!document) return;
    if (dirty && document.revision !== baseRevision) {
      setExternalChange(true);
      return;
    }
    if (!dirty) {
      setDraft(structuredClone(document.value));
      setBaseRevision(document.revision);
      setExternalChange(false);
    }
  }, [baseRevision, dirty, document]);

  const readOnly = target === "project-settings" && !settings.snapshot?.projectTrusted;
  const canSave = target !== "auth" && target !== "instructions" && dirty && !readOnly && !settings.loading && !externalChange;
  const heading = settingsHeading(target, t);
  const effectiveCount = useMemo(() => Object.keys(settings.snapshot?.effectiveSettings ?? {}).length, [settings.snapshot]);

  const reset = (): void => {
    if (!document) return;
    setDraft(structuredClone(document.value));
    setBaseRevision(document.revision);
    setDirty(false);
    setExternalChange(false);
  };

  const changeTarget = (next: SettingsSection): void => {
    if (dirty && !window.confirm(t("settings.confirmDiscard"))) return;
    setDirty(false);
    setExternalChange(false);
    setTarget(next);
  };

  const close = (): void => props.onClose();

  const save = async (): Promise<void> => {
    if (target === "auth" || target === "instructions") return;
    const next = await settings.save({ target, value: draft, expectedRevision: baseRevision });
    if (!next) return;
    const saved = target === "global-settings"
      ? next.globalSettings
      : target === "project-settings" ? next.projectSettings : target === "models" ? next.models : next.fff;
    setDraft(structuredClone(saved.value));
    setBaseRevision(saved.revision);
    setDirty(false);
    setExternalChange(false);
  };

  return (
    <main className="settings-page">
      <header className="settings-header">
        <button className="icon-button" onClick={close} aria-label={t("settings.back")}><ArrowLeft size={18} /></button>
        <div><strong>{t("settings.title")}</strong><span>{t("settings.subtitle")}</span></div>
        <button className="settings-reload" onClick={() => void settings.load()} disabled={settings.loading}>
          <RefreshCw className={settings.loading ? "spin" : ""} size={14} />{t("settings.reload")}
        </button>
      </header>
      <div className="settings-layout">
        <SettingsNavigation target={target} effectiveCount={effectiveCount} onChange={changeTarget} />
        <SettingsContent
          target={target}
          heading={heading}
          document={document}
          draft={draft}
          readOnly={readOnly}
          externalChange={externalChange}
          settings={settings}
          onDraftChange={(value) => { setDraft(value); setDirty(true); }}
          onDirtyChange={setDirty}
          onReset={reset}
        />
      </div>
      {target !== "auth" && target !== "instructions" && <SettingsActions dirty={dirty} loading={settings.loading} canSave={canSave} onReset={reset} onSave={() => void save()} />}
    </main>
  );
}
