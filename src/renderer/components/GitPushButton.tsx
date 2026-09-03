import { Check, LoaderCircle, Upload } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { ProjectGitStatus, ValidationState } from "@shared/contracts";
import { useI18n, type Translate } from "../i18n/i18n";

interface GitPushButtonProps {
  projectKey: string;
  disabled: boolean;
  validationStatus: ValidationState["status"];
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function statusTitle(status: ProjectGitStatus | null, t: Translate): string {
  if (!status) return t("git.loading");
  if (status.availability === "not-repository") return t("git.notRepository");
  if (status.availability === "detached") return t("git.detached");
  if (status.availability === "no-upstream") return t("git.noUpstream");
  if (status.availability === "error") return status.message ?? t("git.notRepository");
  if (status.behind > 0) return t("git.behind", { count: status.behind });
  if (status.ahead === 0) return t("git.synced");
  return t("git.pushTitle", { count: status.ahead, branch: status.branch ?? "", upstream: status.upstream ?? "" });
}

export function GitPushButton(props: GitPushButtonProps) {
  const { t } = useI18n();
  const [status, setStatus] = useState<ProjectGitStatus | null>(null);
  const [isPushing, setIsPushing] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const requestIdRef = useRef(0);
  const projectKeyRef = useRef(props.projectKey);
  projectKeyRef.current = props.projectKey;

  const refresh = useCallback(async (): Promise<void> => {
    const requestId = ++requestIdRef.current;
    try {
      const nextStatus = await window.piDesktop.getProjectGitStatus();
      if (requestId === requestIdRef.current) {
        setStatus(nextStatus);
        setFailure(null);
      }
    } catch (error) {
      if (requestId === requestIdRef.current) setFailure(errorText(error));
    }
  }, []);

  useEffect(() => {
    setStatus(null);
    setFailure(null);
  }, [props.projectKey]);

  useEffect(() => {
    if (!props.disabled) void refresh();
  }, [props.disabled, props.projectKey, refresh]);

  useEffect(() => {
    const onFocus = (): void => { if (!props.disabled && !isPushing) void refresh(); };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [isPushing, props.disabled, refresh]);

  const push = async (): Promise<void> => {
    if (!status?.branch || !status.upstream || status.availability !== "ready" || status.ahead === 0) return;
    const validationNote = props.validationStatus === "passed" ? t("git.validationPassed") : t("git.validationWarning");
    if (!window.confirm(`${t("git.confirm", { count: status.ahead, branch: status.branch, upstream: status.upstream })}\n\n${validationNote}`)) return;
    const projectKey = props.projectKey;
    setIsPushing(true);
    setFailure(null);
    try {
      const nextStatus = await window.piDesktop.pushProject();
      if (projectKeyRef.current === projectKey) setStatus(nextStatus);
    } catch (error) {
      if (projectKeyRef.current === projectKey) setFailure(t("git.pushFailed", { message: errorText(error) }));
    } finally {
      if (projectKeyRef.current === projectKey) setIsPushing(false);
    }
  };

  const isReady = status?.availability === "ready" && status.ahead > 0 && status.behind === 0;
  const isSynced = status?.availability === "ready" && status.ahead === 0 && status.behind === 0;
  const title = failure ?? statusTitle(status, t);
  const label = isPushing ? t("git.pushing") : isSynced ? t("git.synced") : isReady ? t("git.pushCount", { count: status.ahead }) : t("git.push");
  return (
    <span className="git-push-control">
      <button className={`git-push-button ${isReady ? "ready" : ""} ${isSynced ? "synced" : ""}`} disabled={props.disabled || isPushing || !isReady} onClick={() => void push()} title={title} aria-label={title}>
        {isPushing ? <LoaderCircle className="spin" size={15} /> : isSynced ? <Check size={15} /> : <Upload size={15} />}
        <span>{label}</span>
      </button>
      {failure && <span className="git-push-error" role="alert">{failure}</span>}
    </span>
  );
}
