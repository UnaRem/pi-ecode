import { contextBridge, ipcRenderer } from "electron";
import type { AgentEvent, DesktopApi, ThinkingLevel } from "../shared/contracts.js";
import { IPC_CHANNELS } from "../shared/contracts.js";

const api: DesktopApi = {
  chooseProject: () => ipcRenderer.invoke(IPC_CHANNELS.chooseProject),
  openProject: (path) => ipcRenderer.invoke(IPC_CHANNELS.openProject, path),
  getSnapshot: () => ipcRenderer.invoke(IPC_CHANNELS.getSnapshot),
  newSession: () => ipcRenderer.invoke(IPC_CHANNELS.newSession),
  switchSession: (path) => ipcRenderer.invoke(IPC_CHANNELS.switchSession, path),
  prompt: (message, images) => ipcRenderer.invoke(IPC_CHANNELS.prompt, message, images),
  stop: () => ipcRenderer.invoke(IPC_CHANNELS.stop),
  setModel: (provider, modelId) => ipcRenderer.invoke(IPC_CHANNELS.setModel, provider, modelId),
  setThinkingLevel: (level: ThinkingLevel) => ipcRenderer.invoke(IPC_CHANNELS.setThinkingLevel, level),
  createCheckpoint: (label) => ipcRenderer.invoke(IPC_CHANNELS.createCheckpoint, label),
  undo: () => ipcRenderer.invoke(IPC_CHANNELS.undo),
  redo: () => ipcRenderer.invoke(IPC_CHANNELS.redo),
  runValidation: () => ipcRenderer.invoke(IPC_CHANNELS.runValidation),
  stopValidation: () => ipcRenderer.invoke(IPC_CHANNELS.stopValidation),
  getReview: () => ipcRenderer.invoke(IPC_CHANNELS.getReview),
  rejectReviewFile: (path) => ipcRenderer.invoke(IPC_CHANNELS.rejectReviewFile, path),
  prepareCandidate: () => ipcRenderer.invoke(IPC_CHANNELS.prepareCandidate),
  activateCandidate: () => ipcRenderer.invoke(IPC_CHANNELS.activateCandidate),
  rendererReady: () => ipcRenderer.invoke(IPC_CHANNELS.rendererReady),
  compact: () => ipcRenderer.invoke(IPC_CHANNELS.compact),
  subscribe: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, agentEvent: AgentEvent): void => listener(agentEvent);
    ipcRenderer.on(IPC_CHANNELS.event, handler);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.event, handler);
  },
};

contextBridge.exposeInMainWorld("piDesktop", api);
