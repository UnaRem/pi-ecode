import { BrowserWindow, Notification, dialog, ipcMain } from "electron";
import type { AppThemeColors, ConversationIdentityRole, ConversationNicknameUpdate } from "../../shared/app-config-contracts.js";
import type { WorkAnimatorDisplay, WorkAnimatorStatus, WorkAnimatorUpdate } from "../../shared/work-animator.js";
import type { ConfirmationDialogRequest, ExtensionUiResponse, ImageAttachment, ThinkingLevel } from "../../shared/contracts.js";
import { IPC_CHANNELS } from "../../shared/contracts.js";
import type { AuthPromptResponse, AuthType, SaveConfigRequest, SaveInstructionFileRequest } from "../../shared/settings-contracts.js";
import type { ProjectSessionService } from "../agent/project-session-service.js";
import type { AgentService } from "../agent/agent-service.js";
import type { AppConfigService } from "../app-config/app-config-service.js";
import type { SettingsService } from "../settings/settings-service.js";
import { ProjectGitService } from "../project-git-service.js";

function isConversationIdentityRole(value: unknown): value is ConversationIdentityRole {
  return value === "assistant" || value === "user";
}

function isConversationNicknameUpdate(value: unknown): value is ConversationNicknameUpdate {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate.assistant === "string" && typeof candidate.user === "string";
}

function isWorkAnimatorStatus(value: unknown): value is WorkAnimatorStatus {
  return value === "idle" || value === "working";
}

function isWorkAnimatorDisplay(value: unknown): value is WorkAnimatorDisplay {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const display = value as Record<string, unknown>;
  return typeof display.scalePercent === "number" && typeof display.offsetX === "number" && typeof display.offsetY === "number";
}

function isWorkAnimatorUpdate(value: unknown): value is WorkAnimatorUpdate {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const update = value as Record<string, unknown>;
  const timing = update.timing as Record<string, unknown> | undefined;
  const curve = timing?.curve as Record<string, unknown> | undefined;
  return (update.preset === "shiro" || update.preset === "silence_wang" || update.preset === "custom")
    && Array.isArray(update.frames)
    && update.frames.length > 0
    && update.frames.length <= 100
    && update.frames.every((item: unknown) => Boolean(item) && typeof item === "object" && typeof (item as Record<string, unknown>).id === "string")
    && typeof timing?.cycleDurationMs === "number"
    && Boolean(curve)
    && [curve?.x1, curve?.y1, curve?.x2, curve?.y2].every((point) => typeof point === "number");
}

function isThemeColors(value: unknown): value is AppThemeColors {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  const isColorOrNull = (entry: unknown): boolean => entry === null || (typeof entry === "string" && /^#[0-9a-fA-F]{6}$/.test(entry));
  return isColorOrNull(candidate.accent)
    && isColorOrNull(candidate.accentSoft)
    && isColorOrNull(candidate.danger)
    && isColorOrNull(candidate.background);
}

function isExtensionUiResponse(value: unknown): value is ExtensionUiResponse {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<ExtensionUiResponse>;
  const responseValue = candidate.value;
  return typeof candidate.requestId === "string" && (
    responseValue === null
    || typeof responseValue === "string"
    || typeof responseValue === "boolean"
    || (Array.isArray(responseValue) && responseValue.every((item) => typeof item === "string"))
  );
}

function isAuthType(value: unknown): value is AuthType {
  return value === "api_key" || value === "oauth";
}

function isAuthPromptResponse(value: unknown): value is AuthPromptResponse {
  if (!value || typeof value !== "object") return false;
  const response = value as Partial<AuthPromptResponse>;
  return typeof response.requestId === "string" && (response.value === null || typeof response.value === "string");
}

function isSaveConfigRequest(value: unknown): value is SaveConfigRequest {
  if (!value || typeof value !== "object") return false;
  const request = value as Partial<SaveConfigRequest>;
  const targets = ["global-settings", "project-settings", "models", "pi-fff"];
  return typeof request.target === "string"
    && targets.includes(request.target)
    && Boolean(request.value)
    && typeof request.value === "object"
    && !Array.isArray(request.value)
    && (request.expectedRevision === null || typeof request.expectedRevision === "string");
}

function isSaveInstructionFileRequest(value: unknown): value is SaveInstructionFileRequest {
  if (!value || typeof value !== "object") return false;
  const request = value as Partial<SaveInstructionFileRequest>;
  return (request.target === "global-append-system" || request.target === "project-agents")
    && typeof request.content === "string"
    && (request.expectedRevision === null || typeof request.expectedRevision === "string");
}

function isConfirmationDialogRequest(value: unknown): value is ConfirmationDialogRequest {
  if (!value || typeof value !== "object") return false;
  const request = value as Partial<ConfirmationDialogRequest>;
  return typeof request.message === "string" && request.message.trim().length > 0 && request.message.length <= 2_000
    && [request.confirmLabel, request.cancelLabel].every((label) => typeof label === "string" && label.trim().length > 0 && label.length <= 80);
}

export function registerIpc(service: AgentService | ProjectSessionService, settings: SettingsService, appConfig: AppConfigService): () => void {
  const active = (): AgentService => "activeService" in service ? service.activeService : service;
  const projectGit = new ProjectGitService(() => active().activeProjectPath ?? null);
  ipcMain.handle(IPC_CHANNELS.showConfirmation, async (event, request: unknown) => {
    if (!isConfirmationDialogRequest(request)) throw new Error("Invalid confirmation request.");
    const owner = BrowserWindow.fromWebContents(event.sender);
    if (!owner || owner.isDestroyed()) return false;
    const result = await dialog.showMessageBox(owner, {
      type: "question", title: "PiECode", message: request.message,
      buttons: [request.cancelLabel, request.confirmLabel], defaultId: 0, cancelId: 0, noLink: true,
    });
    if (owner.isDestroyed()) return false;
    // Repair Chromium's keyboard focus after a Windows dialog without stealing another window's focus.
    if (owner.isFocused()) owner.webContents.focus();
    return result.response === 1;
  });
  ipcMain.handle(IPC_CHANNELS.chooseProject, async (event) => {
    const owner = BrowserWindow.fromWebContents(event.sender) ?? undefined;
    const result = owner
      ? await dialog.showOpenDialog(owner, { properties: ["openDirectory", "createDirectory"] })
      : await dialog.showOpenDialog({ properties: ["openDirectory", "createDirectory"] });
    if (owner && !owner.isDestroyed() && owner.isFocused()) owner.webContents.focus();
    return result.canceled ? null : (result.filePaths[0] ?? null);
  });
  ipcMain.handle(IPC_CHANNELS.openProject, async (_event, path: string) => {
    const snapshot = await service.openProject(path);
    await settings.projectChanged();
    return snapshot;
  });
  ipcMain.handle(IPC_CHANNELS.getSnapshot, () => service.getSnapshot());
  ipcMain.handle(IPC_CHANNELS.loadOlderTimeline, () => active().loadOlderTimeline());
  ipcMain.handle(IPC_CHANNELS.getToolOutput, (_event, toolCallId: unknown) => {
    if (typeof toolCallId !== "string") throw new Error("Invalid tool call id.");
    return active().getToolOutput(toolCallId);
  });
  ipcMain.handle(IPC_CHANNELS.getConversationImage, (_event, sourceId: unknown) => {
    if (typeof sourceId !== "string") throw new Error("Invalid conversation image id.");
    return active().getConversationImage(sourceId);
  });
  ipcMain.handle(IPC_CHANNELS.newSession, () => service.newSession());
  ipcMain.handle(IPC_CHANNELS.switchSession, (_event, path: string) => service.switchSession(path));
  ipcMain.handle(IPC_CHANNELS.deleteSession, (_event, path: string) => service.deleteSession(path));
  ipcMain.handle(IPC_CHANNELS.renameSession, (_event, title: string) => active().renameSession(title));
  ipcMain.handle(IPC_CHANNELS.continueAfterError, () => service.continueAfterError());
  ipcMain.handle(IPC_CHANNELS.prompt, (_event, message: string, images?: ImageAttachment[]) => service.prompt(message, images));
  ipcMain.handle(IPC_CHANNELS.stop, () => active().stop());
  ipcMain.handle(IPC_CHANNELS.stopSession, (_event, path: unknown) => {
    if (typeof path !== "string" || !path || path.length > 4096 || !("stopSession" in service)) throw new Error("会话停止目标无效。");
    return service.stopSession(path);
  });
  ipcMain.handle(IPC_CHANNELS.setModel, (_event, provider: string, modelId: string) => active().setModel(provider, modelId));
  ipcMain.handle(IPC_CHANNELS.setThinkingLevel, (_event, level: ThinkingLevel) => active().setThinkingLevel(level));
  ipcMain.handle(IPC_CHANNELS.undo, () => service.undo());
  ipcMain.handle(IPC_CHANNELS.redo, () => service.redo());
  ipcMain.handle(IPC_CHANNELS.runValidation, () => service.runValidation());
  ipcMain.handle(IPC_CHANNELS.stopValidation, () => active().stopValidation());
  ipcMain.handle(IPC_CHANNELS.stopManagedProcess, (_event, id: unknown) => {
    if (typeof id !== "string" || !id.trim() || id.length > 200) throw new Error("托管进程 ID 无效。");
    return active().stopManagedProcess(id);
  });
  ipcMain.handle(IPC_CHANNELS.getReview, () => active().getReview());
  ipcMain.handle(IPC_CHANNELS.rejectReviewFile, (_event, path: string) => service.rejectReviewFile(path));
  ipcMain.handle(IPC_CHANNELS.prepareCandidate, () => active().prepareCandidate());
  ipcMain.handle(IPC_CHANNELS.activateCandidate, () => active().activateCandidate());
  ipcMain.handle(IPC_CHANNELS.rendererReady, () => ("rootService" in service ? service.rootService : active()).rendererReady());
  ipcMain.handle(IPC_CHANNELS.compact, () => active().compact());
  ipcMain.handle(IPC_CHANNELS.cancelCompact, () => active().cancelCompaction());
  ipcMain.handle(IPC_CHANNELS.notifyCompactionComplete, (_event, title: unknown, body: unknown) => {
    if (typeof title !== "string" || typeof body !== "string" || !Notification.isSupported()) return false;
    const safeTitle = title.trim().slice(0, 80);
    const safeBody = body.trim().slice(0, 240);
    if (!safeTitle || !safeBody) return false;
    new Notification({ title: safeTitle, body: safeBody }).show();
    return true;
  });
  ipcMain.handle(IPC_CHANNELS.respondExtensionUi, (_event, response: unknown) => (
    isExtensionUiResponse(response) && active().respondExtensionUi(response)
  ));
  ipcMain.handle(IPC_CHANNELS.getSettings, () => settings.getSnapshot());
  ipcMain.handle(IPC_CHANNELS.saveConfig, (_event, request: unknown) => {
    if (!isSaveConfigRequest(request)) throw new Error("Invalid settings save request.");
    return settings.save(request);
  });
  ipcMain.handle(IPC_CHANNELS.saveInstructionFile, (_event, request: unknown) => {
    if (!isSaveInstructionFileRequest(request)) throw new Error("Invalid instruction file save request.");
    return settings.saveInstructionFile(request);
  });
  ipcMain.handle(IPC_CHANNELS.reloadSettings, () => settings.reload());
  ipcMain.handle(IPC_CHANNELS.loginProvider, async (_event, providerId: unknown, type: unknown) => {
    if (typeof providerId !== "string" || !isAuthType(type)) throw new Error("Invalid authentication request.");
    await active().loginProvider(providerId, type);
    await settings.runtimeStateChanged();
  });
  ipcMain.handle(IPC_CHANNELS.logoutProvider, async (_event, providerId: unknown) => {
    if (typeof providerId !== "string") throw new Error("Invalid provider id.");
    await active().logoutProvider(providerId);
    return settings.reload();
  });
  ipcMain.handle(IPC_CHANNELS.respondAuthPrompt, (_event, response: unknown) => (
    isAuthPromptResponse(response) && active().respondAuthPrompt(response)
  ));
  ipcMain.handle(IPC_CHANNELS.cancelAuth, () => active().cancelAuth());
  ipcMain.handle(IPC_CHANNELS.getProjectGitStatus, () => projectGit.getStatus());
  ipcMain.handle(IPC_CHANNELS.pushProject, () => projectGit.push());
  ipcMain.handle(IPC_CHANNELS.getAppConfig, () => appConfig.getSnapshot());
  ipcMain.handle(IPC_CHANNELS.saveWorkAnimatorDisplay, (_event, display: unknown) => {
    if (!isWorkAnimatorDisplay(display)) throw new Error("Invalid animator display configuration.");
    return appConfig.saveWorkAnimatorDisplay(display);
  });
  ipcMain.handle(IPC_CHANNELS.saveWorkAnimator, (_event, status: unknown, update: unknown) => {
    if (!isWorkAnimatorStatus(status) || !isWorkAnimatorUpdate(update)) throw new Error("Invalid animator configuration.");
    return appConfig.saveWorkAnimator(status, update);
  });
  ipcMain.handle(IPC_CHANNELS.addWorkAnimatorImages, (_event, status: unknown) => {
    if (!isWorkAnimatorStatus(status)) throw new Error("Invalid animator status.");
    return appConfig.addWorkAnimatorImages(status);
  });
  ipcMain.handle(IPC_CHANNELS.chooseAppIcon, () => appConfig.chooseIcon());
  ipcMain.handle(IPC_CHANNELS.clearAppIcon, () => appConfig.clearIcon());
  ipcMain.handle(IPC_CHANNELS.chooseConversationAvatar, (_event, role: unknown) => {
    if (!isConversationIdentityRole(role)) throw new Error("Invalid conversation identity role.");
    return appConfig.chooseConversationAvatar(role);
  });
  ipcMain.handle(IPC_CHANNELS.clearConversationAvatar, (_event, role: unknown) => {
    if (!isConversationIdentityRole(role)) throw new Error("Invalid conversation identity role.");
    return appConfig.clearConversationAvatar(role);
  });
  ipcMain.handle(IPC_CHANNELS.saveConversationNicknames, (_event, value: unknown) => {
    if (!isConversationNicknameUpdate(value)) throw new Error("Invalid conversation nicknames.");
    return appConfig.saveConversationNicknames(value);
  });
  ipcMain.handle(IPC_CHANNELS.saveTheme, (_event, colors: unknown) => {
    if (!isThemeColors(colors)) throw new Error("Invalid theme colors.");
    return appConfig.saveTheme(colors);
  });
  ipcMain.handle(IPC_CHANNELS.chooseBackgroundImage, () => appConfig.chooseBackgroundImage());
  ipcMain.handle(IPC_CHANNELS.clearBackgroundImage, () => appConfig.clearBackgroundImage());

  const unsubscribe = service.subscribe((agentEvent) => {
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) window.webContents.send(IPC_CHANNELS.event, agentEvent);
    }
  });

  return () => {
    unsubscribe();
    for (const channel of Object.values(IPC_CHANNELS)) {
      if (channel !== IPC_CHANNELS.event && channel !== IPC_CHANNELS.appConfigEvent) ipcMain.removeHandler(channel);
    }
  };
}
