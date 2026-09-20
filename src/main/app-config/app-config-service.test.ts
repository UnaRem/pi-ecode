import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { presetFrames } from "../../shared/work-animator.js";

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
  it("migrates missing config to shiro and persists independent preset durations", async () => {
    const service = await harness();
    expect((await service.getSnapshot()).workAnimator.working.frames).toHaveLength(6);
    expect((await service.getSnapshot()).workAnimator.display).toEqual({ scalePercent: 100, offsetX: 0, offsetY: 0 });
    const idle = presetFrames("idle", "silence_wang");
    const changed = await service.saveWorkAnimator("idle", {
      preset: "silence_wang",
      frames: idle.map((frame, index) => ({ id: frame.id, durationMs: 350 + index * 50 })),
    });
    expect(changed.workAnimator.idle.frames.map((frame) => frame.durationMs)).toEqual([350, 400, 450, 500]);
    expect(changed.workAnimator.working.preset).toBe("shiro");
    expect((await new AppConfigService({ onChanged: () => undefined, onError: () => undefined }).load()).workAnimator.idle.frames).toHaveLength(4);
    const stored = JSON.parse(await readFile(join(mock.root, "app-config.json"), "utf8")) as { workAnimator: { idle: { frames: Array<Record<string, unknown>> } } };
    expect(stored.workAnimator.idle.frames[0]).toEqual({ id: idle[0]?.id, durationMs: 350 });
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
    await expect(service.saveWorkAnimator("working", { preset: "custom", frames: [{ id: "../secrets.png", durationMs: 220 }] })).rejects.toThrow();
    await expect(service.saveWorkAnimator("working", { preset: "custom", frames: [{ id: uploaded.id, durationMs: 0 }] })).rejects.toThrow();
    await expect(service.saveWorkAnimator("idle", { preset: "custom", frames: [{ id: uploaded.id, durationMs: 220 }] })).rejects.toThrow();
    expect((await service.getSnapshot()).workAnimator.working.frames.at(-1)?.id).toBe(uploaded.id);
    await service.saveWorkAnimator("working", { preset: "shiro", frames: presetFrames("working", "shiro") });
    expect(await readdir(join(mock.root, "assets"))).toEqual([]);
  });
});
