import { useCallback, useEffect, useState } from "react";
import type { AuthFlowState, AuthPromptResponse, AuthType, ConfigTarget, SaveConfigRequest, SaveInstructionFileRequest, SettingsSnapshot } from "@shared/settings-contracts";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function useSettings(enabled: boolean) {
  const [snapshot, setSnapshot] = useState<SettingsSnapshot | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [authFlow, setAuthFlow] = useState<AuthFlowState | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setSnapshot(await window.piDesktop.getSettings());
    } catch (loadError) {
      setError(errorMessage(loadError));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (enabled) void load();
  }, [enabled, load]);

  useEffect(() => window.piDesktop.subscribeSettings((event) => {
    if (event.type === "settings-changed") setSnapshot(event.snapshot);
    else setAuthFlow(event.state);
  }), []);

  const save = useCallback(async (request: SaveConfigRequest) => {
    setLoading(true);
    setError(null);
    try {
      const next = await window.piDesktop.saveConfig(request);
      setSnapshot(next);
      return next;
    } catch (saveError) {
      setError(errorMessage(saveError));
      return undefined;
    } finally {
      setLoading(false);
    }
  }, []);

  const saveInstructionFile = useCallback(async (request: SaveInstructionFileRequest) => {
    setLoading(true);
    setError(null);
    try {
      const next = await window.piDesktop.saveInstructionFile(request);
      setSnapshot(next);
      return next;
    } catch (saveError) {
      setError(errorMessage(saveError));
      return undefined;
    } finally {
      setLoading(false);
    }
  }, []);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const next = await window.piDesktop.reloadSettings();
      setSnapshot(next);
      return next;
    } catch (reloadError) {
      setError(errorMessage(reloadError));
      return undefined;
    } finally {
      setLoading(false);
    }
  }, []);

  const login = useCallback(async (providerId: string, type: AuthType) => {
    setError(null);
    try {
      await window.piDesktop.loginProvider(providerId, type);
    } catch (loginError) {
      setError(errorMessage(loginError));
    }
  }, []);

  const logout = useCallback(async (providerId: string) => {
    setError(null);
    try {
      setSnapshot(await window.piDesktop.logoutProvider(providerId));
    } catch (logoutError) {
      setError(errorMessage(logoutError));
    }
  }, []);

  const respondAuth = useCallback(async (response: AuthPromptResponse) => {
    await window.piDesktop.respondAuthPrompt(response);
  }, []);

  const cancelAuth = useCallback(async () => {
    await window.piDesktop.cancelAuth();
  }, []);

  const documentFor = useCallback((target: ConfigTarget) => {
    if (!snapshot) return null;
    if (target === "global-settings") return snapshot.globalSettings;
    if (target === "project-settings") return snapshot.projectSettings;
    return target === "models" ? snapshot.models : snapshot.fff;
  }, [snapshot]);

  return { snapshot, loading, error, authFlow, load, save, saveInstructionFile, reload, login, logout, respondAuth, cancelAuth, documentFor };
}
