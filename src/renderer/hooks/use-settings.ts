import { useCallback, useEffect, useState } from "react";
import type { ConfigTarget, SaveConfigRequest, SettingsSnapshot } from "@shared/settings-contracts";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function useSettings(enabled: boolean) {
  const [snapshot, setSnapshot] = useState<SettingsSnapshot | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

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

  const documentFor = useCallback((target: ConfigTarget) => {
    if (!snapshot) return null;
    if (target === "global-settings") return snapshot.globalSettings;
    if (target === "project-settings") return snapshot.projectSettings;
    return target === "models" ? snapshot.models : snapshot.fff;
  }, [snapshot]);

  return { snapshot, loading, error, load, save, reload, documentFor };
}
