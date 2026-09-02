import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { REDACTED_CONFIG_VALUE } from "../../shared/settings-contracts.js";
import { SettingsService } from "./settings-service.js";

const temporaryDirectories: string[] = [];

async function createHarness() {
  const root = await mkdtemp(join(tmpdir(), "pi-ecode-settings-"));
  temporaryDirectories.push(root);
  const agentDir = join(root, "agent");
  const projectPath = join(root, "project");
  await mkdir(agentDir, { recursive: true });
  await mkdir(projectPath, { recursive: true });
  let applyCount = 0;
  let busy = false;
  const service = new SettingsService({
    agentDir,
    getProjectPath: () => projectPath,
    getProviderStatuses: async () => [],
    isFffLoaded: () => false,
    isProjectTrusted: () => true,
    isRuntimeBusy: () => busy,
    applyRuntimeChanges: async () => { applyCount += 1; },
    onChanged: () => undefined,
    onError: () => undefined,
  });
  return { service, agentDir, projectPath, applyCount: () => applyCount, setBusy: (value: boolean) => { busy = value; } };
}

afterEach(async () => {
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

  it("masks model credentials and preserves them when saving", async () => {
    const harness = await createHarness();
    const path = join(harness.agentDir, "models.json");
    await writeFile(path, JSON.stringify({ providers: { local: { apiKey: "secret", api: "openai-completions", models: [{ id: "one" }] } } }));
    const snapshot = await harness.service.getSnapshot();
    expect(snapshot.models.value.providers).toEqual({ local: { apiKey: REDACTED_CONFIG_VALUE, api: "openai-completions", models: [{ id: "one" }] } });
    await harness.service.save({ target: "models", value: snapshot.models.value, expectedRevision: snapshot.models.revision });
    expect(await readFile(path, "utf8")).toContain('"apiKey": "secret"');
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
});
