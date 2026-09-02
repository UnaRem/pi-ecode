import { Check, CircleAlert, LoaderCircle, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
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

export function CompactionStatusPanel({ status, onCancel }: CompactionStatusPanelProps) {
  const { t } = useI18n();
  const [messageIndex, setMessageIndex] = useState(0);
  const [visible, setVisible] = useState(status.status !== "idle");
  const completionNotified = useRef(false);

  useEffect(() => {
    setVisible(status.status !== "idle");
    if (status.status !== "running") return;
    setMessageIndex(0);
    const interval = window.setInterval(() => {
      setMessageIndex((current) => (current + 1) % ROTATING_MESSAGE_KEYS.length);
    }, 2_400);
    return () => window.clearInterval(interval);
  }, [status.status]);

  useEffect(() => {
    if (status.status !== "completed") {
      completionNotified.current = false;
      if (status.status !== "cancelled") return;
      const timeout = window.setTimeout(() => setVisible(false), 3_000);
      return () => window.clearTimeout(timeout);
    }
    const message = completionMessage(status, t);
    if (!completionNotified.current) {
      completionNotified.current = true;
      void window.piDesktop.notifyCompactionComplete(t("compaction.notificationTitle"), message);
    }
    const timeout = window.setTimeout(() => setVisible(false), 5_000);
    return () => window.clearTimeout(timeout);
  }, [status, t]);

  if (!visible || status.status === "idle") return null;

  const isRunning = status.status === "running";

  return (
    <section className={`compaction-status-panel ${status.status}`} role="status" aria-live="polite">
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
        <button className="icon-button" onClick={() => setVisible(false)} aria-label={t("compaction.dismiss")}>
          <X size={14} />
        </button>
      )}
    </section>
  );
}
