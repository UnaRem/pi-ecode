import { CircleCheck, CircleX, Clock3, Search, SlidersHorizontal, Square } from "lucide-react";
import { useEffect, useState } from "react";
import type { ProjectAgentCatalog, ProjectAgentDefinition } from "@shared/agent-contracts";
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

function roleText(role: ProjectAgentDefinition["role"], t: Translate): string {
  if (role === "explorer") return t("agent.role.explorer");
  if (role === "validator") return t("agent.role.validator");
  if (role === "reviewer") return t("agent.role.reviewer");
  return t("agent.role.editor");
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

function taskButton(
  task: ExplorerTask,
  selectedTaskId: string | null,
  now: number,
  t: Translate,
  onSelect: (taskId: string) => void,
  onStop: (taskId: string) => void,
  history = false,
) {
  const inactive = task.status === "running" && now - (task.lastActivityAt ?? task.startedAt ?? now) >= INACTIVITY_WARNING_MS;
  const activity = inactive ? t("explorer.inactive") : task.activity ?? statusText(task.status, t);
  return <article className={`${history ? "explorer-history-task " : ""}${task.status} ${task.id === selectedTaskId ? "selected" : ""}`} key={task.id}>
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
}

function sessionSummary(tasks: ExplorerTask[], t: Translate): string {
  const sessionCount = new Set(tasks.map((task) => task.sessionId).filter(Boolean)).size;
  if (sessionCount === 0) return t("explorer.contextUnused");
  return t("explorer.contextSummary", { sessions: sessionCount, tasks: tasks.length });
}

function AgentRow({
  agent,
  tasks,
  selectedTaskId,
  now,
  t,
  onSelect,
  onStop,
}: {
  agent: ProjectAgentDefinition;
  tasks: ExplorerTask[];
  selectedTaskId: string | null;
  now: number;
  t: Translate;
  onSelect: (taskId: string) => void;
  onStop: (taskId: string) => void;
}) {
  const activeTask = tasks.find((task) => task.status === "running" || task.status === "queued") ?? tasks.at(-1);
  const status = activeTask ? statusText(activeTask.status, t) : t("explorer.status.idle");
  return <article className={`explorer-agent-row ${activeTask?.status ?? "idle"}`}>
    <div className="explorer-agent-main">
      <span className="explorer-task-icon"><StatusIcon status={activeTask?.status ?? "completed"} /></span>
      <button type="button" className="explorer-agent-select" disabled={!activeTask} onClick={() => activeTask && onSelect(activeTask.id)}>
        <strong>{agent.name}</strong>
        <small>{roleText(agent.role, t)} · {status}</small>
        <small>{sessionSummary(tasks, t)}</small>
      </button>
      {activeTask && <time>{elapsedLabel(activeTask.startedAt, activeTask.endedAt, now)}</time>}
      {activeTask && (activeTask.status === "queued" || activeTask.status === "running") && <button type="button" className="explorer-task-stop" onClick={() => onStop(activeTask.id)} aria-label={`${t("explorer.stop")}: ${agent.name}`} title={t("explorer.stop")}><Square size={10} fill="currentColor" /></button>}
    </div>
    {tasks.length > 0 && <details className="explorer-agent-history">
      <summary>{t("explorer.history", { count: tasks.length })}</summary>
      <div>{tasks.map((task) => taskButton(task, selectedTaskId, now, t, onSelect, onStop, true))}</div>
    </details>}
  </article>;
}

export function ExplorerPanel({
  tasks,
  agentCatalog,
  selectedTaskId,
  onSelect,
  onStop,
  onManage,
}: {
  tasks: ExplorerTask[];
  agentCatalog?: ProjectAgentCatalog | null;
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
  const persistentAgents = agentCatalog?.agents ?? [];
  const knownAgentIds = new Set(persistentAgents.map((agent) => agent.id));
  const visibleTasks = agentCatalog
    ? tasks.filter((task) => task.status === "running" || task.status === "queued" || (task.agentId && knownAgentIds.has(task.agentId)))
    : tasks;
  const unassignedActiveTasks = agentCatalog
    ? visibleTasks.filter((task) => !task.agentId || !knownAgentIds.has(task.agentId))
    : [];
  const active = visibleTasks.filter((task) => task.status === "running").length;
  const queued = visibleTasks.filter((task) => task.status === "queued").length;
  const completed = visibleTasks.filter((task) => task.status === "completed").length;
  return (
    <section className="inspector-section explorer-panel" aria-label={t("explorer.tab")}>
      <header>
        <strong>{t("explorer.tab")}</strong>
        <span>{persistentAgents.length > 0 ? persistentAgents.length : tasks.length}</span>
        {onManage && <button type="button" className="explorer-manage" onClick={onManage}><SlidersHorizontal size={12} />{t("agent.manage")}</button>}
      </header>
      <p className="explorer-panel-summary">{t("explorer.summary", { active, queued, completed })}</p>
      <div className="explorer-task-list">
        {persistentAgents.length > 0
          ? persistentAgents.map((agent) => <AgentRow
            key={agent.id}
            agent={agent}
            tasks={visibleTasks.filter((task) => task.agentId === agent.id)}
            selectedTaskId={selectedTaskId}
            now={now}
            t={t}
            onSelect={onSelect}
            onStop={onStop}
          />)
          : null}
        {unassignedActiveTasks.map((task) => taskButton(task, selectedTaskId, now, t, onSelect, onStop))}
        {persistentAgents.length === 0 && visibleTasks.length === 0 && <p>{t("explorer.empty")}</p>}
        {!agentCatalog && visibleTasks.length > 0 && visibleTasks.map((task) => taskButton(task, selectedTaskId, now, t, onSelect, onStop))}
      </div>
    </section>
  );
}
