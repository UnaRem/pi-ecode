import { useCallback, useEffect, useState } from "react";
import type { AppConfigSnapshot, AppThemeColors } from "@shared/app-config-contracts";
import { DEFAULT_THEME_COLORS } from "@shared/app-config-contracts";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const THEME_VARIABLES: Record<keyof Required<AppThemeColors>, string> = {
  accent: "--accent",
  accentSoft: "--accent-soft",
  danger: "--danger",
  background: "--bg",
};

/** 将主题色写到 :root CSS 变量；null 项恢复默认值。 */
function applyThemeColors(theme: AppThemeColors | null): void {
  const root = document.documentElement;
  for (const [key, variable] of Object.entries(THEME_VARIABLES) as Array<[keyof Required<AppThemeColors>, string]>) {
    const value = theme?.[key] ?? null;
    root.style.setProperty(variable, value ?? DEFAULT_THEME_COLORS[key]);
  }
}

/**
 * 订阅应用级配置（自定义图标、主题色、会话区背景图）。
 * 首次挂载拉取快照并应用主题色，之后监听 app-config-changed 事件。
 * iconUrl/backgroundImageUrl 为 null 时表示未自定义，渲染层应回退默认。
 */
export function useAppConfig() {
  const [snapshot, setSnapshot] = useState<AppConfigSnapshot | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const next = await window.piDesktop.getAppConfig();
      setSnapshot(next);
      applyThemeColors(next.theme);
    } catch (loadError) {
      setError(errorMessage(loadError));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => window.piDesktop.subscribeAppConfig((event) => {
    setSnapshot(event.snapshot);
    applyThemeColors(event.snapshot.theme);
  }), []);

  const chooseIcon = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setSnapshot(await window.piDesktop.chooseAppIcon());
    } catch (chooseError) {
      setError(errorMessage(chooseError));
    } finally {
      setLoading(false);
    }
  }, []);

  const clearIcon = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setSnapshot(await window.piDesktop.clearAppIcon());
    } catch (clearError) {
      setError(errorMessage(clearError));
    } finally {
      setLoading(false);
    }
  }, []);

  const saveTheme = useCallback(async (colors: AppThemeColors) => {
    setError(null);
    try {
      const next = await window.piDesktop.saveTheme(colors);
      setSnapshot(next);
      applyThemeColors(next.theme);
      return next;
    } catch (saveError) {
      setError(errorMessage(saveError));
      return undefined;
    }
  }, []);

  const chooseBackgroundImage = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setSnapshot(await window.piDesktop.chooseBackgroundImage());
    } catch (chooseError) {
      setError(errorMessage(chooseError));
    } finally {
      setLoading(false);
    }
  }, []);

  const clearBackgroundImage = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setSnapshot(await window.piDesktop.clearBackgroundImage());
    } catch (clearError) {
      setError(errorMessage(clearError));
    } finally {
      setLoading(false);
    }
  }, []);

  return { snapshot, loading, error, chooseIcon, clearIcon, saveTheme, chooseBackgroundImage, clearBackgroundImage };
}
