import { CircleCheck, CircleX, Clock3, Search, Square } from "lucide-react";
import type { ExplorerStatus, ExplorerTask } from "@shared/contracts";
import { useI18n } from "../i18n/i18n";

function statusLabel(status: ExplorerStatus, t: ReturnType<typeof useI18n>["t"]): string {
  if (status === "queued") return t("explorer.status.queued");
  if (status === "running") return t("explorer.status.running");
  if (status === "completed") return t("explorer.status.completed");
  if (status === "failed") return t("explorer.status.failed");
  return t("explorer.status.interrupted");
}

function StatusIcon({ status }: { status: ExplorerStatus }) {
  const common = { size: 14, "aria-hidden": true as const };
  if (status === "completed") return <CircleCheck {...common} />;
  if (status === "failed") return <CircleX {...common} />;
  if (status === "interrupted") return <Square {...common} />;
  if (status === "queued") return <Clock3 {...common} />;
  return <Search {...common} />;
}

export function ExplorerCards({ tasks }: { tasks: ExplorerTask[] }) {
  const { t } = useI18n();
  if (tasks.length === 0) return null;
  return (
    <section className="explorer-cards" aria-label={t("explorer.group", { count: tasks.length })}>
      {tasks.map((task) => {
        const result = task.finalText ?? task.errorMessage;
        return (
          <article className={`explorer-card ${task.status}`} key={task.id}>
            <header>
              <span className="explorer-status-icon"><StatusIcon status={task.status} /></span>
              <strong>{task.title}</strong>
              <span className="explorer-status">{statusLabel(task.status, t)}</span>
            </header>
            <p className="explorer-scope" title={task.scope}>{task.scope}</p>
            {result && <details className="explorer-result">
              <summary>{t(task.status === "completed" ? "explorer.result" : "explorer.details")}</summary>
              <pre>{result}</pre>
            </details>}
          </article>
        );
      })}
    </section>
  );
}
