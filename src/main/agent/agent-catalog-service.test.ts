import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AgentCatalogService } from "./agent-catalog-service.js";

const temporaryDirectories: string[] = [];

async function service(now = 1_000): Promise<{ service: AgentCatalogService; root: string }> {
  const root = await mkdtemp(join(tmpdir(), "pi-ecode-agent-catalog-"));
  temporaryDirectories.push(root);
  return { service: new AgentCatalogService(root, () => now), root };
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("AgentCatalogService", () => {
  it("creates the seven project-scoped defaults with safe role boundaries", async () => {
    const test = await service();
    const catalog = await test.service.open("C:/work/demo");

    expect(catalog.maxConcurrent).toBe(3);
    expect(catalog.agents.map((agent) => agent.role)).toEqual([
      "explorer", "explorer", "explorer", "validator", "reviewer", "editor", "editor",
    ]);
    expect(catalog.agents.every((agent) => agent.model.mode === "inherit" && agent.thinkingLevel === "low")).toBe(true);
    expect(catalog.agents.every((agent) => agent.autoCompaction.thresholdPercent === null)).toBe(true);
    expect(JSON.stringify(catalog)).toContain("不执行任意 shell 命令");
    expect(test.service.sessionRoot("parent-session")).toContain(join("parents", "parent-session", "sessions"));
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

  it("allows user agents to be removed but protects defaults and validates thresholds", async () => {
    const test = await service();
    const catalog = await test.service.open("C:/work/demo");
    await expect(test.service.remove(catalog.agents[0]!.id)).rejects.toThrow("默认代理不能删除");

    const created = await test.service.create({ name: "专项调查", role: "explorer" });
    const custom = created.agents.find((agent) => !agent.builtIn)!;
    custom.autoCompaction.thresholdPercent = 95;
    await expect(test.service.save(custom)).rejects.toThrow("50%–90%");
    const removed = await test.service.remove(custom.id);
    expect(removed.agents).toHaveLength(7);
  });
});
