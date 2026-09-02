import { ArrowLeft, LoaderCircle, RefreshCw, Save, Settings2, Undo2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { ConfigTarget, JsonObject } from "@shared/settings-contracts";
import { useSettings } from "../../hooks/use-settings";
import { useI18n } from "../../i18n/i18n";
import { GeneralSettingsForm } from "./GeneralSettingsForm";
import { ModelsSettingsForm } from "./ModelsSettingsForm";
import { AuthSettingsPanel } from "./AuthSettingsPanel";

type SettingsSection = ConfigTarget | "auth";

interface SettingsPageProps {
  onClose: () => void;
  onDirtyChange: (dirty: boolean) => void;
}

export function SettingsPage(props: SettingsPageProps) {
  const { t } = useI18n();
  const settings = useSettings(true);
  const [target, setTarget] = useState<SettingsSection>("global-settings");
  const [draft, setDraft] = useState<JsonObject>({});
  const [baseRevision, setBaseRevision] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [externalChange, setExternalChange] = useState(false);
  const document = target === "auth" ? null : settings.documentFor(target);
  const settingsTarget = target === "global-settings" || target === "project-settings";

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

  const path = document?.path ?? "";
  const readOnly = target === "project-settings" && !settings.snapshot?.projectTrusted;
  const canSave = target !== "auth" && dirty && !readOnly && !settings.loading && !externalChange;
  const heading = target === "global-settings"
    ? t("settings.global")
    : target === "project-settings" ? t("settings.project") : target === "models" ? t("settings.models") : t("settings.auth");
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
    if (target === "auth") return;
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
        <nav className="settings-nav" aria-label={t("settings.category")}> 
          <button className={target === "global-settings" ? "active" : ""} onClick={() => changeTarget("global-settings")}>
            <Settings2 size={14} /><span>{t("settings.global")}</span>
          </button>
          <button className={target === "project-settings" ? "active" : ""} onClick={() => changeTarget("project-settings")}>
            <Settings2 size={14} /><span>{t("settings.project")}</span>
          </button>
          <button className={target === "models" ? "active" : ""} onClick={() => changeTarget("models")}>
            <Settings2 size={14} /><span>{t("settings.models")}</span>
          </button>
          <button className={target === "auth" ? "active" : ""} onClick={() => changeTarget("auth")}>
            <Settings2 size={14} /><span>{t("settings.auth")}</span>
          </button>
          <div className="settings-nav-note">{t("settings.effectiveCount", { count: effectiveCount })}</div>
        </nav>
        <section className="settings-content">
          <div className="settings-content-title">
            <div><h2>{heading}</h2><code title={path}>{path}</code></div>
            {settings.snapshot?.pendingReload && <span className="settings-pending"><LoaderCircle className="spin" size={12} />{t("settings.pending")}</span>}
          </div>
          {settings.error && <div className="settings-error">{settings.error}</div>}
          {document?.error && <div className="settings-error">{document.error}</div>}
          {externalChange && (
            <div className="settings-conflict">
              {t("settings.externalChanged")}
              <button onClick={reset}>{t("settings.loadDisk")}</button>
            </div>
          )}
          {target === "auth" ? (
            <AuthSettingsPanel
              providers={settings.snapshot?.providers ?? []}
              flow={settings.authFlow}
              disabled={settings.loading}
              onLogin={(providerId, type) => void settings.login(providerId, type)}
              onLogout={(providerId) => void settings.logout(providerId)}
              onRespond={(response) => void settings.respondAuth(response)}
              onCancel={() => void settings.cancelAuth()}
            />
          ) : !document ? (
            <div className="settings-loading"><LoaderCircle className="spin" size={18} />{t("settings.loading")}</div>
          ) : settingsTarget ? (
            <GeneralSettingsForm
              value={draft}
              disabled={readOnly || settings.loading}
              readOnly={readOnly}
              onChange={(value) => { setDraft(value); setDirty(true); }}
            />
          ) : (
            <ModelsSettingsForm
              value={draft}
              disabled={settings.loading}
              onChange={(value) => { setDraft(value); setDirty(true); }}
            />
          )}
        </section>
      </div>
      {target !== "auth" && (
        <footer className="settings-actions">
          <span>{dirty ? t("settings.unsaved") : t("settings.synced")}</span>
          <button onClick={reset} disabled={!dirty || settings.loading}><Undo2 size={14} />{t("settings.discard")}</button>
          <button className="primary" onClick={() => void save()} disabled={!canSave}><Save size={14} />{t("settings.save")}</button>
        </footer>
      )}
    </main>
  );
}
