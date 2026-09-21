import { FolderOpen, LoaderCircle } from "lucide-react";
import { useCallback, useEffect, useState, type CSSProperties } from "react";
import { Composer } from "./components/Composer";
import { Conversation } from "./components/Conversation";
import { Sidebar } from "./components/Sidebar";
import { StartupScreen } from "./components/StartupScreen";
import { Topbar } from "./components/Topbar";
import { WorkspaceInspector } from "./components/WorkspaceInspector";
import { ExplorerContextBar } from "./components/ExplorerContextBar";
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
  const [selectedExplorerId, setSelectedExplorerId] = useState<string | null>(null);
  const [explorerToolOutput, setExplorerToolOutput] = useState<{ key: string; output: string } | null>(null);
  const selectedModel = state.models.find((model) => `${model.provider}/${model.id}` === state.selectedModel);
  const activeSession = state.sessions.find((session) => session.path === state.sessionFile);
  const sessionTitle = state.sessionTitle ?? (activeSession?.messageCount ? activeSession.title : null);
  const selectedExplorer = state.explorers.find((task) => task.id === selectedExplorerId) ?? null;
  const selectedAgent = selectedExplorer?.agentId && state.agentCatalog
    ? state.agentCatalog.agents.find((agent) => agent.id === selectedExplorer.agentId) ?? null
    : null;
  const explorerTimeline = selectedExplorerId ? state.explorerTimelines[selectedExplorerId]?.timeline ?? [] : [];
  const activeConversationIdentity = selectedExplorer && appConfig
    ? {
      ...appConfig.conversationIdentity,
      assistant: {
        ...appConfig.conversationIdentity.assistant,
        nickname: selectedAgent?.name ?? selectedExplorer.title,
      },
    }
    : appConfig?.conversationIdentity;
  const activeTimeline = selectedExplorer ? explorerTimeline : state.timeline;
  const activeViewKey = selectedExplorer ? `explorer:${selectedExplorer.id}` : `main:${state.sessionFile ?? "new-session"}`;
  const workspaceTools = useWorkspaceTools(activeTimeline, activeViewKey);
  const selectedExplorerToolKey = selectedExplorer && workspaceTools.selectedTool
    ? `${selectedExplorer.id}:${workspaceTools.selectedTool.id}`
    : null;
  const inspectorSelectedTool = workspaceTools.selectedTool && explorerToolOutput?.key === selectedExplorerToolKey
    ? { ...workspaceTools.selectedTool, output: explorerToolOutput.output, outputTruncated: false }
    : workspaceTools.selectedTool;

  const leaveSettings = useCallback((): boolean => {
    if (settingsDirty && !window.confirm(t("settings.confirmDiscard"))) return false;
    setSettingsOpen(false);
    setSettingsDirty(false);
    return true;
  }, [settingsDirty, t]);

  useEffect(() => {
    if (selectedExplorerId && !selectedExplorer) setSelectedExplorerId(null);
  }, [selectedExplorer, selectedExplorerId]);

  useEffect(() => {
    setSelectedExplorerId(null);
  }, [state.sessionFile]);

  useEffect(() => {
    if (!selectedExplorer || !workspaceTools.selectedTool || workspaceTools.selectedTool.status === "running") {
      setExplorerToolOutput(null);
      return;
    }
    let cancelled = false;
    void actions.getExplorerToolOutput(selectedExplorer.id, workspaceTools.selectedTool.id).then((output) => {
      if (!cancelled && output !== undefined) setExplorerToolOutput({
        key: `${selectedExplorer.id}:${workspaceTools.selectedTool!.id}`,
        output,
      });
    });
    return () => { cancelled = true; };
  }, [actions.getExplorerToolOutput, selectedExplorer, workspaceTools.selectedTool]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape" && selectedExplorerId) {
        event.preventDefault();
        setSelectedExplorerId(null);
      } else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "n" && state.projectPath && !settingsOpen) {
        event.preventDefault();
        void actions.newSession();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [actions.newSession, selectedExplorerId, settingsOpen, state.projectPath]);

  const selectExplorer = useCallback((taskId: string): void => {
    setSelectedExplorerId(taskId);
    void actions.loadExplorerTimeline(taskId);
  }, [actions.loadExplorerTimeline]);

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
        taskPlan={state.taskPlan}
        workAnimator={appConfig?.workAnimator}
        settingsActive={settingsOpen}
        open={sidebarOpen}
        onChooseProject={() => { if (leaveSettings()) void actions.chooseProject(); }}
        onNewSession={() => { if (leaveSettings()) void actions.newSession(); }}
        onSwitchSession={(path) => { if (leaveSettings()) void actions.switchSession(path); }}
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
          projectPath={state.projectPath}
          sessionTitle={sessionTitle}
          policy={state.policy}
          onOpenSidebar={() => setSidebarOpen(true)}
          onRenameSession={(title) => void actions.renameSession(title)}
        />
        {selectedExplorer && <ExplorerContextBar task={selectedExplorer} onReturn={() => setSelectedExplorerId(null)} />}
        <Conversation
          timeline={activeTimeline}
          viewKey={activeViewKey}
          explorers={selectedExplorer ? [] : state.explorers}
          {...(!selectedExplorer ? { validation: state.validation } : {})}
          isStreaming={selectedExplorer
            ? selectedExplorer.status === "running" || state.explorerTimelines[selectedExplorer.id] === undefined
            : state.isStreaming}
          workingStartedAt={selectedExplorer ? selectedExplorer.startedAt ?? null : state.workingStartedAt}
          projectName={state.projectName}
          error={selectedExplorer ? null : state.error}
          canContinue={selectedExplorer ? false : state.canContinue}
          notice={selectedExplorer ? null : state.notice}
          conversationIdentity={activeConversationIdentity}
          {...(!selectedExplorer ? { review: state.review } : {})}
          hasOlderTimeline={selectedExplorer ? false : state.timelineHasMore}
          isLoadingOlder={selectedExplorer ? false : isLoadingOlder}
          {...(!selectedExplorer ? { onLoadOlder: () => void actions.loadOlderTimeline() } : {})}
          onContinue={() => void actions.continueAfterError()}
          selectedToolId={workspaceTools.selectedToolId}
          onSelectTool={workspaceTools.selectTool}
        />
        <div hidden={Boolean(selectedExplorer)} aria-hidden={selectedExplorer ? true : undefined}>
          <Composer
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
        tools={workspaceTools.tools}
        selectedTool={inspectorSelectedTool}
        validation={state.validation}
        review={state.review}
        candidate={state.candidate}
        projectPath={state.projectPath}
        isStreaming={state.isStreaming}
        explorers={state.explorers}
        agentCatalog={state.agentCatalog}
        models={state.models}
        selectedExplorerId={selectedExplorerId}
        onSelectExplorer={selectExplorer}
        onStopExplorer={(taskId) => void actions.stopExplorer(taskId)}
        onSaveProjectAgent={async (agent) => { await actions.saveProjectAgent(agent); }}
        onCreateProjectAgent={async (request) => { await actions.createProjectAgent(request); }}
        onRemoveProjectAgent={async (agentId) => { await actions.removeProjectAgent(agentId); }}
        onSetAgentConcurrency={async (value) => { await actions.setAgentConcurrency(value); }}
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
