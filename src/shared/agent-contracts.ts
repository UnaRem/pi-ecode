import type { ThinkingLevel } from "./contracts.js";

export type AgentRole = "explorer" | "validator" | "reviewer" | "editor";

export type AgentModelPreference =
  | { mode: "inherit" }
  | { mode: "fixed"; provider: string; modelId: string };

export interface ProjectAgentDefinition {
  id: string;
  name: string;
  role: AgentRole;
  builtIn: boolean;
  enabled: boolean;
  model: AgentModelPreference;
  thinkingLevel: ThinkingLevel;
  autoCompaction: { enabled: boolean; thresholdPercent: number | null };
  prompt: string;
  disabledTools: string[];
  createdAt: number;
  updatedAt: number;
}

export interface ProjectAgentCatalog {
  version: 1;
  projectPath: string;
  maxConcurrent: number;
  agents: ProjectAgentDefinition[];
  updatedAt: number;
}

export interface SaveProjectAgentRequest {
  agent: ProjectAgentDefinition;
}

export interface CreateProjectAgentRequest {
  name: string;
  role: AgentRole;
}
