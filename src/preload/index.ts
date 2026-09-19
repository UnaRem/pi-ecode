import { contextBridge, ipcRenderer } from "electron";
import type { AgentEvent, DesktopApi, ThinkingLevel } from "../shared/contracts.js";
import type { AppConfigChangedEvent, AppThemeColors } from "../shared/app-config-contracts.js";
import type { AuthFlowEvent, SettingsChangedEvent } from "../shared/settings-contracts.js";
import { IPC_CHANNELS } from "../shared/contracts.js";

const api: DesktopApi = {
  chooseProject: () => ipcRenderer.invoke(IPC_CHANNELS.chooseProject),
  openProject: (path) => ipcRenderer.invoke(IPC_CHANNELS.openProject, path),
  getSnapshot: () => ipcRenderer.invoke(IPC_CHANNELS.getSnapshot),
  loadOlderTimeline: () => ipcRenderer.invoke(IPC_CHANNELS.loadOlderTimeline),
  getToolOutput: (toolCallId) => ipcRenderer.invoke(IPC_CHANNELS.getToolOutput, toolCallId),
  getConversationImage: (sourceId) => ipcRenderer.invoke(IPC_CHANNELS.getConversationImage, sourceId),
  newSession: () => ipcRenderer.invoke(IPC_CHANNELS.newSession),
  switchSession: (path) => ipcRenderer.invoke(IPC_CHANNELS.switchSession, path),
  deleteSession: (path) => ipcRenderer.invoke(IPC_CHANNELS.deleteSession, path),
  renameSession: (title) => ipcRenderer.invoke(IPC_CHANNELS.renameSession, title),
  continueAfterError: () => ipcRenderer.invoke(IPC_CHANNELS.continueAfterError),
  prompt: (message, images) => ipcRenderer.invoke(IPC_CHANNELS.prompt, message, images),
  stop: () => ipcRenderer.invoke(IPC_CHANNELS.stop),
  setModel: (provider, modelId) => ipcRenderer.invoke(IPC_CHANNELS.setModel, provider, modelId),
  setThinkingLevel: (level: ThinkingLevel) => ipcRenderer.invoke(IPC_CHANNELS.setThinkingLevel, level),
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
  cancelCompact: () => ipcRenderer.invoke(IPC_CHANNELS.cancelCompact),
  notifyCompactionComplete: (title, body) => ipcRenderer.invoke(IPC_CHANNELS.notifyCompactionComplete, title, body),
  respondExtensionUi: (response) => ipcRenderer.invoke(IPC_CHANNELS.respondExtensionUi, response),
  getSettings: () => ipcRenderer.invoke(IPC_CHANNELS.getSettings),
  saveConfig: (request) => ipcRenderer.invoke(IPC_CHANNELS.saveConfig, request),
  saveInstructionFile: (request) => ipcRenderer.invoke(IPC_CHANNELS.saveInstructionFile, request),
  reloadSettings: () => ipcRenderer.invoke(IPC_CHANNELS.reloadSettings),
  loginProvider: (providerId, type) => ipcRenderer.invoke(IPC_CHANNELS.loginProvider, providerId, type),
  logoutProvider: (providerId) => ipcRenderer.invoke(IPC_CHANNELS.logoutProvider, providerId),
  respondAuthPrompt: (response) => ipcRenderer.invoke(IPC_CHANNELS.respondAuthPrompt, response),
  cancelAuth: () => ipcRenderer.invoke(IPC_CHANNELS.cancelAuth),
  getProjectGitStatus: () => ipcRenderer.invoke(IPC_CHANNELS.getProjectGitStatus),
  pushProject: () => ipcRenderer.invoke(IPC_CHANNELS.pushProject),
  getAppConfig: () => ipcRenderer.invoke(IPC_CHANNELS.getAppConfig),
  chooseAppIcon: () => ipcRenderer.invoke(IPC_CHANNELS.chooseAppIcon),
  clearAppIcon: () => ipcRenderer.invoke(IPC_CHANNELS.clearAppIcon),
  chooseConversationAvatar: (role: "assistant" | "user") => ipcRenderer.invoke(IPC_CHANNELS.chooseConversationAvatar, role),
  clearConversationAvatar: (role: "assistant" | "user") => ipcRenderer.invoke(IPC_CHANNELS.clearConversationAvatar, role),
  saveConversationNicknames: (value: { assistant: string; user: string }) => ipcRenderer.invoke(IPC_CHANNELS.saveConversationNicknames, value),
  saveTheme: (colors: AppThemeColors) => ipcRenderer.invoke(IPC_CHANNELS.saveTheme, colors),
  chooseBackgroundImage: () => ipcRenderer.invoke(IPC_CHANNELS.chooseBackgroundImage),
  clearBackgroundImage: () => ipcRenderer.invoke(IPC_CHANNELS.clearBackgroundImage),
  subscribe: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, agentEvent: AgentEvent): void => listener(agentEvent);
    ipcRenderer.on(IPC_CHANNELS.event, handler);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.event, handler);
  },
  subscribeSettings: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, settingsEvent: SettingsChangedEvent | AuthFlowEvent): void => listener(settingsEvent);
    ipcRenderer.on(IPC_CHANNELS.settingsEvent, handler);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.settingsEvent, handler);
  },
  subscribeAppConfig: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, appConfigEvent: AppConfigChangedEvent): void => listener(appConfigEvent);
    ipcRenderer.on(IPC_CHANNELS.appConfigEvent, handler);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.appConfigEvent, handler);
  },
};

contextBridge.exposeInMainWorld("piDesktop", api);
