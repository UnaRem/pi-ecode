import { FolderOpen, MessageSquarePlus, PanelLeftClose, Settings, Square, Trash2 } from "lucide-react";
import type { SessionSummary, TaskPlan } from "@shared/contracts";
import type { WorkAnimatorSettings } from "@shared/work-animator";
import { TaskPlanPresence, TaskWorkStatus } from "./TaskPlanPanel";
import { formatSessionSize, LARGE_SESSION_BYTES } from "../../shared/session-size";
import { useI18n } from "../i18n/i18n";

interface SidebarProps {
  projectName: string;
  projectPath: string;
  iconSrc: string;
  sessions: SessionSummary[];
  activeSessionFile: string | null;
  disabled: boolean;
  parallel?: { runningCount: number; maxRunning: number; canCreate: boolean; reason: string | null } | undefined;
  onStopSession?: ((path: string) => void) | undefined;
  taskPlan: TaskPlan | null;
  workAnimator?: WorkAnimatorSettings | undefined;
  settingsActive: boolean;
  open: boolean;
  onChooseProject: () => void;
  onNewSession: () => void;
  onSwitchSession: (path: string) => void;
  onDeleteSession: (path: string) => void;
  onOpenSettings: () => void;
  onCollapse: () => void;
}

function relativeTime(timestamp: number, locale: string): string {
  const elapsed = Date.now() - timestamp;
  const formatter = new Intl.RelativeTimeFormat(locale, { numeric: "auto", style: "narrow" });
  if (elapsed < 60_000) return formatter.format(0, "minute");
  if (elapsed < 3_600_000) return formatter.format(-Math.floor(elapsed / 60_000), "minute");
  if (elapsed < 86_400_000) return formatter.format(-Math.floor(elapsed / 3_600_000), "hour");
  return formatter.format(-Math.floor(elapsed / 86_400_000), "day");
}

export function Sidebar(props: SidebarProps) {
  const { locale, t } = useI18n();
  return (
    <aside className="sidebar" data-region="sidebar" aria-hidden={!props.open} inert={!props.open ? true : undefined}>
      <div className="sidebar-project">
        <button className="project-button" onClick={props.onChooseProject} title={`${t("sidebar.chooseProject")}: ${props.projectPath}`}>
          <span className="project-mark"><img src={props.iconSrc} alt="" /></span>
          <span className="project-copy">
            <strong>PiECode</strong>
            <small>{props.projectName}</small>
          </span>
          <FolderOpen size={15} aria-hidden="true" />
        </button>
        <button className="icon-button sidebar-collapse" onClick={props.onCollapse} aria-label={t("sidebar.collapse")}>
          <PanelLeftClose size={17} />
        </button>
      </div>

      <button className="new-thread-button" onClick={props.onNewSession} disabled={props.parallel ? !props.parallel.canCreate : props.disabled} title={props.parallel?.reason ?? undefined}>
        <MessageSquarePlus size={16} />
        {t("sidebar.newThread")}
        <kbd>Ctrl N</kbd>
      </button>

      <div className="sidebar-label">{t("sidebar.threads")}{props.parallel && <small>{t("sidebar.parallelCount", { count: props.parallel.runningCount, max: props.parallel.maxRunning })}</small>}</div>
      {props.parallel?.reason && <p className="sidebar-parallel-note">{t("sidebar.singleSession")}</p>}
      <nav className="session-list" aria-label={t("sidebar.sessions")}>
        {props.sessions.length === 0 ? (
          <p className="sidebar-empty">{t("sidebar.empty")}</p>
        ) : (
          props.sessions.map((session) => {
            const active = session.path === props.activeSessionFile;
            const large = (session.byteSize ?? 0) >= LARGE_SESSION_BYTES;
            const size = session.byteSize == null ? t("sidebar.sizeUnknown") : formatSessionSize(session.byteSize);
            return (
              <div key={session.path} className={`session-row ${active ? "active" : ""}`}>
                <button
                  className="session-row-main"
                  onClick={() => props.onSwitchSession(session.path)}
                  disabled={!props.parallel && props.disabled}
                  title={session.workspacePath}
                >
                  <span className="session-title">{session.title}</span>
                  <time>{relativeTime(session.modifiedAt, locale)}</time>
                  <small className="session-meta" title={t("sidebar.fileSize", { size })}>
                    <span className={`session-size ${large ? "large" : ""}`}>{size}{large ? ` · ${t("sidebar.largeSession")}` : ""}</span>
                    {session.runStatus && <span className={`session-run-status ${session.runStatus}`}>{t(`sidebar.run.${session.runStatus}`)}</span>}
                  </small>
                </button>
                {session.runStatus === "running" && props.onStopSession ? (
                  <button className="session-stop-button" onClick={() => props.onStopSession?.(session.path)} aria-label={t("sidebar.stopSession", { title: session.title })} title={t("composer.stop")}>
                    <Square size={12} fill="currentColor" aria-hidden="true" />
                  </button>
                ) : !active && (
                  <button
                    className="session-delete-button"
                    onClick={async () => {
                      if (await window.piDesktop.showConfirmation({
                        message: t("sidebar.confirmDelete", { title: session.title.slice(0, 160) }),
                        confirmLabel: t("dialog.confirm"), cancelLabel: t("dialog.cancel"),
                      })) props.onDeleteSession(session.path);
                    }}
                    disabled={!props.parallel && props.disabled}
                    aria-label={t("sidebar.deleteSession")}
                    title={t("sidebar.deleteSession")}
                  >
                    <Trash2 size={13} />
                  </button>
                )}
              </div>
            );
          })
        )}
      </nav>
      <TaskWorkStatus active={props.disabled} workAnimator={props.workAnimator} />
      <TaskPlanPresence plan={props.taskPlan} active={props.disabled} />
      <button className={`sidebar-settings ${props.settingsActive ? "active" : ""}`} onClick={props.onOpenSettings}>
        <Settings size={15} />
        {t("sidebar.settings")}
      </button>
      <div className="sidebar-footer">{t("sidebar.footer")}</div>
    </aside>
  );
}
