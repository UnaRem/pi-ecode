import {
  Check,
  CircleAlert,
  CircleDashed,
  LoaderCircle,
  ShieldCheck,
  Square,
  X,
} from "lucide-react";
import { useEffect, useState, type AnimationEvent } from "react";
import type { CandidateState, ChangeReview, ValidationState, ValidationStep } from "@shared/contracts";
import { useI18n, type Translate } from "../i18n/i18n";
import type { MessageKey } from "../i18n/messages";

const STATUS_KEYS: Record<string, MessageKey> = {
  idle: "status.idle",
  pending: "status.pending",
  running: "status.running",
  passed: "status.passed",
  failed: "status.failed",
  cancelled: "status.cancelled",
  stale: "status.stale",
  skipped: "status.skipped",
  preparing: "status.preparing",
  prepared: "status.prepared",
  ready: "status.ready",
  activating: "status.activating",
  active: "status.active",
  discarded: "status.discarded",
};

function statusLabel(status: string, t: Translate): string {
  const key = STATUS_KEYS[status];
  return key ? t(key) : status;
}

interface ValidationPanelProps {
  validation: ValidationState;
  review: ChangeReview;
  candidate: CandidateState;
  onRun: () => void;
  onStop: () => void;
  onRejectFile: (path: string) => void;
  onPrepareCandidate: () => void;
  onActivateCandidate: () => void;
  onClose: () => void;
}

function duration(value: number | null): string {
  if (value === null) return "";
  if (value < 1_000) return `${value}ms`;
  return `${(value / 1_000).toFixed(1)}s`;
}

function StepIcon({ step }: { step: ValidationStep }) {
  if (step.status === "running") return <LoaderCircle className="spin" size={14} />;
  if (step.status === "passed") return <Check size={14} />;
  if (step.status === "failed") return <CircleAlert size={14} />;
  return <CircleDashed size={14} />;
}

export function ValidationPanelPresence({ open, ...panelProps }: ValidationPanelProps & { open: boolean }) {
  const [isMounted, setIsMounted] = useState(open);
  const [isLeaving, setIsLeaving] = useState(false);

  useEffect(() => {
    if (open) {
      setIsMounted(true);
      setIsLeaving(false);
    } else if (isMounted) {
      setIsLeaving(true);
    }
  }, [isMounted, open]);

  const finishLeaving = (event: AnimationEvent<HTMLDivElement>): void => {
    if (!isLeaving || event.currentTarget !== event.target || event.animationName !== "validation-panel-leave") return;
    setIsMounted(false);
    setIsLeaving(false);
  };
  if (!isMounted) return null;
  return (
    <div className={isLeaving ? "validation-panel-shell leaving" : "validation-panel-shell"} onAnimationEnd={finishLeaving}>
      <ValidationPanel {...panelProps} />
    </div>
  );
}

export function ValidationPanel(props: ValidationPanelProps) {
  const { locale, t } = useI18n();
  const running = props.validation.status === "running";
  const activeOutput = props.validation.steps.find((step) => step.status === "running")?.output
    ?? [...props.validation.steps].reverse().find((step) => step.output)?.output
    ?? "";

  return (
    <section className="validation-panel" aria-label={t("validation.panel")}>
      <header className="validation-header">
        <div className="validation-heading">
          <ShieldCheck size={17} />
          <div>
            <strong>{t("validation.title")}</strong>
            <span>
              {props.validation.isSelfProject ? t("validation.selfPipeline") : t("validation.projectPipeline")}
            </span>
          </div>
        </div>
        <div className="validation-actions">
          {running ? (
            <button className="validation-stop" onClick={props.onStop}>
              <Square size={11} fill="currentColor" /> {t("validation.stop")}
            </button>
          ) : (
            <button className="validation-run" onClick={props.onRun} disabled={!props.validation.supported}>
              <ShieldCheck size={14} /> {t("validation.run")}
            </button>
          )}
          <button className="icon-button" onClick={props.onClose} aria-label={t("validation.close")}>
            <X size={16} />
          </button>
        </div>
      </header>

      <div className="validation-steps">
        {props.validation.steps.map((step) => (
          <div key={step.id} className={`validation-step ${step.status}`}>
            <span className="validation-step-icon"><StepIcon step={step} /></span>
            <div>
              <strong>{step.label}</strong>
              <code>{step.command}</code>
            </div>
            <small>{step.status === "skipped" ? t("validation.notConfigured") : duration(step.durationMs) || statusLabel(step.status, t)}</small>
          </div>
        ))}
      </div>

      {activeOutput && <pre className="validation-output">{activeOutput}</pre>}
      {props.validation.message && (
        <div className={`validation-message ${props.validation.status}`}>{props.validation.message}</div>
      )}

      <div className="review-section">
        <div className="review-summary">
          <strong>{t("validation.review")}</strong>
          <span>{t(props.review.files.length === 1 ? "validation.changedFile" : "validation.changedFiles", { count: props.review.files.length })}</span>
          {props.validation.isSelfProject && (
            <div className="candidate-actions">
              {props.candidate.status === "ready" ? (
                <button className="candidate-activate" onClick={props.onActivateCandidate}>{t("validation.restart")}</button>
              ) : (
                <button
                  onClick={props.onPrepareCandidate}
                  disabled={props.validation.status !== "passed" || props.candidate.status === "preparing"}
                >
                  {props.candidate.status === "preparing" ? t("validation.preparing") : t("validation.prepare")}
                </button>
              )}
            </div>
          )}
        </div>
        {props.review.files.length > 0 ? (
          <>
            <div className="review-files">
              {props.review.files.map((file) => (
                <div key={file.path} className="review-file">
                  <span className={`file-status ${file.status}`}>{file.status.slice(0, 1).toUpperCase()}</span>
                  <code>{file.path}</code>
                  <small>
                    {file.additions === null ? t("validation.binary") : <><b>+{file.additions}</b> <i>-{file.deletions}</i></>}
                  </small>
                  <button
                    className="reject-file-button"
                    onClick={() => {
                      if (window.confirm(t("validation.restoreFile", { path: file.path }))) props.onRejectFile(file.path);
                    }}
                    title={t("validation.rejectTitle")}
                  >{t("validation.reject")}</button>
                </div>
              ))}
            </div>
            <details className="patch-view">
              <summary>{t("validation.viewPatch")}{props.review.truncated ? ` · ${t("validation.truncated")}` : ""}</summary>
              <pre>{props.review.patch}</pre>
            </details>
          </>
        ) : (
          <div className="review-empty">{props.review.message ?? t("validation.noChanges")}</div>
        )}
        {props.candidate.message && <div className={`candidate-message ${props.candidate.status}`}>{props.candidate.message}</div>}
      </div>

      {props.candidate.history.length > 0 && (
        <div className="version-ledger">
          <div className="version-ledger-title">{t("validation.versionHistory")}</div>
          {props.candidate.history.slice(0, 8).map((record) => (
            <div className="version-record" key={record.id}>
              <span className={`version-status ${record.status}`} />
              <code>{record.id}</code>
              <span>{statusLabel(record.status, t)}</span>
              <time>{new Date(record.updatedAt).toLocaleString(locale)}</time>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
