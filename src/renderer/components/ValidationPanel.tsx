import {
  Check,
  CircleAlert,
  CircleDashed,
  LoaderCircle,
  ShieldCheck,
  Square,
  X,
} from "lucide-react";
import type { CandidateState, ChangeReview, ValidationState, ValidationStep } from "@shared/contracts";

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

export function ValidationPanel(props: ValidationPanelProps) {
  const running = props.validation.status === "running";
  const activeOutput = props.validation.steps.find((step) => step.status === "running")?.output
    ?? [...props.validation.steps].reverse().find((step) => step.output)?.output
    ?? "";

  return (
    <section className="validation-panel" aria-label="Project validation">
      <header className="validation-header">
        <div className="validation-heading">
          <ShieldCheck size={17} />
          <div>
            <strong>Verification</strong>
            <span>
              {props.validation.isSelfProject ? "pi-ecode self-hosting pipeline" : "Project validation pipeline"}
            </span>
          </div>
        </div>
        <div className="validation-actions">
          {running ? (
            <button className="validation-stop" onClick={props.onStop}>
              <Square size={11} fill="currentColor" /> Stop
            </button>
          ) : (
            <button className="validation-run" onClick={props.onRun} disabled={!props.validation.supported}>
              <ShieldCheck size={14} /> Run checks
            </button>
          )}
          <button className="icon-button" onClick={props.onClose} aria-label="Close verification panel">
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
            <small>{step.status === "skipped" ? "not configured" : duration(step.durationMs) || step.status}</small>
          </div>
        ))}
      </div>

      {activeOutput && <pre className="validation-output">{activeOutput}</pre>}
      {props.validation.message && (
        <div className={`validation-message ${props.validation.status}`}>{props.validation.message}</div>
      )}

      <div className="review-section">
        <div className="review-summary">
          <strong>Change review</strong>
          <span>{props.review.files.length} changed {props.review.files.length === 1 ? "file" : "files"}</span>
          {props.validation.isSelfProject && (
            <div className="candidate-actions">
              {props.candidate.status === "ready" ? (
                <button className="candidate-activate" onClick={props.onActivateCandidate}>Restart into candidate</button>
              ) : (
                <button
                  onClick={props.onPrepareCandidate}
                  disabled={props.validation.status !== "passed" || props.candidate.status === "preparing"}
                >
                  {props.candidate.status === "preparing" ? "Preparing…" : "Prepare candidate"}
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
                    {file.additions === null ? "binary" : <><b>+{file.additions}</b> <i>-{file.deletions}</i></>}
                  </small>
                  <button
                    className="reject-file-button"
                    onClick={() => {
                      if (window.confirm(`Restore ${file.path} to its pre-task state?`)) props.onRejectFile(file.path);
                    }}
                    title="Reject changes in this file"
                  >Reject</button>
                </div>
              ))}
            </div>
            <details className="patch-view">
              <summary>View unified patch{props.review.truncated ? " · truncated" : ""}</summary>
              <pre>{props.review.patch}</pre>
            </details>
          </>
        ) : (
          <div className="review-empty">{props.review.message ?? "No source changes to review."}</div>
        )}
        {props.candidate.message && <div className={`candidate-message ${props.candidate.status}`}>{props.candidate.message}</div>}
      </div>

      {props.candidate.history.length > 0 && (
        <div className="version-ledger">
          <div className="version-ledger-title">Version history</div>
          {props.candidate.history.slice(0, 8).map((record) => (
            <div className="version-record" key={record.id}>
              <span className={`version-status ${record.status}`} />
              <code>{record.id}</code>
              <span>{record.status}</span>
              <time>{new Date(record.updatedAt).toLocaleString()}</time>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
