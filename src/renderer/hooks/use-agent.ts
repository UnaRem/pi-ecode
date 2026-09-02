import { useCallback, useEffect, useReducer, useState } from "react";
import type { ExtensionUiResponse, ImageAttachment, ThinkingLevel } from "@shared/contracts";
import { INITIAL_AGENT_STATE, reduceAgentEvent } from "@renderer/lib/agent-state";

const LAST_PROJECT_KEY = "pi-ecode:last-project";

function messageFromError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function useAgent() {
  const [state, dispatch] = useReducer(reduceAgentEvent, INITIAL_AGENT_STATE);
  const [isLoading, setIsLoading] = useState(true);

  const run = useCallback(async <T,>(operation: () => Promise<T>): Promise<T | undefined> => {
    try {
      return await operation();
    } catch (error) {
      dispatch({ type: "error", message: messageFromError(error) });
      return undefined;
    }
  }, []);

  useEffect(() => {
    const unsubscribe = window.piDesktop.subscribe((event) => dispatch(event));
    const restore = async (): Promise<void> => {
      let snapshot = await run(() => window.piDesktop.getSnapshot());
      if (!snapshot?.projectPath) {
        const lastProject = localStorage.getItem(LAST_PROJECT_KEY);
        if (lastProject) {
          snapshot = await run(() => window.piDesktop.openProject(lastProject));
          if (!snapshot) localStorage.removeItem(LAST_PROJECT_KEY);
        }
      }
      if (snapshot) {
        dispatch({ type: "snapshot", snapshot });
        if (snapshot.projectPath) localStorage.setItem(LAST_PROJECT_KEY, snapshot.projectPath);
      }
      setIsLoading(false);
      if (snapshot?.projectPath) await window.piDesktop.rendererReady();
    };
    void restore();
    return unsubscribe;
  }, [run]);

  const chooseProject = useCallback(async () => {
    const path = await run(() => window.piDesktop.chooseProject());
    if (!path) return;
    setIsLoading(true);
    const snapshot = await run(() => window.piDesktop.openProject(path));
    if (snapshot) {
      localStorage.setItem(LAST_PROJECT_KEY, path);
      dispatch({ type: "snapshot", snapshot });
    }
    setIsLoading(false);
  }, [run]);

  const newSession = useCallback(async () => {
    const snapshot = await run(() => window.piDesktop.newSession());
    if (snapshot) dispatch({ type: "snapshot", snapshot });
  }, [run]);

  const switchSession = useCallback(async (path: string) => {
    if (path === state.sessionFile || state.isStreaming) return;
    const snapshot = await run(() => window.piDesktop.switchSession(path));
    if (snapshot) dispatch({ type: "snapshot", snapshot });
  }, [run, state.isStreaming, state.sessionFile]);

  const send = useCallback(async (message: string, images: ImageAttachment[] = []) => {
    dispatch({ type: "state", patch: { error: null } });
    await run(() => window.piDesktop.prompt(message, images));
  }, [run]);

  const compact = useCallback(async () => {
    await run(() => window.piDesktop.compact());
  }, [run]);

  const cancelCompact = useCallback(async () => {
    await run(() => window.piDesktop.cancelCompact());
  }, [run]);

  const stop = useCallback(async () => {
    await run(() => window.piDesktop.stop());
  }, [run]);

  const respondExtensionUi = useCallback(async (response: ExtensionUiResponse) => {
    await run(() => window.piDesktop.respondExtensionUi(response));
  }, [run]);

  const setModel = useCallback(async (value: string) => {
    const separator = value.indexOf("/");
    if (separator < 1) return;
    await run(() => window.piDesktop.setModel(value.slice(0, separator), value.slice(separator + 1)));
  }, [run]);

  const setThinkingLevel = useCallback(async (level: ThinkingLevel) => {
    await run(() => window.piDesktop.setThinkingLevel(level));
  }, [run]);

  const undo = useCallback(async () => {
    await run(() => window.piDesktop.undo());
  }, [run]);

  const redo = useCallback(async () => {
    await run(() => window.piDesktop.redo());
  }, [run]);

  const runValidation = useCallback(async () => {
    await run(() => window.piDesktop.runValidation());
  }, [run]);

  const stopValidation = useCallback(async () => {
    await run(() => window.piDesktop.stopValidation());
  }, [run]);

  const getReview = useCallback(async () => {
    await run(() => window.piDesktop.getReview());
  }, [run]);

  const rejectReviewFile = useCallback(async (path: string) => {
    await run(() => window.piDesktop.rejectReviewFile(path));
  }, [run]);

  const prepareCandidate = useCallback(async () => {
    await run(() => window.piDesktop.prepareCandidate());
  }, [run]);

  const activateCandidate = useCallback(async () => {
    await run(() => window.piDesktop.activateCandidate());
  }, [run]);

  return {
    state,
    isLoading,
    actions: {
      chooseProject,
      newSession,
      switchSession,
      send,
      compact,
      cancelCompact,
      stop,
      respondExtensionUi,
      setModel,
      setThinkingLevel,
      undo,
      redo,
      runValidation,
      stopValidation,
      getReview,
      rejectReviewFile,
      prepareCandidate,
      activateCandidate,
    },
  };
}
