import { useState, type AnimationEvent } from "react";
import { FolderOpen, MessageSquarePlus, PanelLeftClose, Settings, Trash2 } from "lucide-react";
import type { SessionSummary, TaskPlan } from "@shared/contracts";
import { TaskPlanPresence } from "./TaskPlanPanel";
import { useI18n } from "../i18n/i18n";

interface SidebarProps {
  projectName: string;
  projectPath: string;
  sessions: SessionSummary[];
  activeSessionFile: string | null;
  disabled: boolean;
  taskPlan: TaskPlan | null;
  settingsActive: boolean;
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
  const [isClosing, setIsClosing] = useState(false);
  const finishClosing = (event: AnimationEvent<HTMLElement>): void => {
    if (isClosing && event.currentTarget === event.target) props.onCollapse();
  };
  return (
    <aside className={`sidebar ${isClosing ? "closing" : ""}`} onAnimationEnd={finishClosing}>
      <div className="sidebar-project">
        <button className="project-button" onClick={props.onChooseProject} title={`${t("sidebar.chooseProject")}: ${props.projectPath}`}>
          <span className="project-mark"><img src="./ecode-icon.png" alt="" /></span>
          <span className="project-copy">
            <strong>{props.projectName}</strong>
            <small>{props.projectPath}</small>
          </span>
          <FolderOpen size={15} aria-hidden="true" />
        </button>
        <button className="icon-button sidebar-collapse" onClick={() => setIsClosing(true)} disabled={isClosing} aria-label={t("sidebar.collapse")}>
          <PanelLeftClose size={17} />
        </button>
      </div>

      <button className="new-thread-button" onClick={props.onNewSession} disabled={props.disabled}>
        <MessageSquarePlus size={16} />
        {t("sidebar.newThread")}
        <kbd>Ctrl N</kbd>
      </button>

      <div className="sidebar-label">{t("sidebar.threads")}</div>
      <nav className="session-list" aria-label={t("sidebar.sessions")}>
        {props.sessions.length === 0 ? (
          <p className="sidebar-empty">{t("sidebar.empty")}</p>
        ) : (
          props.sessions.map((session) => {
            const active = session.path === props.activeSessionFile;
            return (
              <div key={session.path} className={`session-row ${active ? "active" : ""}`}>
                <button
                  className="session-row-main"
                  onClick={() => props.onSwitchSession(session.path)}
                  disabled={props.disabled}
                >
                  <span>{session.title}</span>
                  <time>{relativeTime(session.modifiedAt, locale)}</time>
                </button>
                {!active && (
                  <button
                    className="session-delete-button"
                    onClick={() => {
                      if (window.confirm(t("sidebar.confirmDelete", { title: session.title }))) props.onDeleteSession(session.path);
                    }}
                    disabled={props.disabled}
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
      <TaskPlanPresence plan={props.taskPlan} active={props.disabled} />
      <button className={`sidebar-settings ${props.settingsActive ? "active" : ""}`} onClick={props.onOpenSettings}>
        <Settings size={15} />
        {t("sidebar.settings")}
      </button>
      <div className="sidebar-footer">{t("sidebar.footer")}</div>
    </aside>
  );
}
