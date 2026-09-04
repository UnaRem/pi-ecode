import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { REDACTED_CONFIG_VALUE } from "../../shared/settings-contracts.js";
import { SettingsService } from "./settings-service.js";

const temporaryDirectories: string[] = [];
const activeServices: SettingsService[] = [];

async function createHarness() {
  const root = await mkdtemp(join(process.cwd(), ".pi-ecode-settings-"));
  temporaryDirectories.push(root);
  const agentDir = join(root, "agent");
  const projectPath = join(root, "project");
  await mkdir(agentDir, { recursive: true });
  await mkdir(projectPath, { recursive: true });
  let applyCount = 0;
  let busy = false;
  const errors: string[] = [];
  const service = new SettingsService({
    agentDir,
    getProjectPath: () => projectPath,
    getProviderStatuses: async () => [],
    isFffLoaded: () => false,
    isProjectTrusted: () => true,
    isRuntimeBusy: () => busy,
    applyRuntimeChanges: async () => { applyCount += 1; },
    onChanged: () => undefined,
    onError: (message) => errors.push(message),
  });
  activeServices.push(service);
  return { service, agentDir, projectPath, errors, applyCount: () => applyCount, setBusy: (value: boolean) => { busy = value; } };
}

afterEach(async () => {
  await Promise.all(activeServices.splice(0).map((service) => service.dispose()));
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("SettingsService", () => {
  it("merges project settings over global settings and saves atomically", async () => {
    const harness = await createHarness();
    await writeFile(join(harness.agentDir, "settings.json"), JSON.stringify({ compaction: { enabled: true, reserveTokens: 100 } }));
    await mkdir(join(harness.projectPath, ".pi"), { recursive: true });
    await writeFile(join(harness.projectPath, ".pi", "settings.json"), JSON.stringify({ compaction: { reserveTokens: 200 } }));
    const snapshot = await harness.service.getSnapshot();
    expect(snapshot.effectiveSettings).toEqual({ compaction: { enabled: true, reserveTokens: 200 } });

    await harness.service.save({ target: "global-settings", value: { quietStartup: true }, expectedRevision: snapshot.globalSettings.revision });
    expect(JSON.parse(await readFile(join(harness.agentDir, "settings.json"), "utf8"))).toEqual({ quietStartup: true });
    expect(harness.applyCount()).toBe(1);
  });

  it("loads and saves only the fixed instruction file targets", async () => {
    const harness = await createHarness();
    const globalPath = join(harness.agentDir, "APPEND_SYSTEM.md");
    const projectPath = join(harness.projectPath, "AGENTS.md");
    await writeFile(globalPath, "Global instructions");
    await writeFile(projectPath, "Project instructions");
    const snapshot = await harness.service.getSnapshot();

    expect(snapshot.instructionFiles["global-append-system"]).toMatchObject({ path: globalPath, content: "Global instructions" });
    expect(snapshot.instructionFiles["project-agents"]).toMatchObject({ path: projectPath, content: "Project instructions" });
    await harness.service.saveInstructionFile({
      target: "project-agents",
      content: "Updated project instructions",
      expectedRevision: snapshot.instructionFiles["project-agents"].revision,
    });

    expect(await readFile(projectPath, "utf8")).toBe("Updated project instructions");
    expect(harness.applyCount()).toBe(1);
  });

  it("prevents stale or oversized instruction file writes", async () => {
    const harness = await createHarness();
    const request = { target: "global-append-system" as const, content: "First", expectedRevision: null };
    await harness.service.saveInstructionFile(request);
    await expect(harness.service.saveInstructionFile({ ...request, content: "Stale" })).rejects.toThrow("changed on disk");
    await expect(harness.service.saveInstructionFile({ ...request, content: "x".repeat(1_000_001) })).rejects.toThrow("1 MB");
  });

  it("defers instruction file application while the agent is busy", async () => {
    const harness = await createHarness();
    harness.setBusy(true);
    await harness.service.saveInstructionFile({ target: "global-append-system", content: "Later", expectedRevision: null });
    expect(harness.applyCount()).toBe(0);
    expect((await harness.service.getSnapshot()).pendingReload).toBe(true);
    harness.setBusy(false);
    await harness.service.applyPendingIfIdle();
    expect(harness.applyCount()).toBe(1);
  });

  it("masks model credentials and preserves them when saving", async () => {
    const harness = await createHarness();
    const path = join(harness.agentDir, "models.json");
    await writeFile(path, JSON.stringify({ providers: { local: { apiKey: "secret", api: "openai-completions", models: [{ id: "one" }] } } }));
    const snapshot = await harness.service.getSnapshot();
    expect(snapshot.models.value.providers).toEqual({ local: { apiKey: REDACTED_CONFIG_VALUE, api: "openai-completions", models: [{ id: "one" }] } });
    await harness.service.save({ target: "models", value: snapshot.models.value, expectedRevision: snapshot.models.revision });
    expect(await readFile(path, "utf8")).toContain('"apiKey": "secret"');
  });

  it("keeps the active runtime when a managed file is malformed", async () => {
    const harness = await createHarness();
    await writeFile(join(harness.agentDir, "pi-fff.json"), "{ invalid json");
    expect((await harness.service.getSnapshot()).error).toContain("pi-fff.json");
    await expect(harness.service.reload()).rejects.toThrow("pi-fff.json");
    expect(harness.applyCount()).toBe(0);
  });

  it("applies valid external file changes", async () => {
    const harness = await createHarness();
    await harness.service.start();
    await writeFile(join(harness.agentDir, "settings.json"), JSON.stringify({ quietStartup: true }));
    await vi.waitFor(() => expect(harness.applyCount()).toBe(1), { timeout: 2_000 });
  });

  it("defers runtime application while the agent is busy", async () => {
    const harness = await createHarness();
    harness.setBusy(true);
    const snapshot = await harness.service.getSnapshot();
    await harness.service.save({ target: "global-settings", value: { quietStartup: true }, expectedRevision: snapshot.globalSettings.revision });
    expect(harness.applyCount()).toBe(0);
    harness.setBusy(false);
    await harness.service.applyPendingIfIdle();
    expect(harness.applyCount()).toBe(1);
  });

  it("does not apply a deferred reload if a file becomes invalid", async () => {
    const harness = await createHarness();
    harness.setBusy(true);
    const snapshot = await harness.service.getSnapshot();
    await harness.service.save({ target: "global-settings", value: { quietStartup: true }, expectedRevision: snapshot.globalSettings.revision });
    await writeFile(join(harness.agentDir, "pi-fff.json"), "{ invalid json");
    harness.setBusy(false);
    await harness.service.applyPendingIfIdle();
    expect(harness.applyCount()).toBe(0);
    expect(harness.errors.at(-1)).toContain("pi-fff.json");
  });
});
