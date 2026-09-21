import { describe, expect, it } from "vitest";
import { AgentWriteLockService } from "./agent-write-locks.js";

const cwd = "C:/work/project";

describe("AgentWriteLockService", () => {
  it("allows disjoint editor scopes and rejects overlapping files or directories", () => {
    const locks = new AgentWriteLockService();
    locks.acquire(cwd, "task-a", "editor-1", ["src/main/**"]);
    locks.acquire(cwd, "task-b", "editor-2", ["src/renderer/App.tsx"]);

    expect(() => locks.acquire(cwd, "task-c", "editor-2", ["src/main/index.ts"])).toThrow("写入范围冲突");
    expect(() => locks.acquire(cwd, "task-d", "editor-2", ["src/**"])).toThrow("写入范围冲突");
  });

  it("checks every actual edit path and releases locks", () => {
    const locks = new AgentWriteLockService();
    locks.acquire(cwd, "task-a", "editor-1", ["src/main/**", "package.json"]);

    expect(locks.assertPath(cwd, "task-a", "src/main/index.ts")).toBe("src/main/index.ts");
    expect(locks.assertPath(cwd, "task-a", "package.json")).toBe("package.json");
    expect(() => locks.assertPath(cwd, "task-a", "src/renderer/App.tsx")).toThrow("不在任务 write_scope");
    expect(() => locks.assertPath(cwd, "task-a", "../outside.txt")).toThrow("超出工作区");

    locks.release("task-a");
    expect(locks.current).toEqual([]);
  });

  it("rejects locking the entire workspace", () => {
    const locks = new AgentWriteLockService();
    expect(() => locks.acquire(cwd, "task-a", "editor-1", ["."])).toThrow("整个工作区");
  });
});
