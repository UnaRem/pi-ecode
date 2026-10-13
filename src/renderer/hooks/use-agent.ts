import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import type { ExtensionUiResponse, ImageAttachment, ThinkingLevel } from "@shared/contracts";
import { INITIAL_AGENT_STATE, optimisticTimeline, reduceAgentEvent, type PendingPrompt } from "@renderer/lib/agent-state";

const LAST_PROJECT_KEY = "pi-ecode:last-project";

function messageFromError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function useAgent() {
  const [state, dispatch] = useReducer(reduceAgentEvent, INITIAL_AGENT_STATE);
  const [isLoading, setIsLoading] = useState(true);
  const [isLoadingOlder, setIsLoadingOlder] = useState(false);
  const switchingSession = useRef(false);
  const activeSession = useRef(state.sessionId);
  const failedPrompts = useRef(new Map<string, { prompts: PendingPrompt[]; error: string }>());
  const submissions = useRef(new Map<string, { sessionId: string | null; accepted: boolean }>());
  const timeline = useMemo(() => optimisticTimeline(state), [state.timeline, state.pendingPrompts]);

  const run = useCallback(async <T,>(operation: () => Promise<T>): Promise<T | undefined> => {
    const sessionId = activeSession.current;
    try {
      return await operation();
    } catch (error) {
      if (activeSession.current === sessionId) dispatch({ type: "error", message: messageFromError(error) });
      return undefined;
    }
  }, []);

  useEffect(() => {
    const unsubscribe = window.piDesktop.subscribe((event) => {
      if (event.type === "snapshot") activeSession.current = event.snapshot.sessionId;
      if (event.type === "timeline-upsert" && event.item.kind === "message" && event.item.message.role === "user") {
        const sessionId = event.sessionId ?? activeSession.current;
        const pending = [...submissions.current.values()].find((submission) => submission.sessionId === sessionId && !submission.accepted);
        if (pending) pending.accepted = true;
      }
      dispatch(event);
      if (event.type === "snapshot" && event.snapshot.sessionId) {
        const failed = failedPrompts.current.get(event.snapshot.sessionId);
        if (failed) {
          failedPrompts.current.delete(event.snapshot.sessionId);
          dispatch({ type: "prompt-recovered", ...failed });
        }
      }
    });
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
        activeSession.current = snapshot.sessionId;
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
      activeSession.current = snapshot.sessionId;
      dispatch({ type: "snapshot", snapshot });
    }
    setIsLoading(false);
  }, [run]);

  const newSession = useCallback(async () => {
    await run(() => window.piDesktop.newSession());
  }, [run]);

  const switchSession = useCallback(async (path: string) => {
    if (path === state.sessionFile || (!state.parallel && state.isStreaming) || switchingSession.current) return;
    switchingSession.current = true;
    try {
      // Main 广播权威快照；请求返回值不再重复应用同一份状态。
      await run(() => window.piDesktop.switchSession(path));
    } finally {
      switchingSession.current = false;
    }
  }, [run, state.isStreaming, state.sessionFile, state.parallel]);

  const deleteSession = useCallback(async (path: string) => {
    if (path === state.sessionFile || (!state.parallel && state.isStreaming)) return;
    await run(() => window.piDesktop.deleteSession(path));
  }, [run, state.isStreaming, state.sessionFile, state.parallel]);

  const stopSession = useCallback(async (path: string) => {
    await run(() => window.piDesktop.stopSession(path));
  }, [run]);

  const stopManagedProcess = useCallback(async (id: string): Promise<void> => {
    try {
      await window.piDesktop.stopManagedProcess(id);
    } catch (error) {
      dispatch({ type: "error", message: messageFromError(error) });
      // 面板需要收到拒绝才能显示停止失败并保留重试操作。
      throw error;
    }
  }, []);

  const renameSession = useCallback(async (title: string) => {
    await run(() => window.piDesktop.renameSession(title));
  }, [run]);

  const loadOlderTimeline = useCallback(async () => {
    if (!state.timelineHasMore || isLoadingOlder) return;
    const sessionId = activeSession.current;
    setIsLoadingOlder(true);
    try {
      const page = await window.piDesktop.loadOlderTimeline();
      if (activeSession.current === sessionId) dispatch({ type: "timeline-page", page });
    } catch (error) {
      if (activeSession.current === sessionId) dispatch({ type: "error", message: messageFromError(error) });
    } finally {
      setIsLoadingOlder(false);
    }
  }, [isLoadingOlder, state.timelineHasMore]);

  const continueAfterError = useCallback(async () => {
    dispatch({ type: "state", patch: { error: null, canContinue: false } });
    await run(() => window.piDesktop.continueAfterError());
  }, [run]);

  const send = useCallback(async (message: string, images: ImageAttachment[] = []) => {
    const id = `pending-user-${crypto.randomUUID()}`;
    const sessionId = activeSession.current;
    const prompt: PendingPrompt = { id, text: message, images, timestamp: Date.now(), settled: false };
    const submission = { sessionId, accepted: false };
    submissions.current.set(id, submission);
    // Show the local echo before IPC; its completion can mean queueing, not acceptance.
    dispatch({ type: "prompt-started", prompt });
    try {
      await window.piDesktop.prompt(message, images);
      dispatch({ type: "prompt-finished", id });
    } catch (error) {
      const failure = messageFromError(error);
      if (submission.accepted) {
        if (activeSession.current === sessionId) dispatch({ type: "error", message: failure });
      } else if (sessionId && activeSession.current !== sessionId) {
        const previous = failedPrompts.current.get(sessionId);
        failedPrompts.current.set(sessionId, { prompts: [...(previous?.prompts ?? []), prompt], error: failure });
      } else dispatch({ type: "prompt-failed", id, error: failure, prompt });
    } finally { submissions.current.delete(id); }
  }, []);

  const editorRestored = useCallback((version: number) => {
    dispatch({ type: "editor-restored", version });
  }, []);

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
    state: { ...state, timeline },
    isLoading,
    isLoadingOlder,
    actions: {
      chooseProject,
      newSession,
      switchSession,
      deleteSession,
      stopSession,
      stopManagedProcess,
      renameSession,
      loadOlderTimeline,
      continueAfterError,
      send,
      editorRestored,
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
