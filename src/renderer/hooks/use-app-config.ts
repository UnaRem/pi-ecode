import { useCallback, useEffect, useState } from "react";
import type { AppConfigSnapshot } from "@shared/app-config-contracts";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 订阅应用级配置（自定义图标、主题色、会话区背景图）。
 * 首次挂载拉取快照，之后监听 app-config-changed 事件。
 * iconUrl/backgroundImageUrl 为 null 时表示未自定义，渲染层应回退默认。
 * 旧主题字段仅为持久化兼容保留；固定设计系统不将其写入 CSS 变量。
 */
export function useAppConfig() {
  const [snapshot, setSnapshot] = useState<AppConfigSnapshot | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setSnapshot(await window.piDesktop.getAppConfig());
    } catch (loadError) {
      setError(errorMessage(loadError));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => window.piDesktop.subscribeAppConfig((event) => setSnapshot(event.snapshot)), []);

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

  return { snapshot, loading, error, chooseIcon, clearIcon, chooseBackgroundImage, clearBackgroundImage };
}
