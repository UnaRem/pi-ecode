import { FolderOpen, LoaderCircle } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import { Composer, type ComposerDraft } from "./components/Composer";
import { Conversation } from "./components/Conversation";
import { Sidebar } from "./components/Sidebar";
import { StartupScreen } from "./components/StartupScreen";
import { Topbar } from "./components/Topbar";
import { WorkspaceInspector } from "./components/WorkspaceInspector";
import { SettingsPage } from "./components/settings/SettingsPage";
import { useAgent } from "./hooks/use-agent";
import { useAppConfig } from "./hooks/use-app-config";
import { useScrollbarVisibility } from "./hooks/use-scrollbar-visibility";
import { useWorkspaceTools } from "./hooks/use-workspace-tools";
import { useI18n } from "./i18n/i18n";

export default function App() {
  useScrollbarVisibility();
  const { state, isLoading, isLoadingOlder, actions } = useAgent();
  const { snapshot: appConfig } = useAppConfig();
  const brandIconSrc = appConfig?.iconUrl ?? "./ecode-icon.png";
  const customBackdropActive = Boolean(appConfig?.backgroundImageUrl);
  const conversationBackgroundUrl = appConfig?.backgroundImageUrl ?? null;
  const workspaceStyle: CSSProperties | undefined = conversationBackgroundUrl
    ? { "--conversation-bg-image": `url("${conversationBackgroundUrl}")` } as CSSProperties
    : undefined;
  const { t } = useI18n();
  const [startupVisible, setStartupVisible] = useState(true);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsDirty, setSettingsDirty] = useState(false);
  const [suggestedPrompt, setSuggestedPrompt] = useState<{ viewKey: string; id: string; text: string } | null>(null);
  const acknowledgeSuggestion = useCallback((id: string) => setSuggestedPrompt((current) => current?.id === id ? null : current), []);
  const selectedModel = state.models.find((model) => `${model.provider}/${model.id}` === state.selectedModel);
  const activeSession = state.sessions.find((session) => session.path === state.sessionFile);
  const sessionTitle = state.sessionTitle ?? (activeSession?.messageCount ? activeSession.title : null);
  const activeViewKey = `main:${state.projectPath}:${state.sessionId ?? state.sessionFile ?? "new-session"}`;
  const composerDrafts = useRef(new Map<string, ComposerDraft>());
  const saveComposerDraft = useCallback((draft: ComposerDraft) => { composerDrafts.current.set(activeViewKey, draft); }, [activeViewKey]);
  const workspaceTools = useWorkspaceTools(state.timeline, activeViewKey);

  const leaveSettings = useCallback(async (): Promise<boolean> => {
    if (settingsDirty && !await window.piDesktop.showConfirmation({
      message: t("settings.confirmDiscard"), confirmLabel: t("dialog.confirm"), cancelLabel: t("dialog.cancel"),
    })) return false;
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
  }, [actions.newSession, settingsOpen, state.projectPath]);

  if (startupVisible) {
    return <StartupScreen ready={!isLoading} iconSrc={brandIconSrc} onFinished={() => setStartupVisible(false)} />;
  }

  if (isLoading) {
    return <div className="loading-screen"><LoaderCircle className="spin" size={22} /><span>{t("app.openingProject")}</span></div>;
  }

  if (!state.projectPath || !state.projectName) {
    return (
      <div className="project-gate">
        <div className="brand-mark"><img src={brandIconSrc} alt="" /></div>
        <h1>PiECode</h1>
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
    <div className={`app-shell app-frame ${sidebarOpen ? "sidebar-visible" : ""} ${customBackdropActive ? "has-custom-backdrop" : ""}`}>
      <Sidebar
        projectName={state.projectName}
        projectPath={state.projectPath}
        iconSrc={brandIconSrc}
        sessions={state.sessions}
        activeSessionFile={state.sessionFile}
        disabled={state.isStreaming}
        parallel={state.parallel}
        onStopSession={(path) => void actions.stopSession(path)}
        taskPlan={state.taskPlan}
        workAnimator={appConfig?.workAnimator}
        settingsActive={settingsOpen}
        open={sidebarOpen}
        onChooseProject={async () => { if (await leaveSettings()) await actions.chooseProject(); }}
        onNewSession={async () => { if (await leaveSettings()) await actions.newSession(); }}
        onSwitchSession={async (path) => { if (await leaveSettings()) await actions.switchSession(path); }}
        onDeleteSession={(path) => void actions.deleteSession(path)}
        onOpenSettings={() => setSettingsOpen(true)}
        onCollapse={() => setSidebarOpen(false)}
      />
      <section className="workspace" data-region="workspace" style={workspaceStyle}>
        {settingsOpen ? (
          <SettingsPage onClose={() => void leaveSettings()} onDirtyChange={setSettingsDirty} />
        ) : (
          <>
        <Topbar
          sidebarOpen={sidebarOpen}
          projectName={state.projectName}
          projectPath={state.workspacePath ?? state.projectPath}
          sessionTitle={sessionTitle}
          policy={state.policy}
          onOpenSidebar={() => setSidebarOpen(true)}
          onRenameSession={(title) => void actions.renameSession(title)}
        />
        {state.workspacePath && state.workspacePath !== state.projectPath && <div className="session-workspace-note">
          {t("sidebar.isolatedWorkspace")}<code>{state.workspacePath}</code>
        </div>}
        <Conversation
          key={activeViewKey}
          timeline={state.timeline}
          viewKey={activeViewKey}
          validation={state.validation}
          isStreaming={state.isStreaming}
          workingStartedAt={state.workingStartedAt}
          projectName={state.projectName}
          projectProfile={state.projectProfile}
          onSelectSuggestion={(text) => setSuggestedPrompt({ viewKey: activeViewKey, id: crypto.randomUUID(), text })}
          error={state.error}
          canContinue={state.canContinue}
          notice={state.notice}
          conversationIdentity={appConfig?.conversationIdentity}
          review={state.review}
          hasOlderTimeline={state.timelineHasMore}
          isLoadingOlder={isLoadingOlder}
          onLoadOlder={() => void actions.loadOlderTimeline()}
          onContinue={() => void actions.continueAfterError()}
          onSendConfirmation={(message) => actions.send(message)}
          selectedToolId={workspaceTools.selectedToolId}
          onSelectTool={workspaceTools.selectTool}
        />
        <div>
          <Composer
          key={activeViewKey}
          initialDraft={composerDrafts.current.get(activeViewKey)}
          suggestedPrompt={suggestedPrompt?.viewKey === activeViewKey ? suggestedPrompt : undefined}
          onSuggestionApplied={acknowledgeSuggestion}
          onDraftChange={saveComposerDraft}
          isStreaming={state.isStreaming}
          pendingCount={state.pendingCount}
          modelReady={Boolean(state.selectedModel)}
          supportsImages={selectedModel?.supportsImages ?? false}
          models={state.models}
          selectedModel={state.selectedModel}
          thinkingLevel={state.thinkingLevel}
          thinkingLevels={state.thinkingLevels}
          restoredText={state.restoredEditorText}
          restoredImages={state.restoredEditorImages}
          restoreVersion={state.editorRestoreVersion}
          restoreMode={state.editorRestoreMode}
          onEditorRestored={actions.editorRestored}
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
          onSetModel={(value) => void actions.setModel(value)}
          onSetThinking={(level) => void actions.setThinkingLevel(level)}
          />
        </div>
          </>
        )}
      </section>
      <WorkspaceInspector
        key={activeViewKey}
        tools={workspaceTools.tools}
        mcpTools={state.mcpTools}
        toolStatistics={state.toolStatistics ?? []}
        selectedTool={workspaceTools.selectedTool}
        validation={state.validation}
        review={state.review}
        candidate={state.candidate}
        projectPath={state.workspacePath ?? state.projectPath}
        isStreaming={state.isStreaming}
        processes={state.processes}
        onStopManagedProcess={actions.stopManagedProcess}
        onSelectTool={workspaceTools.selectTool}
        onRunValidation={() => void actions.runValidation()}
        onStopValidation={() => void actions.stopValidation()}
        onRejectFile={(path) => void actions.rejectReviewFile(path)}
        onPrepareCandidate={() => void actions.prepareCandidate()}
        onActivateCandidate={() => void actions.activateCandidate()}
      />
    </div>
  );
}
