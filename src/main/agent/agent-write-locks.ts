import { isAbsolute, relative, resolve, sep } from "node:path";

export interface AgentWriteLock {
  taskId: string;
  agentId: string;
  scopes: string[];
}

function normalizeRelativePath(cwd: string, input: string): string {
  const normalizedInput = input.trim().replaceAll("\\", "/");
  if (!normalizedInput) throw new Error("写入范围不能为空。");
  const directoryScope = normalizedInput.endsWith("/**");
  const value = directoryScope ? normalizedInput.slice(0, -3) : normalizedInput;
  const absolute = resolve(cwd, value);
  const workspaceRelative = relative(cwd, absolute);
  if (isAbsolute(workspaceRelative) || workspaceRelative === ".." || workspaceRelative.startsWith(`..${sep}`)) {
    throw new Error(`写入路径超出工作区：${input}`);
  }
  const normalized = workspaceRelative.replaceAll("\\", "/");
  if (!normalized || normalized === ".") throw new Error("不能锁定整个工作区。");
  return directoryScope ? `${normalized}/**` : normalized;
}

function scopeContains(scope: string, path: string): boolean {
  if (scope.endsWith("/**")) {
    const directory = scope.slice(0, -3).replace(/\/$/u, "");
    return path === directory || path.startsWith(`${directory}/`);
  }
  return scope === path;
}

function scopesOverlap(left: string, right: string): boolean {
  const leftBase = left.endsWith("/**") ? left.slice(0, -3).replace(/\/$/u, "") : left;
  const rightBase = right.endsWith("/**") ? right.slice(0, -3).replace(/\/$/u, "") : right;
  return scopeContains(left, rightBase) || scopeContains(right, leftBase);
}

export class AgentWriteLockService {
  private readonly locks = new Map<string, AgentWriteLock>();

  acquire(cwd: string, taskId: string, agentId: string, requestedScopes: readonly string[]): AgentWriteLock {
    if (requestedScopes.length === 0) throw new Error("编辑者任务必须声明 write_scope。");
    const scopes = [...new Set(requestedScopes.map((scope) => normalizeRelativePath(cwd, scope)))];
    for (const lock of this.locks.values()) {
      if (lock.taskId === taskId) continue;
      const conflict = scopes.find((scope) => lock.scopes.some((activeScope) => scopesOverlap(scope, activeScope)));
      if (conflict) throw new Error(`写入范围冲突：${conflict} 已由代理 ${lock.agentId} 锁定。`);
    }
    const lock = { taskId, agentId, scopes };
    this.locks.set(taskId, lock);
    return structuredClone(lock);
  }

  assertPath(cwd: string, taskId: string, inputPath: string): string {
    const lock = this.locks.get(taskId);
    if (!lock) throw new Error("当前编辑任务没有有效写锁。");
    const normalized = normalizeRelativePath(cwd, inputPath);
    if (!lock.scopes.some((scope) => scopeContains(scope, normalized))) {
      throw new Error(`路径不在任务 write_scope 内：${inputPath}`);
    }
    return normalized;
  }

  release(taskId: string): void {
    this.locks.delete(taskId);
  }

  clear(): void {
    this.locks.clear();
  }

  get current(): AgentWriteLock[] {
    return [...this.locks.values()].map((lock) => structuredClone(lock));
  }
}
