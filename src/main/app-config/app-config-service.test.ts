import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { defaultWorkAnimatorTiming, presetFrames } from "../../shared/work-animator.js";
import { APP_ZOOM_PRESETS, DEFAULT_FONT_SETTINGS, type AppFontSettings } from "../../shared/font-settings.js";

const mock = vi.hoisted(() => ({ root: "", paths: [] as string[], failRename: false }));
vi.mock("node:fs/promises", async (importOriginal) => {
  const filesystem = await importOriginal<typeof import("node:fs/promises")>();
  return { ...filesystem, rename: async (...args: Parameters<typeof filesystem.rename>) => {
    if (mock.failRename) throw new Error("模拟持久化失败");
    return filesystem.rename(...args);
  } };
});
vi.mock("electron", () => ({
  app: { getPath: () => mock.root },
  BrowserWindow: { getFocusedWindow: () => null },
  dialog: { showOpenDialog: async () => ({ canceled: false, filePaths: mock.paths }) },
}));

import { AppConfigService } from "./app-config-service.js";

const roots: string[] = [];
async function harness(): Promise<AppConfigService> {
  // 在系统临时目录下开临时根，避免测试期间在仓库内新建文件触发验证 watcher 的 stale。
  mock.root = await mkdtemp(join(tmpdir(), ".pi-ecode-animator-"));
  roots.push(mock.root);
  return new AppConfigService({ onChanged: () => undefined, onError: () => undefined });
}
afterEach(async () => {
  mock.paths = [];
  mock.failRename = false;
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("AppConfigService fonts", () => {
  it("keeps existing appearance for old config and normalizes each malformed field", async () => {
    const service = await harness();
    expect((await service.load()).fonts).toEqual(DEFAULT_FONT_SETTINGS);
    await writeFile(service.configFilePath, JSON.stringify({ theme: null }));
    expect((await service.load()).fonts).toEqual(DEFAULT_FONT_SETTINGS);
    await writeFile(service.configFilePath, JSON.stringify({ fonts: {
      uiFamily: "  思源黑体  ", codeFamily: "Consolas; color:red", conversationSize: 13.5, codeSize: 9,
    } }));
    expect((await service.load()).fonts).toEqual({ uiFamily: "思源黑体", codeFamily: null, conversationSize: 13.5, codeSize: null, zoomPercent: 100 });
  });

  it("persists custom families and half-pixel sizes, preserves other settings and restores defaults", async () => {
    const service = await harness();
    await service.saveConversationNicknames({ assistant: "助手", user: "用户" });
    const fonts: AppFontSettings = { uiFamily: "思源黑体", codeFamily: "JetBrains Mono", conversationSize: 19.5, codeSize: 14.5, zoomPercent: 125 };
    expect((await service.saveFontSettings(fonts)).fonts).toEqual(fonts);
    const reloaded = await new AppConfigService({ onChanged: () => undefined, onError: () => undefined }).load();
    expect(reloaded.fonts).toEqual(fonts);
    expect(reloaded.conversationIdentity.assistant.nickname).toBe("助手");
    await service.saveWorkAnimatorDisplay({ scalePercent: 100, offsetX: 0, offsetY: 0 });
    expect((await service.load()).fonts).toEqual(fonts);
    await service.saveFontSettings({ ...DEFAULT_FONT_SETTINGS });
    expect((await service.load()).fonts).toEqual(DEFAULT_FONT_SETTINGS);
  });

  it("defaults legacy or unsupported zoom to 100 without losing existing font sizes", async () => {
    const service = await harness();
    const legacyFonts = { uiFamily: "Segoe UI", codeFamily: "Consolas", conversationSize: 24, codeSize: 22 };
    await writeFile(service.configFilePath, JSON.stringify({ fonts: legacyFonts }));
    expect((await service.load()).fonts).toEqual({ ...legacyFonts, zoomPercent: 100 });
    await writeFile(service.configFilePath, JSON.stringify({ fonts: { ...legacyFonts, zoomPercent: 999 } }));
    expect((await service.load()).fonts).toEqual({ ...legacyFonts, zoomPercent: 100 });
  });

  it("persists every supported zoom, publishes it only after saving and restores 100", async () => {
    await harness();
    const changed = vi.fn();
    const service = new AppConfigService({ onChanged: changed, onError: () => undefined });
    const fonts = { ...DEFAULT_FONT_SETTINGS, conversationSize: 18, codeSize: 22 };
    for (const zoomPercent of APP_ZOOM_PRESETS) {
      const next = { ...fonts, zoomPercent };
      await service.saveFontSettings(next);
      expect(changed).toHaveBeenLastCalledWith(expect.objectContaining({ snapshot: expect.objectContaining({ fonts: next }) }));
      const reopened = new AppConfigService({ onChanged: () => undefined, onError: () => undefined });
      expect((await reopened.load()).fonts).toEqual(next);
    }
    await service.saveFontSettings({ ...DEFAULT_FONT_SETTINGS });
    expect((await service.load()).fonts).toEqual(DEFAULT_FONT_SETTINGS);
  });

  it("rejects invalid fonts and sizes without changing disk, cache or broadcasting", async () => {
    await harness();
    const changed = vi.fn();
    const service = new AppConfigService({ onChanged: changed, onError: () => undefined });
    const before = await service.saveFontSettings({ ...DEFAULT_FONT_SETTINGS });
    const stored = await readFile(service.configFilePath, "utf8");
    changed.mockClear();
    const invalid: Partial<AppFontSettings>[] = [
      { uiFamily: "" }, { uiFamily: "x".repeat(101) }, { codeFamily: 'url("https://fonts.test")' },
      { codeFamily: "Consolas\nArial" }, { conversationSize: 11.5 }, { conversationSize: 24.5 },
      { conversationSize: 14.25 }, { codeSize: 9.5 }, { codeSize: 22.5 }, { codeSize: Number.NaN },
      { zoomPercent: 0 }, { zoomPercent: 79 }, { zoomPercent: 151 }, { zoomPercent: 125.5 },
      { zoomPercent: Number.NaN }, { zoomPercent: Number.POSITIVE_INFINITY },
    ];
    for (const patch of invalid) await expect(service.saveFontSettings({ ...DEFAULT_FONT_SETTINGS, ...patch })).rejects.toThrow();
    expect(await service.getSnapshot()).toEqual(before);
    expect(await readFile(service.configFilePath, "utf8")).toBe(stored);
    expect(changed).not.toHaveBeenCalled();
  });

  it("keeps the saved configuration and cache on atomic-write failure and allows retry", async () => {
    await harness();
    const changed = vi.fn();
    const service = new AppConfigService({ onChanged: changed, onError: () => undefined });
    const before = await service.saveFontSettings({ ...DEFAULT_FONT_SETTINGS });
    const stored = await readFile(service.configFilePath, "utf8");
    changed.mockClear();
    mock.failRename = true;
    await expect(service.saveFontSettings({ ...DEFAULT_FONT_SETTINGS, conversationSize: 18, zoomPercent: 150 })).rejects.toThrow("模拟持久化失败");
    expect(await readFile(service.configFilePath, "utf8")).toBe(stored);
    expect(await service.getSnapshot()).toEqual(before);
    expect(changed).not.toHaveBeenCalled();
    expect((await readdir(mock.root)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
    mock.failRename = false;
    expect((await service.saveFontSettings({ ...DEFAULT_FONT_SETTINGS, conversationSize: 18 })).fonts.conversationSize).toBe(18);
  });
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
