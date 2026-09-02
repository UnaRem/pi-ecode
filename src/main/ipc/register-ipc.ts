import { BrowserWindow, dialog, ipcMain } from "electron";
import type { ImageAttachment, ThinkingLevel } from "../../shared/contracts.js";
import { IPC_CHANNELS } from "../../shared/contracts.js";
import type { AgentService } from "../agent/agent-service.js";

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
  ipcMain.handle(IPC_CHANNELS.createCheckpoint, (_event, label?: string) => service.createCheckpoint(label));
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
