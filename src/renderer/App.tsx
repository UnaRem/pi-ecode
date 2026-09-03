import { FolderOpen, LoaderCircle } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Composer } from "./components/Composer";
import { Conversation } from "./components/Conversation";
import { Sidebar } from "./components/Sidebar";
import { Topbar } from "./components/Topbar";
import { ValidationPanel } from "./components/ValidationPanel";
import { SettingsPage } from "./components/settings/SettingsPage";
import { useAgent } from "./hooks/use-agent";
import { useI18n } from "./i18n/i18n";

export default function App() {
  const { state, isLoading, actions } = useAgent();
  const { t } = useI18n();
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [validationOpen, setValidationOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsDirty, setSettingsDirty] = useState(false);
  const selectedModel = state.models.find((model) => `${model.provider}/${model.id}` === state.selectedModel);
  const activeSession = state.sessions.find((session) => session.path === state.sessionFile);
  const sessionTitle = state.sessionTitle ?? (activeSession?.messageCount ? activeSession.title : null);

  const leaveSettings = useCallback((): boolean => {
    if (settingsDirty && !window.confirm(t("settings.confirmDiscard"))) return false;
    setSettingsOpen(false);
    setSettingsDirty(false);
    return true;
  }, [settingsDirty, t]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "n" && state.projectPath && !settingsOpen) {
        event.preventDefault();
        void actions.newSession();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [actions, settingsOpen, state.projectPath]);

  if (isLoading) {
    return <div className="loading-screen"><LoaderCircle className="spin" size={22} /><span>{t("app.openingProject")}</span></div>;
  }

  if (!state.projectPath || !state.projectName) {
    return (
      <div className="project-gate">
        <div className="brand-mark">π</div>
        <h1>pi ecode</h1>
        <p>{t("app.tagline")}</p>
        <button onClick={() => void actions.chooseProject()}>
          <FolderOpen size={17} />
          {t("app.openProject")}
        </button>
        {state.error && <div className="error-banner">{state.error}</div>}
      </div>
    );
  }

  return (
    <div className={`app-shell ${sidebarOpen ? "sidebar-visible" : ""}`}>
      {sidebarOpen && (
        <Sidebar
          projectName={state.projectName}
          projectPath={state.projectPath}
          sessions={state.sessions}
          activeSessionFile={state.sessionFile}
          disabled={state.isStreaming}
          taskPlan={state.taskPlan}
          settingsActive={settingsOpen}
          onChooseProject={() => { if (leaveSettings()) void actions.chooseProject(); }}
          onNewSession={() => { if (leaveSettings()) void actions.newSession(); }}
          onSwitchSession={(path) => { if (leaveSettings()) void actions.switchSession(path); }}
          onOpenSettings={() => setSettingsOpen(true)}
          onCollapse={() => setSidebarOpen(false)}
        />
      )}
      <section className="workspace">
        {settingsOpen ? (
          <SettingsPage onClose={() => void leaveSettings()} onDirtyChange={setSettingsDirty} />
        ) : (
          <>
        <Topbar
          sidebarOpen={sidebarOpen}
          projectName={state.projectName}
          sessionTitle={sessionTitle}
          models={state.models}
          selectedModel={state.selectedModel}
          thinkingLevel={state.thinkingLevel}
          thinkingLevels={state.thinkingLevels}
          disabled={state.isStreaming}
          validation={state.validation}
          policy={state.policy}
          onOpenSidebar={() => setSidebarOpen(true)}
          onRenameSession={(title) => void actions.renameSession(title)}
          onSetModel={(value) => void actions.setModel(value)}
          onSetThinking={(level) => void actions.setThinkingLevel(level)}
          onToggleValidation={() => setValidationOpen((open) => !open)}
        />
        {validationOpen && (
          <ValidationPanel
            validation={state.validation}
            review={state.review}
            candidate={state.candidate}
            onRun={() => void actions.runValidation()}
            onStop={() => void actions.stopValidation()}
            onRejectFile={(path) => void actions.rejectReviewFile(path)}
            onPrepareCandidate={() => void actions.prepareCandidate()}
            onActivateCandidate={() => void actions.activateCandidate()}
            onClose={() => setValidationOpen(false)}
          />
        )}
        <Conversation
          timeline={state.timeline}
          isStreaming={state.isStreaming}
          workingStartedAt={state.workingStartedAt}
          projectName={state.projectName}
          error={state.error}
          canContinue={state.canContinue}
          notice={state.notice}
          onContinue={() => void actions.continueAfterError()}
        />
        <Composer
          isStreaming={state.isStreaming}
          pendingCount={state.pendingCount}
          modelReady={Boolean(state.selectedModel)}
          supportsImages={selectedModel?.supportsImages ?? false}
          restoredText={state.restoredEditorText}
          restoredImages={state.restoredEditorImages}
          restoreVersion={state.editorRestoreVersion}
          context={state.context}
          history={state.history}
          extensionUi={state.extensionUi}
          onRespondExtensionUi={(response) => void actions.respondExtensionUi(response)}
          onSend={(message, images) => void actions.send(message, images)}
          onCompact={() => void actions.compact()}
          onCancelCompact={() => void actions.cancelCompact()}
          onStop={() => void actions.stop()}
          onUndo={() => void actions.undo()}
          onRedo={() => void actions.redo()}
        />
          </>
        )}
      </section>
    </div>
  );
}
