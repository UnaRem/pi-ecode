import { CheckCircle2, CircleAlert, Clock3, ShieldCheck, Square } from "lucide-react";
import type { ValidationRunStatus, ValidationState } from "@shared/contracts";
import { useI18n, type Translate } from "../i18n/i18n";
import { ValidationStepList } from "./ValidationSteps";

function statusText(status: ValidationRunStatus, t: Translate): string {
  if (status === "running") return t("status.running");
  if (status === "passed") return t("status.passed");
  if (status === "failed") return t("status.failed");
  if (status === "cancelled") return t("status.cancelled");
  if (status === "stale") return t("status.stale");
  return t("status.idle");
}

function StatusIcon({ status }: { status: ValidationRunStatus }) {
  const common = { size: 15, "aria-hidden": true as const };
  if (status === "passed") return <CheckCircle2 {...common} />;
  if (status === "failed" || status === "stale") return <CircleAlert {...common} />;
  if (status === "cancelled") return <Square {...common} />;
  if (status === "running") return <Clock3 {...common} />;
  return <ShieldCheck {...common} />;
}

export function ValidationCard({ validation }: { validation: ValidationState }) {
  const { t } = useI18n();
  return (
    <section className={`validation-card ${validation.status}`} aria-label={t("validation.backgroundCard")}>
      <header>
        <span className="validation-card-icon"><StatusIcon status={validation.status} /></span>
        <strong>{t("validation.backgroundCard")}</strong>
        <span>{statusText(validation.status, t)}</span>
      </header>
      <ValidationStepList steps={validation.steps} className="validation-card-steps" />
      {validation.message && <p>{validation.message}</p>}
    </section>
  );
}
