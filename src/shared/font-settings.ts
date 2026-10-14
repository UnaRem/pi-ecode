export interface AppFontSettings {
  uiFamily: string | null;
  codeFamily: string | null;
  conversationSize: number | null;
  codeSize: number | null;
  zoomPercent: number;
}

// null restores each surface's existing font stack and size, including compact logs.
export const DEFAULT_FONT_SETTINGS: Readonly<AppFontSettings> = {
  uiFamily: null, codeFamily: null, conversationSize: null, codeSize: null, zoomPercent: 100,
};
export const APP_ZOOM_PRESETS: readonly number[] = [80, 90, 100, 110, 125, 150];
export const UI_FONT_PRESETS = ["Segoe UI", "Microsoft YaHei", "Microsoft YaHei UI", "SimSun", "Arial"] as const;
export const CODE_FONT_PRESETS = ["Cascadia Code", "Consolas", "JetBrains Mono", "Fira Code", "Courier New"] as const;

export function isFontFamily(value: unknown): value is string | null {
  // Accept one installed family name, never a CSS declaration or a font URL.
  return value === null || (typeof value === "string" && value.length <= 100
    && value.trim().length > 0 && /^[\p{L}\p{N} ._()+-]+$/u.test(value));
}

export function isFontSize(value: unknown, minimum: number, maximum: number): value is number | null {
  return value === null || (typeof value === "number" && Number.isFinite(value)
    && value >= minimum && value <= maximum && Number.isInteger(value * 2));
}

export function isAppFontSettings(value: unknown): value is AppFontSettings {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  return isFontFamily(candidate.uiFamily) && isFontFamily(candidate.codeFamily)
    && isFontSize(candidate.conversationSize, 12, 24) && isFontSize(candidate.codeSize, 10, 22)
    && typeof candidate.zoomPercent === "number" && APP_ZOOM_PRESETS.includes(candidate.zoomPercent);
}

export function normalizeFontSettings(value: unknown): AppFontSettings {
  const candidate = value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
  return {
    uiFamily: isFontFamily(candidate.uiFamily) ? candidate.uiFamily?.trim() ?? null : null,
    codeFamily: isFontFamily(candidate.codeFamily) ? candidate.codeFamily?.trim() ?? null : null,
    conversationSize: isFontSize(candidate.conversationSize, 12, 24) ? candidate.conversationSize : null,
    codeSize: isFontSize(candidate.codeSize, 10, 22) ? candidate.codeSize : null,
    zoomPercent: typeof candidate.zoomPercent === "number" && APP_ZOOM_PRESETS.includes(candidate.zoomPercent)
      ? candidate.zoomPercent : DEFAULT_FONT_SETTINGS.zoomPercent,
  };
}

export function fontFamilyCss(family: string | null, code = false): string {
  const fallback = code
    ? '"Cascadia Code", Consolas, monospace'
    : 'Inter, ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
  return family ? `${JSON.stringify(family)}, ${fallback}` : fallback;
}
