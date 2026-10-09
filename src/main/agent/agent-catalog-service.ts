import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ThinkingLevel } from "../../shared/contracts.js";
import type {
  AgentRole,
  CreateProjectAgentRequest,
  ProjectAgentCatalog,
  ProjectAgentDefinition,
  SetAllProjectAgentPreferencesRequest,
} from "../../shared/agent-contracts.js";

const MAX_AGENTS = 16;
const THINKING_LEVELS = new Set<ThinkingLevel>(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
const ROLES = new Set<string>(["explorer", "editor"]);
const LEGACY_ROLES = new Set<string>(["validator", "reviewer"]);

const ROLE_PROMPTS: Record<AgentRole, string> = {
  explorer: `你是探索者，负责在明确范围内快速定位源码事实。\n- 优先并行使用只读搜索工具，再读取最相关文件。\n- 追踪定义、调用方和测试，不凭文件名猜测。\n- 用中文汇报结论，引用具体路径和符号；找不到时说明检索范围。`,
  editor: `你是编辑者，负责在主会话声明并锁定的文件范围内完成最小修改。\n- 修改前重新读取目标文件，不依赖旧上下文。\n- 不触碰任务范围外文件，不绕过路径锁，不执行任意 shell 命令。\n- 用中文报告变更文件、行为变化和固定验证结果。`,
};

const DEFAULT_ROLES: readonly AgentRole[] = [
  "explorer", "explorer", "explorer", "editor", "editor", "editor",
];

function defaultName(role: AgentRole, index: number): string {
  const names: Record<AgentRole, readonly string[]> = {
    explorer: ["雅典娜 Athena", "阿波罗 Apollo", "赫尔墨斯 Hermes"],
    editor: ["赫淮斯托斯 Hephaestus", "普罗米修斯 Prometheus", "赫斯提亚 Hestia"],
  };
  return names[role][index - 1] ?? `${role} ${index}`;
}

function cloneCatalog(catalog: ProjectAgentCatalog): ProjectAgentCatalog {
  return structuredClone(catalog);
}

function projectKey(projectPath: string): string {
  return createHash("sha256").update(projectPath).digest("hex").slice(0, 24);
}

function defaultCatalog(projectPath: string, now: number): ProjectAgentCatalog {
  const counts = new Map<AgentRole, number>();
  const agents = DEFAULT_ROLES.map((role): ProjectAgentDefinition => {
    const index = (counts.get(role) ?? 0) + 1;
    counts.set(role, index);
    return {
      id: `${role}-${index}`,
      name: defaultName(role, index),
      role,
      builtIn: true,
      enabled: true,
      model: { mode: "inherit" },
      thinkingLevel: "low",
      autoCompaction: { enabled: true, thresholdPercent: null },
      prompt: ROLE_PROMPTS[role],
      disabledTools: [],
      createdAt: now,
      updatedAt: now,
    };
  });
  return { version: 1, projectPath, maxConcurrent: 3, agents, updatedAt: now };
}

function assertAgent(agent: ProjectAgentDefinition): void {
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/u.test(agent.id)) throw new Error("代理 ID 格式无效。");
  if (!agent.name.trim() || agent.name.length > 80) throw new Error("代理名称必须为 1–80 个字符。");
  if (!ROLES.has(agent.role)) throw new Error("代理角色无效。");
  if (!THINKING_LEVELS.has(agent.thinkingLevel)) throw new Error("代理思考强度无效。");
  if (!agent.prompt.trim() || agent.prompt.length > 20_000) throw new Error("代理提示词必须为 1–20000 个字符。");
  if (agent.model.mode === "fixed" && (!agent.model.provider.trim() || !agent.model.modelId.trim())) throw new Error("固定模型必须包含供应商和模型 ID。");
  const threshold = agent.autoCompaction.thresholdPercent;
  if (threshold !== null && (!Number.isFinite(threshold) || threshold < 50 || threshold > 90)) throw new Error("自动压缩阈值必须为 50%–90%。");
  if (!Array.isArray(agent.disabledTools) || agent.disabledTools.some((name) => !name || name.length > 120)) throw new Error("代理工具过滤列表无效。");
}

function parseCatalog(raw: string, projectPath: string): ProjectAgentCatalog {
  const value = JSON.parse(raw) as Partial<ProjectAgentCatalog>;
  if (value.version !== 1 || value.projectPath !== projectPath || !Array.isArray(value.agents)) throw new Error("代理配置格式无效或不属于当前项目。");
  if (!Number.isInteger(value.maxConcurrent) || value.maxConcurrent! < 1 || value.maxConcurrent! > 7) throw new Error("代理并发上限必须为 1–7。");
  if (value.agents.length === 0 || value.agents.length > MAX_AGENTS) throw new Error(`代理数量必须为 1–${MAX_AGENTS}。`);
  for (const agent of value.agents) {
    // 仅磁盘解析允许旧角色；迁移后再按当前角色约束发布。
    assertAgent(LEGACY_ROLES.has(agent.role) ? { ...agent, role: "explorer" } : agent);
  }
  if (new Set(value.agents.map((agent) => agent.id)).size !== value.agents.length) throw new Error("代理 ID 不能重复。");
  return value as ProjectAgentCatalog;
}

function migrateCatalog(catalog: ProjectAgentCatalog, now: number): ProjectAgentCatalog {
  const agents = catalog.agents.flatMap((agent): ProjectAgentDefinition[] => {
    if (LEGACY_ROLES.has(agent.role)) return agent.builtIn ? [] : [{ ...agent, role: "explorer" }];
    if (!agent.builtIn) return [agent];
    const match = /^(explorer|editor)-([1-3])$/u.exec(agent.id);
    if (!match) return [agent];
    const generic = `${agent.role === "explorer" ? "探索者" : "编辑者"} ${match[2]}`;
    return agent.name === generic ? [{ ...agent, name: defaultName(agent.role, Number(match[2])) }] : [agent];
  });
  if (!agents.some((agent) => agent.id === "editor-3")) {
    if (agents.length >= MAX_AGENTS) throw new Error("代理目录迁移需要新增 editor-3，但已达到 16 个代理上限。");
    const editors = agents.filter((agent) => agent.role === "editor");
    const firstModel = editors[0]?.model;
    const commonModel = firstModel && editors.every(({ model }) => model.mode === "inherit"
      ? firstModel.mode === "inherit"
      : firstModel.mode === "fixed" && model.provider === firstModel.provider && model.modelId === firstModel.modelId);
    const commonThinking = editors.length > 0 && editors.every((agent) => agent.thinkingLevel === editors[0]!.thinkingLevel);
    const added = defaultCatalog(catalog.projectPath, now).agents.find((agent) => agent.id === "editor-3")!;
    if (commonModel) added.model = structuredClone(editors[0]!.model);
    if (commonThinking) added.thinkingLevel = editors[0]!.thinkingLevel;
    agents.push(added);
  }
  const next = { ...catalog, agents };
  return JSON.stringify(next) === JSON.stringify(catalog) ? catalog : { ...next, updatedAt: now };
}

export class AgentCatalogService {
  private catalog: ProjectAgentCatalog | null = null;
  private filePath: string | null = null;

  constructor(private readonly rootDirectory: string, private readonly now: () => number = Date.now) {}

  get current(): ProjectAgentCatalog | null {
    return this.catalog ? cloneCatalog(this.catalog) : null;
  }

  parentSessionRoot(parentSessionId: string): string | null {
    if (!/^[A-Za-z0-9_-]+$/u.test(parentSessionId)) throw new Error("父会话 ID 无效。");
    return this.filePath ? join(this.filePath, "..", "parents", parentSessionId) : null;
  }

  requireParentSessionRoot(parentSessionId: string): string {
    const root = this.parentSessionRoot(parentSessionId);
    if (!root) throw new Error("代理配置尚未加载。");
    return root;
  }

  sessionRoot(parentSessionId: string): string {
    return join(this.requireParentSessionRoot(parentSessionId), "sessions");
  }

  async open(projectPath: string): Promise<ProjectAgentCatalog> {
    const directory = join(this.rootDirectory, "projects", projectKey(projectPath));
    const filePath = join(directory, "agents.json");
    await mkdir(directory, { recursive: true });
    let loaded: ProjectAgentCatalog | undefined;
    try {
      loaded = parseCatalog(await readFile(filePath, "utf8"), projectPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const next = loaded ? migrateCatalog(loaded, this.now()) : defaultCatalog(projectPath, this.now());
    // 迁移及新目录均在原子替换成功后发布，失败时保留先前的内存目录。
    if (next !== loaded) await this.persist(next, filePath);
    this.filePath = filePath;
    this.catalog = next;
    return cloneCatalog(next);
  }

  get(agentId: string): ProjectAgentDefinition {
    const agent = this.requireCatalog().agents.find((candidate) => candidate.id === agentId);
    if (!agent) throw new Error(`找不到代理：${agentId}`);
    return structuredClone(agent);
  }

  enabled(role?: AgentRole): ProjectAgentDefinition[] {
    return this.requireCatalog().agents.filter((agent) => agent.enabled && (!role || agent.role === role)).map((agent) => structuredClone(agent));
  }

  async save(agent: ProjectAgentDefinition): Promise<ProjectAgentCatalog> {
    assertAgent(agent);
    const catalog = this.requireCatalog();
    const index = catalog.agents.findIndex((candidate) => candidate.id === agent.id);
    if (index < 0) throw new Error(`找不到代理：${agent.id}`);
    const existing = catalog.agents[index]!;
    catalog.agents[index] = { ...structuredClone(agent), builtIn: existing.builtIn, createdAt: existing.createdAt, updatedAt: this.now() };
    catalog.updatedAt = this.now();
    await this.persist();
    return cloneCatalog(catalog);
  }

  async create(request: CreateProjectAgentRequest): Promise<ProjectAgentCatalog> {
    const catalog = this.requireCatalog();
    if (catalog.agents.length >= MAX_AGENTS) throw new Error(`最多只能创建 ${MAX_AGENTS} 个代理。`);
    if (!ROLES.has(request.role)) throw new Error("代理角色无效。");
    const now = this.now();
    const agent: ProjectAgentDefinition = {
      id: `agent-${randomUUID()}`,
      name: request.name.trim(),
      role: request.role,
      builtIn: false,
      enabled: true,
      model: { mode: "inherit" },
      thinkingLevel: "low",
      autoCompaction: { enabled: true, thresholdPercent: null },
      prompt: ROLE_PROMPTS[request.role],
      disabledTools: [],
      createdAt: now,
      updatedAt: now,
    };
    assertAgent(agent);
    catalog.agents.push(agent);
    catalog.updatedAt = now;
    await this.persist();
    return cloneCatalog(catalog);
  }

  async remove(agentId: string): Promise<ProjectAgentCatalog> {
    const catalog = this.requireCatalog();
    const agent = catalog.agents.find((candidate) => candidate.id === agentId);
    if (!agent) throw new Error(`找不到代理：${agentId}`);
    if (agent.builtIn) throw new Error("默认代理不能删除，可以禁用或恢复默认配置。");
    catalog.agents = catalog.agents.filter((candidate) => candidate.id !== agentId);
    catalog.updatedAt = this.now();
    await this.persist();
    return cloneCatalog(catalog);
  }

  async setAllPreferences(request: SetAllProjectAgentPreferencesRequest): Promise<ProjectAgentCatalog> {
    if (!THINKING_LEVELS.has(request.thinkingLevel)) throw new Error("代理思考强度无效。");
    if (request.model?.mode !== "inherit" && (request.model?.mode !== "fixed"
      || typeof request.model.provider !== "string" || !request.model.provider.trim()
      || typeof request.model.modelId !== "string" || !request.model.modelId.trim())) {
      throw new Error("代理模型配置无效。");
    }
    const current = this.requireCatalog();
    const now = this.now();
    const next: ProjectAgentCatalog = {
      ...current,
      updatedAt: now,
      agents: current.agents.map((agent) => ({
        ...agent, model: structuredClone(request.model), thinkingLevel: request.thinkingLevel, updatedAt: now,
      })),
    };
    // 持久化成功后才发布内存状态，避免写入失败时界面误以为已更新。
    await this.persist(next);
    this.catalog = next;
    return cloneCatalog(next);
  }

  async setMaxConcurrent(value: number): Promise<ProjectAgentCatalog> {
    if (!Number.isInteger(value) || value < 1 || value > 7) throw new Error("代理并发上限必须为 1–7。");
    const catalog = this.requireCatalog();
    catalog.maxConcurrent = value;
    catalog.updatedAt = this.now();
    await this.persist();
    return cloneCatalog(catalog);
  }

  private requireCatalog(): ProjectAgentCatalog {
    if (!this.catalog) throw new Error("尚未打开项目代理配置。");
    return this.catalog;
  }

  private async persist(catalog = this.requireCatalog(), filePath = this.filePath): Promise<void> {
    if (!filePath) throw new Error("尚未打开项目代理配置。");
    const temporaryPath = `${filePath}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporaryPath, `${JSON.stringify(catalog, null, 2)}\n`, "utf8");
      await rename(temporaryPath, filePath);
    } finally {
      await rm(temporaryPath, { force: true });
    }
  }
}
