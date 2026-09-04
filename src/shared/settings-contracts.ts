import type { ThinkingLevel } from "./contracts.js";

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];
export interface JsonObject { [key: string]: JsonValue }

export type SettingsScope = "global" | "project";
export type ConfigTarget = "global-settings" | "project-settings" | "models" | "pi-fff";
export type InstructionFileTarget = "global-append-system" | "project-agents";
export type AuthType = "api_key" | "oauth";

export interface ConfigDocument {
  path: string;
  exists: boolean;
  revision: string | null;
  value: JsonObject;
  error: string | null;
}

export interface InstructionFileDocument {
  path: string;
  exists: boolean;
  revision: string | null;
  content: string;
  error: string | null;
}

export interface ProviderAuthMethod {
  type: AuthType;
  label: string;
}

export interface ProviderStatus {
  id: string;
  name: string;
  methods: ProviderAuthMethod[];
  configuredType: AuthType | null;
  source: string | null;
  authenticated: boolean;
}

export interface SettingsSnapshot {
  globalSettings: ConfigDocument;
  projectSettings: ConfigDocument;
  effectiveSettings: JsonObject;
  models: ConfigDocument;
  fff: ConfigDocument;
  instructionFiles: Record<InstructionFileTarget, InstructionFileDocument>;
  fffLoaded: boolean;
  projectTrusted: boolean;
  providers: ProviderStatus[];
  pendingReload: boolean;
  error: string | null;
}

export interface SaveConfigRequest {
  target: ConfigTarget;
  value: JsonObject;
  expectedRevision: string | null;
}

export interface SaveInstructionFileRequest {
  target: InstructionFileTarget;
  content: string;
  expectedRevision: string | null;
}

export interface SettingsChangedEvent {
  type: "settings-changed";
  snapshot: SettingsSnapshot;
  source: "save" | "external" | "runtime";
}

export interface AuthPromptRequest {
  id: string;
  providerId: string;
  type: "text" | "secret" | "select" | "manual_code";
  message: string;
  placeholder?: string;
  options?: Array<{ id: string; label: string; description?: string }>;
}

export interface AuthPromptResponse {
  requestId: string;
  value: string | null;
}

export interface AuthFlowState {
  providerId: string;
  status: "running" | "completed" | "failed" | "cancelled";
  message: string;
  request: AuthPromptRequest | null;
}

export interface AuthFlowEvent {
  type: "auth-flow";
  state: AuthFlowState | null;
}

export interface SettingsApi {
  getSettings(): Promise<SettingsSnapshot>;
  saveConfig(request: SaveConfigRequest): Promise<SettingsSnapshot>;
  saveInstructionFile(request: SaveInstructionFileRequest): Promise<SettingsSnapshot>;
  reloadSettings(): Promise<SettingsSnapshot>;
  loginProvider(providerId: string, type: AuthType): Promise<void>;
  logoutProvider(providerId: string): Promise<SettingsSnapshot>;
  respondAuthPrompt(response: AuthPromptResponse): Promise<boolean>;
  cancelAuth(): Promise<void>;
}

export interface SettingsFormDefaults {
  thinkingLevel: ThinkingLevel;
}

export const REDACTED_CONFIG_VALUE = "__PI_ECODE_REDACTED__";
