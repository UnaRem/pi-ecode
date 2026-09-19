import { Check, CircleAlert, LoaderCircle, X } from "lucide-react";
import { useEffect, useRef, useState, type AnimationEvent } from "react";
import type { CompactionReason, CompactionStatus } from "@shared/contracts";
import { useI18n, type Translate } from "../i18n/i18n";
import type { MessageKey } from "../i18n/messages";

const ROTATING_MESSAGE_KEYS: MessageKey[] = [
  "compaction.odd.product",
  "compaction.odd.tokens",
  "compaction.odd.training",
  "compaction.odd.shortening",
  "compaction.odd.concise",
  "compaction.odd.declutter",
];

const REASON_KEYS: Record<CompactionReason, MessageKey> = {
  manual: "compaction.reason.manual",
  threshold: "compaction.reason.threshold",
  overflow: "compaction.reason.overflow",
};

const TITLE_KEYS: Record<Exclude<CompactionStatus["status"], "idle">, MessageKey> = {
  running: "compaction.title",
  completed: "compaction.completedTitle",
  failed: "compaction.failedTitle",
  cancelled: "compaction.cancelledTitle",
};

export function formatTokenCount(tokens: number): string {
  if (tokens < 1_000) return String(tokens);
  if (tokens < 1_000_000) return `${Number((tokens / 1_000).toFixed(1))}K`;
  return `${Number((tokens / 1_000_000).toFixed(1))}M`;
}

function completionMessage(status: Extract<CompactionStatus, { status: "completed" }>, t: Translate): string {
  if (status.tokensBefore === null || status.tokensAfter === null) return t("compaction.completed");
  const reduction = status.tokensBefore > 0
    ? Math.max(0, Math.round((1 - status.tokensAfter / status.tokensBefore) * 100))
    : 0;
  return t("compaction.completedDetail", {
    before: formatTokenCount(status.tokensBefore),
    after: formatTokenCount(status.tokensAfter),
    approximate: status.isEstimated ? t("compaction.approximately") : "",
    reduction,
  });
}

function statusMessage(status: Exclude<CompactionStatus, { status: "idle" }>, index: number, t: Translate): string {
  switch (status.status) {
    case "completed": return completionMessage(status, t);
    case "failed": return status.message;
    case "cancelled": return t("compaction.cancelled");
    case "running": return t(ROTATING_MESSAGE_KEYS[index] ?? "compaction.odd.product");
  }
}

function StatusIcon({ status }: { status: Exclude<CompactionStatus["status"], "idle"> }) {
  switch (status) {
    case "running": return <LoaderCircle className="spin" size={16} />;
    case "completed": return <Check size={16} />;
    case "failed": return <CircleAlert size={16} />;
    case "cancelled": return <X size={16} />;
  }
}

interface CompactionStatusPanelProps {
  status: CompactionStatus;
  onCancel: () => void;
}

export function isFreshCompactionResult(previous: CompactionStatus["status"], current: CompactionStatus["status"]): boolean {
  return previous === "running" && current !== "running" && current !== "idle";
}

export function CompactionStatusPanel({ status, onCancel }: CompactionStatusPanelProps) {
  const { t } = useI18n();
  const [messageIndex, setMessageIndex] = useState(0);
  const [visible, setVisible] = useState(status.status === "running");
  const [leaving, setLeaving] = useState(false);
  const previousStatus = useRef(status.status);

  useEffect(() => {
    if (status.status === "idle") setVisible(false);
    if (status.status !== "running") return;
    setVisible(true);
    setLeaving(false);
    setMessageIndex(0);
    const interval = window.setInterval(() => {
      setMessageIndex((current) => (current + 1) % ROTATING_MESSAGE_KEYS.length);
    }, 2_400);
    return () => window.clearInterval(interval);
  }, [status.status]);

  useEffect(() => {
    // Terminal results persist in snapshots, so only a live status transition may surface them.
    const previous = previousStatus.current;
    previousStatus.current = status.status;
    if (status.status === "idle" || status.status === "running") return;
    if (!isFreshCompactionResult(previous, status.status)) {
      setVisible(false);
      return;
    }

    setVisible(true);
    setLeaving(false);
    if (status.status === "completed") {
      const message = completionMessage(status, t);
      void window.piDesktop.notifyCompactionComplete(t("compaction.notificationTitle"), message);
      const timeout = window.setTimeout(() => setLeaving(true), 5_000);
      return () => window.clearTimeout(timeout);
    }
    if (status.status === "cancelled") {
      const timeout = window.setTimeout(() => setLeaving(true), 3_000);
      return () => window.clearTimeout(timeout);
    }
  }, [status.status]);

  if (!visible || status.status === "idle") return null;

  const isRunning = status.status === "running";

  return (
    <section
      className={`compaction-status-panel transient-panel ${status.status} ${leaving ? "leaving" : ""}`}
      role="status"
      aria-live="polite"
      inert={leaving ? true : undefined}
      onAnimationEnd={(event: AnimationEvent<HTMLElement>) => {
        if (leaving && event.animationName === "panel-leave") setVisible(false);
      }}
    >
      <div className="compaction-status-icon" aria-hidden="true">
        <StatusIcon status={status.status} />
      </div>
      <div className="compaction-status-copy">
        <div className="compaction-status-heading">
          <strong>{t(TITLE_KEYS[status.status])}</strong>
          <small>{t(REASON_KEYS[status.reason])}</small>
        </div>
        <span>{statusMessage(status, messageIndex, t)}</span>
        {isRunning && <div className="compaction-indeterminate" aria-hidden="true"><i /></div>}
      </div>
      {isRunning ? (
        <button onClick={onCancel}>{t("compaction.cancel")}</button>
      ) : (
        <button className="icon-button" onClick={() => setLeaving(true)} aria-label={t("compaction.dismiss")}>
          <X size={14} />
        </button>
      )}
    </section>
  );
}
