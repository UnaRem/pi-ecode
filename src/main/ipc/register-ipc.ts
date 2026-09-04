import { BrowserWindow, Notification, dialog, ipcMain } from "electron";
import type { ExtensionUiResponse, ImageAttachment, ThinkingLevel } from "../../shared/contracts.js";
import { IPC_CHANNELS } from "../../shared/contracts.js";
import type { AuthPromptResponse, AuthType, SaveConfigRequest, SaveInstructionFileRequest } from "../../shared/settings-contracts.js";
import type { AgentService } from "../agent/agent-service.js";
import type { SettingsService } from "../settings/settings-service.js";
import { ProjectGitService } from "../project-git-service.js";

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

export function registerIpc(service: AgentService, settings: SettingsService): () => void {
  const projectGit = new ProjectGitService(() => service.activeProjectPath ?? null);
  ipcMain.handle(IPC_CHANNELS.chooseProject, async (event) => {
    const owner = BrowserWindow.fromWebContents(event.sender) ?? undefined;
    const result = owner
      ? await dialog.showOpenDialog(owner, { properties: ["openDirectory", "createDirectory"] })
      : await dialog.showOpenDialog({ properties: ["openDirectory", "createDirectory"] });
    return result.canceled ? null : (result.filePaths[0] ?? null);
  });
  ipcMain.handle(IPC_CHANNELS.openProject, async (_event, path: string) => {
    const snapshot = await service.openProject(path);
    await settings.projectChanged();
    return snapshot;
  });
  ipcMain.handle(IPC_CHANNELS.getSnapshot, () => service.getSnapshot());
  ipcMain.handle(IPC_CHANNELS.newSession, () => service.newSession());
  ipcMain.handle(IPC_CHANNELS.switchSession, (_event, path: string) => service.switchSession(path));
  ipcMain.handle(IPC_CHANNELS.deleteSession, (_event, path: string) => service.deleteSession(path));
  ipcMain.handle(IPC_CHANNELS.renameSession, (_event, title: string) => service.renameSession(title));
  ipcMain.handle(IPC_CHANNELS.continueAfterError, () => service.continueAfterError());
  ipcMain.handle(IPC_CHANNELS.prompt, (_event, message: string, images?: ImageAttachment[]) => service.prompt(message, images));
  ipcMain.handle(IPC_CHANNELS.stop, () => service.stop());
  ipcMain.handle(IPC_CHANNELS.setModel, (_event, provider: string, modelId: string) => service.setModel(provider, modelId));
  ipcMain.handle(IPC_CHANNELS.setThinkingLevel, (_event, level: ThinkingLevel) => service.setThinkingLevel(level));
  ipcMain.handle(IPC_CHANNELS.undo, () => service.undo());
  ipcMain.handle(IPC_CHANNELS.redo, () => service.redo());
  ipcMain.handle(IPC_CHANNELS.runValidation, () => service.runValidation());
  ipcMain.handle(IPC_CHANNELS.stopValidation, () => service.stopValidation());
  ipcMain.handle(IPC_CHANNELS.getReview, () => service.getReview());
  ipcMain.handle(IPC_CHANNELS.rejectReviewFile, (_event, path: string) => service.rejectReviewFile(path));
  ipcMain.handle(IPC_CHANNELS.prepareCandidate, () => service.prepareCandidate());
  ipcMain.handle(IPC_CHANNELS.activateCandidate, () => service.activateCandidate());
  ipcMain.handle(IPC_CHANNELS.rendererReady, () => service.rendererReady());
  ipcMain.handle(IPC_CHANNELS.compact, () => service.compact());
  ipcMain.handle(IPC_CHANNELS.cancelCompact, () => service.cancelCompaction());
  ipcMain.handle(IPC_CHANNELS.notifyCompactionComplete, (_event, title: unknown, body: unknown) => {
    if (typeof title !== "string" || typeof body !== "string" || !Notification.isSupported()) return false;
    const safeTitle = title.trim().slice(0, 80);
    const safeBody = body.trim().slice(0, 240);
    if (!safeTitle || !safeBody) return false;
    new Notification({ title: safeTitle, body: safeBody }).show();
    return true;
  });
  ipcMain.handle(IPC_CHANNELS.respondExtensionUi, (_event, response: unknown) => (
    isExtensionUiResponse(response) && service.respondExtensionUi(response)
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
    await service.loginProvider(providerId, type);
    await settings.runtimeStateChanged();
  });
  ipcMain.handle(IPC_CHANNELS.logoutProvider, async (_event, providerId: unknown) => {
    if (typeof providerId !== "string") throw new Error("Invalid provider id.");
    await service.logoutProvider(providerId);
    return settings.reload();
  });
  ipcMain.handle(IPC_CHANNELS.respondAuthPrompt, (_event, response: unknown) => (
    isAuthPromptResponse(response) && service.respondAuthPrompt(response)
  ));
  ipcMain.handle(IPC_CHANNELS.cancelAuth, () => service.cancelAuth());
  ipcMain.handle(IPC_CHANNELS.getProjectGitStatus, () => projectGit.getStatus());
  ipcMain.handle(IPC_CHANNELS.pushProject, () => projectGit.push());

  const unsubscribe = service.subscribe((agentEvent) => {
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) window.webContents.send(IPC_CHANNELS.event, agentEvent);
    }
  });

  return () => {
    unsubscribe();
    for (const channel of Object.values(IPC_CHANNELS)) {
      if (channel !== IPC_CHANNELS.event) ipcMain.removeHandler(channel);
    }
  };
}
