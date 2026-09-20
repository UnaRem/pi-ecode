import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { defaultWorkAnimatorTiming, presetFrames } from "../../shared/work-animator.js";

const mock = vi.hoisted(() => ({ root: "", paths: [] as string[] }));
vi.mock("electron", () => ({
  app: { getPath: () => mock.root },
  BrowserWindow: { getFocusedWindow: () => null },
  dialog: { showOpenDialog: async () => ({ canceled: false, filePaths: mock.paths }) },
}));

import { AppConfigService } from "./app-config-service.js";

const roots: string[] = [];
async function harness(): Promise<AppConfigService> {
  mock.root = await mkdtemp(join(process.cwd(), ".pi-ecode-animator-"));
  roots.push(mock.root);
  return new AppConfigService({ onChanged: () => undefined, onError: () => undefined });
}
afterEach(async () => {
  mock.paths = [];
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("AppConfigService work animator", () => {
  it("migrates missing config to Shiro and persists independent timing", async () => {
    const service = await harness();
    expect((await service.getSnapshot()).workAnimator.working.frames).toHaveLength(6);
    expect((await service.getSnapshot()).workAnimator.display).toEqual({ scalePercent: 100, offsetX: 0, offsetY: 0 });
    const idle = presetFrames("idle", "silence_wang");
    const changed = await service.saveWorkAnimator("idle", {
      preset: "silence_wang",
      timing: { cycleDurationMs: 2_000, curve: { x1: 0, y1: 0, x2: 1, y2: 1 } },
      frames: idle.map((frame) => ({ id: frame.id })),
    });
    expect(changed.workAnimator.idle.frames.reduce((sum, frame) => sum + frame.durationMs, 0)).toBe(2_000);
    expect(changed.workAnimator.idle.timing.cycleDurationMs).toBe(2_000);
    expect(changed.workAnimator.working.preset).toBe("shiro");
    expect((await new AppConfigService({ onChanged: () => undefined, onError: () => undefined }).load()).workAnimator.idle.frames).toHaveLength(4);
    const stored = JSON.parse(await readFile(join(mock.root, "app-config.json"), "utf8")) as { workAnimator: { idle: { frames: Array<Record<string, unknown>> } } };
    expect(stored.workAnimator.idle.frames[0]?.id).toBe(idle[0]?.id);
  });

  it("upgrades only the untouched legacy three-frame Shiro preset", async () => {
    const service = await harness();
    const legacyFrames = [1, 2, 3].map((frame) => ({ id: `work_animator/shiro/idle_${frame}.png`, durationMs: 650 }));
    await writeFile(service.configFilePath, JSON.stringify({
      iconPath: null,
      theme: null,
      backgroundImagePath: null,
      conversationIdentity: null,
      workAnimator: {
        idle: { preset: "shiro", frames: legacyFrames },
        working: { preset: "shiro", frames: legacyFrames.map((frame) => ({ ...frame, id: frame.id.replace("idle", "working"), durationMs: 220 })) },
      },
    }));
    expect((await service.load()).workAnimator.idle.frames).toHaveLength(6);
    legacyFrames[0]!.durationMs = 700;
    await writeFile(service.configFilePath, JSON.stringify({
      workAnimator: { idle: { preset: "shiro", frames: legacyFrames } },
    }));
    expect((await service.load()).workAnimator.idle.frames).toHaveLength(3);
  });

  it("persists bounded shared display positioning", async () => {
    const service = await harness();
    const changed = await service.saveWorkAnimatorDisplay({ scalePercent: 135, offsetX: -40, offsetY: 8 });
    expect(changed.workAnimator.display).toEqual({ scalePercent: 135, offsetX: -40, offsetY: 8 });
    await expect(service.saveWorkAnimatorDisplay({ scalePercent: 251, offsetX: 0, offsetY: 0 })).rejects.toThrow();
    expect((await service.getSnapshot()).workAnimator.display.scalePercent).toBe(135);
  });

  it("copies uploaded files, validates renderer-supplied paths and deletes a removed frame", async () => {
    const service = await harness();
    const source = join(mock.root, "selected.png");
    await writeFile(source, "image");
    mock.paths = [source];
    const added = await service.addWorkAnimatorImages("working");
    const uploaded = added.workAnimator.working.frames.at(-1)!;
    expect(uploaded.url).toContain("file:///");
    expect(await readFile(join(mock.root, uploaded.id), "utf8")).toBe("image");
    await expect(service.saveWorkAnimator("working", { preset: "custom", timing: defaultWorkAnimatorTiming("working", 1), frames: [{ id: "../secrets.png" }] })).rejects.toThrow();
    await expect(service.saveWorkAnimator("working", { preset: "custom", timing: { cycleDurationMs: 15, curve: { x1: 0, y1: 0, x2: 1, y2: 1 } }, frames: [{ id: uploaded.id }] })).rejects.toThrow();
    await expect(service.saveWorkAnimator("idle", { preset: "custom", timing: defaultWorkAnimatorTiming("idle", 1), frames: [{ id: uploaded.id }] })).rejects.toThrow();
    expect((await service.getSnapshot()).workAnimator.working.frames.at(-1)?.id).toBe(uploaded.id);
    await service.saveWorkAnimator("working", { preset: "shiro", timing: defaultWorkAnimatorTiming("working", 6), frames: presetFrames("working", "shiro").map(({ id }) => ({ id })) });
    expect(await readdir(join(mock.root, "assets"))).toEqual([]);
  });
});
