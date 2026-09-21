import { CircleCheck, CircleX, Clock3, Search, SlidersHorizontal, Square } from "lucide-react";
import { useEffect, useState } from "react";
import type { ExplorerStatus, ExplorerTask } from "@shared/contracts";
import { useI18n, type Translate } from "../i18n/i18n";

const INACTIVITY_WARNING_MS = 60_000;

function statusText(status: ExplorerStatus, t: Translate): string {
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

function elapsedLabel(startedAt: number | undefined, endedAt: number | undefined, now: number): string {
  if (!startedAt) return "";
  const seconds = Math.floor(Math.max(0, (endedAt ?? now) - startedAt) / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${seconds % 60}s`;
}

export function ExplorerPanel({
  tasks,
  selectedTaskId,
  onSelect,
  onStop,
  onManage,
}: {
  tasks: ExplorerTask[];
  selectedTaskId: string | null;
  onSelect: (taskId: string) => void;
  onStop: (taskId: string) => void;
  onManage?: () => void;
}) {
  const { t } = useI18n();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!tasks.some((task) => task.status === "running")) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [tasks]);
  const active = tasks.filter((task) => task.status === "running").length;
  const queued = tasks.filter((task) => task.status === "queued").length;
  const completed = tasks.filter((task) => task.status === "completed").length;
  return (
    <section className="inspector-section explorer-panel" aria-label={t("explorer.tab")}>
      <header>
        <strong>{t("explorer.tab")}</strong>
        <span>{tasks.length}</span>
        {onManage && <button type="button" className="explorer-manage" onClick={onManage}><SlidersHorizontal size={12} />{t("agent.manage")}</button>}
      </header>
      <p className="explorer-panel-summary">{t("explorer.summary", { active, queued, completed })}</p>
      <div className="explorer-task-list">
        {tasks.length === 0 ? <p>{t("explorer.empty")}</p> : tasks.map((task) => {
          const inactive = task.status === "running" && now - (task.lastActivityAt ?? task.startedAt ?? now) >= INACTIVITY_WARNING_MS;
          const activity = inactive ? t("explorer.inactive") : task.activity ?? statusText(task.status, t);
          return <article className={`${task.status} ${task.id === selectedTaskId ? "selected" : ""}`} key={task.id}>
            <button type="button" className="explorer-task-main" aria-pressed={task.id === selectedTaskId} onClick={() => onSelect(task.id)}>
              <span className="explorer-task-icon"><StatusIcon status={task.status} /></span>
              <span className="explorer-task-copy">
                <strong title={task.title}>{task.title}</strong>
                <small className={inactive ? "inactive" : ""} title={activity}>{activity}</small>
                <small>{t("explorer.thinking", { level: task.thinkingLevel })} · {t("explorer.attempt", { attempt: task.attempt, max: task.maxAttempts })}</small>
              </span>
              <time>{elapsedLabel(task.startedAt, task.endedAt, now)}</time>
            </button>
            {(task.status === "queued" || task.status === "running") && <button type="button" className="explorer-task-stop" onClick={() => onStop(task.id)} aria-label={`${t("explorer.stop")}: ${task.title}`} title={t("explorer.stop")}><Square size={10} fill="currentColor" /></button>}
          </article>;
        })}
      </div>
    </section>
  );
}
