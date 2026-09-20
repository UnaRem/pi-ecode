import { useCallback, useEffect, useState } from "react";
import type { AppConfigSnapshot, ConversationIdentityRole } from "@shared/app-config-contracts";
import type { WorkAnimatorStatus, WorkAnimatorUpdate } from "@shared/work-animator";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 订阅应用级配置（自定义图标、会话身份、侧栏人物和会话区背景图）。
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

  const chooseConversationAvatar = useCallback(async (role: ConversationIdentityRole) => {
    setLoading(true);
    setError(null);
    try {
      setSnapshot(await window.piDesktop.chooseConversationAvatar(role));
    } catch (chooseError) {
      setError(errorMessage(chooseError));
    } finally {
      setLoading(false);
    }
  }, []);

  const clearConversationAvatar = useCallback(async (role: ConversationIdentityRole) => {
    setLoading(true);
    setError(null);
    try {
      setSnapshot(await window.piDesktop.clearConversationAvatar(role));
    } catch (clearError) {
      setError(errorMessage(clearError));
    } finally {
      setLoading(false);
    }
  }, []);

  const saveConversationNicknames = useCallback(async (value: { assistant: string; user: string }) => {
    setLoading(true);
    setError(null);
    try {
      setSnapshot(await window.piDesktop.saveConversationNicknames(value));
    } catch (saveError) {
      setError(errorMessage(saveError));
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

  const saveWorkAnimator = useCallback(async (status: WorkAnimatorStatus, update: WorkAnimatorUpdate) => {
    setLoading(true);
    setError(null);
    try {
      setSnapshot(await window.piDesktop.saveWorkAnimator(status, update));
    } catch (saveError) {
      setError(errorMessage(saveError));
    } finally {
      setLoading(false);
    }
  }, []);

  const addWorkAnimatorImages = useCallback(async (status: WorkAnimatorStatus) => {
    setLoading(true);
    setError(null);
    try {
      setSnapshot(await window.piDesktop.addWorkAnimatorImages(status));
    } catch (chooseError) {
      setError(errorMessage(chooseError));
    } finally {
      setLoading(false);
    }
  }, []);

  return {
    snapshot,
    saveWorkAnimator,
    addWorkAnimatorImages,
    loading,
    error,
    chooseIcon,
    clearIcon,
    chooseConversationAvatar,
    clearConversationAvatar,
    saveConversationNicknames,
    chooseBackgroundImage,
    clearBackgroundImage,
  };
}
