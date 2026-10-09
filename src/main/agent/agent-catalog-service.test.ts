import { mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SetAllProjectAgentPreferencesRequest } from "../../shared/agent-contracts.js";
import { AgentCatalogService } from "./agent-catalog-service.js";

vi.mock("node:fs/promises", async () => {
  const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  return { ...actual, rename: vi.fn(actual.rename) };
});

const temporaryDirectories: string[] = [];

async function service(now = 1_000): Promise<{ service: AgentCatalogService; root: string }> {
  const root = await mkdtemp(join(tmpdir(), "pi-ecode-agent-catalog-"));
  temporaryDirectories.push(root);
  return { service: new AgentCatalogService(root, () => now), root };
}

afterEach(async () => {
  // mockReset 清除未消费的一次性失败，并恢复 vi.fn 创建时的真实 rename 实现。
  vi.mocked(rename).mockReset();
  vi.restoreAllMocks();
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("AgentCatalogService", () => {
  it("creates the six project-scoped defaults with safe role boundaries", async () => {
    const test = await service();
    const catalog = await test.service.open("C:/work/demo");

    expect(catalog.maxConcurrent).toBe(3);
    expect(catalog.agents.map((agent) => agent.role)).toEqual([
      "explorer", "explorer", "explorer", "editor", "editor", "editor",
    ]);
    expect(catalog.agents.map((agent) => agent.id)).toEqual(["explorer-1", "explorer-2", "explorer-3", "editor-1", "editor-2", "editor-3"]);
    expect(catalog.agents.map((agent) => agent.name)).toEqual(["雅典娜 Athena", "阿波罗 Apollo", "赫尔墨斯 Hermes", "赫淮斯托斯 Hephaestus", "普罗米修斯 Prometheus", "赫斯提亚 Hestia"]);
    expect(catalog.agents.every((agent) => agent.model.mode === "inherit" && agent.thinkingLevel === "low")).toBe(true);
    expect(catalog.agents.every((agent) => agent.autoCompaction.thresholdPercent === null)).toBe(true);
    expect(JSON.stringify(catalog)).toContain("不执行任意 shell 命令");
    expect(test.service.sessionRoot("parent-session")).toContain(join("parents", "parent-session", "sessions"));
  });

  it("迁移旧角色与通用名字，保留自定义字段并幂等原子写盘", async () => {
    const test = await service();
    const initial = await test.service.open("C:/work/demo");
    const [key] = await readdir(join(test.root, "projects"));
    const path = join(test.root, "projects", key!, "agents.json");
    const oldAgents = initial.agents.filter((agent) => agent.id !== "editor-3").map((agent) => ({
      ...agent, name: `${agent.role === "editor" ? "编辑者" : "探索者"} ${agent.id.split("-")[1]}`,
      model: { mode: "fixed", provider: "p", modelId: "m" }, thinkingLevel: "high",
    }));
    oldAgents[0]!.name = "自定义探索名";
    const legacy = ["validator", "reviewer"].flatMap((role) => [
      { ...initial.agents[0]!, id: `${role}-1`, role, builtIn: true },
      { ...initial.agents[0]!, id: `custom-${role}`, role, builtIn: false, name: "保留名字", prompt: "自定义提示", disabledTools: ["read"], enabled: false },
    ]);
    await writeFile(path, JSON.stringify({ ...initial, agents: [...oldAgents, ...legacy] }));
    const migrated = await new AgentCatalogService(test.root, () => 2_000).open("C:/work/demo");
    expect(migrated.agents).toHaveLength(8);
    expect(migrated.agents.find((agent) => agent.id === "explorer-1")?.name).toBe("自定义探索名");
    expect(migrated.agents.find((agent) => agent.id === "editor-1")?.name).toBe("赫淮斯托斯 Hephaestus");
    for (const original of legacy.filter((agent) => !agent.builtIn)) {
      expect(migrated.agents.find((agent) => agent.id === original.id)).toEqual({ ...original, role: "explorer" });
    }
    expect(migrated.agents.find((agent) => agent.id === "editor-3")).toMatchObject({ model: { mode: "fixed", provider: "p", modelId: "m" }, thinkingLevel: "high" });
    const contents = await readFile(path, "utf8");
    expect(await new AgentCatalogService(test.root, () => 3_000).open("C:/work/demo")).toEqual(migrated);
    expect(await readFile(path, "utf8")).toBe(contents);
  });

  it("迁移写入权限失败不发布目录、不覆盖旧文件并清理临时文件", async () => {
    const test = await service();
    const initial = await test.service.open("C:/work/demo");
    const [key] = await readdir(join(test.root, "projects"));
    const directory = join(test.root, "projects", key!);
    const path = join(directory, "agents.json");
    const old = JSON.stringify({ ...initial, agents: initial.agents.filter((agent) => agent.id !== "editor-3") });
    await writeFile(path, old);
    vi.mocked(rename).mockRejectedValueOnce(Object.assign(new Error("permission denied"), { code: "EACCES" }));
    await expect(test.service.open("C:/work/demo")).rejects.toThrow("permission denied");
    expect(test.service.current).toEqual(initial);
    expect(await readFile(path, "utf8")).toBe(old);
    expect(await readdir(directory)).toEqual(["agents.json"]);
  });

  it("补编辑者超过上限时保留原目录，混合设置使用默认", async () => {
    const test = await service();
    const initial = await test.service.open("C:/work/demo");
    const [key] = await readdir(join(test.root, "projects"));
    const path = join(test.root, "projects", key!, "agents.json");
    const agents = initial.agents.filter((agent) => agent.id !== "editor-3");
    agents.find((agent) => agent.id === "editor-1")!.thinkingLevel = "max";
    agents.find((agent) => agent.id === "editor-1")!.model = { mode: "fixed", provider: "p", modelId: "m" };
    await writeFile(path, JSON.stringify({ ...initial, agents }));
    const migrated = await test.service.open("C:/work/demo");
    expect(migrated.agents.find((agent) => agent.id === "editor-3")).toMatchObject({ model: { mode: "inherit" }, thinkingLevel: "low" });
    const full = [...agents, ...Array.from({ length: 11 }, (_, index) => ({ ...agents[0]!, id: `custom-${index}`, builtIn: false }))];
    const old = JSON.stringify({ ...initial, agents: full });
    await writeFile(path, old);
    await expect(test.service.open("C:/work/demo")).rejects.toThrow("16 个代理上限");
    expect(await readFile(path, "utf8")).toBe(old);
    expect(test.service.current).toEqual(migrated);
  });

  it("persists project settings atomically and reloads them", async () => {
    const test = await service(2_000);
    const catalog = await test.service.open("C:/work/demo");
    const explorer = catalog.agents[0]!;
    explorer.name = "架构探索者";
    explorer.model = { mode: "fixed", provider: "openai", modelId: "gpt-test" };
    explorer.autoCompaction.thresholdPercent = 70;
    await test.service.save(explorer);
    await test.service.setMaxConcurrent(5);

    const reloaded = new AgentCatalogService(test.root, () => 3_000);
    const restored = await reloaded.open("C:/work/demo");
    expect(restored.maxConcurrent).toBe(5);
    expect(restored.agents[0]).toMatchObject({
      name: "架构探索者",
      model: { mode: "fixed", provider: "openai", modelId: "gpt-test" },
      autoCompaction: { enabled: true, thresholdPercent: 70 },
    });
    expect((await readFile(join(test.root, "projects"), { encoding: "utf8" }).catch(() => "directory"))).toBe("directory");
  });

  it("updates model and thinking once for all existing agents while retaining other fields", async () => {
    const test = await service(2_000);
    const initial = await test.service.open("C:/work/demo");
    const custom = await test.service.create({ name: "自建代理", role: "explorer" });
    const disabled = custom.agents[0]!;
    disabled.enabled = false;
    disabled.prompt = "特别说明";
    await test.service.save(disabled);
    const before = test.service.current!;
    const result = await test.service.setAllPreferences({
      model: { mode: "fixed", provider: "provider", modelId: "model" }, thinkingLevel: "high",
    });
    expect(result.agents).toHaveLength(initial.agents.length + 1);
    expect(result.agents.every((agent) => agent.model.mode === "fixed" && agent.thinkingLevel === "high")).toBe(true);
    expect(result.agents.map((agent) => ({ id: agent.id, role: agent.role, enabled: agent.enabled, prompt: agent.prompt })))
      .toEqual(before.agents.map((agent) => ({ id: agent.id, role: agent.role, enabled: agent.enabled, prompt: agent.prompt })));
    const restored = await new AgentCatalogService(test.root).open("C:/work/demo");
    expect(restored.agents).toEqual(result.agents);
    await expect(test.service.setAllPreferences({ model: { mode: "fixed", provider: "", modelId: "bad" }, thinkingLevel: "high" }))
      .rejects.toThrow("模型配置无效");
    expect(test.service.current).toEqual(result);
  });

  it.each([
    { model: { mode: "inherit" }, thinkingLevel: "high" },
    { model: { mode: "fixed", provider: "provider", modelId: "model" }, thinkingLevel: "max" },
  ] satisfies SetAllProjectAgentPreferencesRequest[])("批量设置真实保存并重载：%j", async (request) => {
    const test = await service(2_000);
    await test.service.open("C:/work/demo");
    const saved = await test.service.setAllPreferences(request);

    const restored = await new AgentCatalogService(test.root).open("C:/work/demo");
    expect(restored).toEqual(saved);
    for (const agent of restored.agents) {
      expect(agent.model).toEqual(request.model);
      expect(agent.thinkingLevel).toBe(request.thinkingLevel);
    }
  });

  it("keeps the in-memory catalog unchanged when bulk persistence fails", async () => {
    const test = await service();
    const before = await test.service.open("C:/work/demo");
    await rm(test.root, { recursive: true, force: true });
    await expect(test.service.setAllPreferences({ model: { mode: "inherit" }, thinkingLevel: "high" })).rejects.toThrow();
    expect(test.service.current).toEqual(before);
  });

  it("allows user agents to be removed but protects defaults and validates thresholds", async () => {
    const test = await service();
    const catalog = await test.service.open("C:/work/demo");
    await expect(test.service.remove(catalog.agents[0]!.id)).rejects.toThrow("默认代理不能删除");

    const created = await test.service.create({ name: "专项调查", role: "explorer" });
    const custom = created.agents.find((agent) => !agent.builtIn)!;
    custom.autoCompaction.thresholdPercent = 95;
    await expect(test.service.save(custom)).rejects.toThrow("50%–90%");
    const removed = await test.service.remove(custom.id);
    expect(removed.agents).toHaveLength(6);
  });
});
