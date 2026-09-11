import { useCallback, useEffect, useState } from "react";
import type { AppConfigSnapshot } from "@shared/app-config-contracts";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 订阅应用级配置（自定义图标）。首次挂载拉取快照，之后监听 app-config-changed 事件。
 * iconUrl 为 null 时表示未自定义，渲染层应回退默认 ./ecode-icon.png。
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

  useEffect(() => window.piDesktop.subscribeAppConfig((event) => {
    setSnapshot(event.snapshot);
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

  return { snapshot, loading, error, chooseIcon, clearIcon };
}
