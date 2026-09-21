import { ArrowLeft, Search } from "lucide-react";
import { useEffect, useRef } from "react";
import type { ExplorerStatus, ExplorerTask } from "@shared/contracts";
import { useI18n } from "../i18n/i18n";

function statusLabel(status: ExplorerStatus, t: ReturnType<typeof useI18n>["t"]): string {
  if (status === "queued") return t("explorer.status.queued");
  if (status === "running") return t("explorer.status.running");
  if (status === "completed") return t("explorer.status.completed");
  if (status === "failed") return t("explorer.status.failed");
  return t("explorer.status.interrupted");
}

export function ExplorerContextBar({ task, onReturn }: { task: ExplorerTask; onReturn: () => void }) {
  const { t } = useI18n();
  const barRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    barRef.current?.focus();
  }, [task.id]);
  return (
    <div ref={barRef} className="explorer-context-bar" tabIndex={-1} role="status">
      <Search size={14} aria-hidden="true" />
      <div>
        <strong title={task.title}>{task.title}</strong>
        <span>{t("explorer.readOnly")} · {statusLabel(task.status, t)}</span>
      </div>
      <button type="button" onClick={onReturn}><ArrowLeft size={13} aria-hidden="true" />{t("explorer.return")}</button>
    </div>
  );
}
