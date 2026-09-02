import { BrowserWindow, Notification, dialog, ipcMain } from "electron";
import type { ExtensionUiResponse, ImageAttachment, ThinkingLevel } from "../../shared/contracts.js";
import { IPC_CHANNELS } from "../../shared/contracts.js";
import type { AgentService } from "../agent/agent-service.js";

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

export function registerIpc(service: AgentService): () => void {
  ipcMain.handle(IPC_CHANNELS.chooseProject, async (event) => {
    const owner = BrowserWindow.fromWebContents(event.sender) ?? undefined;
    const result = owner
      ? await dialog.showOpenDialog(owner, { properties: ["openDirectory", "createDirectory"] })
      : await dialog.showOpenDialog({ properties: ["openDirectory", "createDirectory"] });
    return result.canceled ? null : (result.filePaths[0] ?? null);
  });
  ipcMain.handle(IPC_CHANNELS.openProject, (_event, path: string) => service.openProject(path));
  ipcMain.handle(IPC_CHANNELS.getSnapshot, () => service.getSnapshot());
  ipcMain.handle(IPC_CHANNELS.newSession, () => service.newSession());
  ipcMain.handle(IPC_CHANNELS.switchSession, (_event, path: string) => service.switchSession(path));
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
