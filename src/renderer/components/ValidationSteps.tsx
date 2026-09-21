import { Ban, Check, CircleAlert, CircleDashed, LoaderCircle, Minus } from "lucide-react";
import type { ValidationStep, ValidationStepStatus } from "@shared/contracts";
import { useI18n, type Translate } from "../i18n/i18n";

function statusText(status: ValidationStepStatus, t: Translate): string {
  if (status === "running") return t("status.running");
  if (status === "passed") return t("status.passed");
  if (status === "failed") return t("status.failed");
  if (status === "cancelled") return t("status.cancelled");
  if (status === "skipped") return t("status.skipped");
  return t("status.pending");
}

function StatusIcon({ status }: { status: ValidationStepStatus }) {
  if (status === "running") return <LoaderCircle className="spin" size={13} aria-hidden="true" />;
  if (status === "passed") return <Check size={13} aria-hidden="true" />;
  if (status === "failed") return <CircleAlert size={13} aria-hidden="true" />;
  if (status === "cancelled") return <Ban size={13} aria-hidden="true" />;
  if (status === "skipped") return <Minus size={13} aria-hidden="true" />;
  return <CircleDashed size={13} aria-hidden="true" />;
}

export function ValidationStepStatusIcon({ step }: { step: ValidationStep }) {
  const { t } = useI18n();
  return <span className="validation-step-status" aria-label={`${step.label}: ${statusText(step.status, t)}`}>
    <StatusIcon status={step.status} />
  </span>;
}

export function ValidationStepList({ steps, className = "validation-step-list" }: { steps: ValidationStep[]; className?: string }) {
  const { t } = useI18n();
  return <div className={className}>
    {steps.map((step) => <div key={step.id} className={step.status}>
      <ValidationStepStatusIcon step={step} />
      <span>{step.label}</span>
      <small>{statusText(step.status, t)}</small>
    </div>)}
  </div>;
}
