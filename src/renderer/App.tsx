import { FolderOpen, LoaderCircle } from "lucide-react";
import { useEffect, useState } from "react";
import { Composer } from "./components/Composer";
import { Conversation } from "./components/Conversation";
import { Sidebar } from "./components/Sidebar";
import { Topbar } from "./components/Topbar";
import { ValidationPanel } from "./components/ValidationPanel";
import { useAgent } from "./hooks/use-agent";
import { useI18n } from "./i18n/i18n";

export default function App() {
  const { state, isLoading, actions } = useAgent();
  const { t } = useI18n();
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [validationOpen, setValidationOpen] = useState(false);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "n" && state.projectPath) {
        event.preventDefault();
        void actions.newSession();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [actions, state.projectPath]);

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
          onChooseProject={() => void actions.chooseProject()}
          onNewSession={() => void actions.newSession()}
          onSwitchSession={(path) => void actions.switchSession(path)}
          onCollapse={() => setSidebarOpen(false)}
        />
      )}
      <section className="workspace">
        <Topbar
          sidebarOpen={sidebarOpen}
          projectName={state.projectName}
          sessionTitle={state.sessionTitle}
          models={state.models}
          selectedModel={state.selectedModel}
          thinkingLevel={state.thinkingLevel}
          thinkingLevels={state.thinkingLevels}
          disabled={state.isStreaming}
          validation={state.validation}
          policy={state.policy}
          onOpenSidebar={() => setSidebarOpen(true)}
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
          projectName={state.projectName}
          error={state.error}
          notice={state.notice}
        />
        <Composer
          isStreaming={state.isStreaming}
          pendingCount={state.pendingCount}
          modelReady={Boolean(state.selectedModel)}
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
      </section>
    </div>
  );
}
