import { FolderOpen, MessageSquarePlus, PanelLeftClose } from "lucide-react";
import type { SessionSummary, TaskPlan } from "@shared/contracts";
import { TaskPlanPanel } from "./TaskPlanPanel";

interface SidebarProps {
  projectName: string;
  projectPath: string;
  sessions: SessionSummary[];
  activeSessionFile: string | null;
  disabled: boolean;
  taskPlan: TaskPlan | null;
  onChooseProject: () => void;
  onNewSession: () => void;
  onSwitchSession: (path: string) => void;
  onCollapse: () => void;
}

function relativeTime(timestamp: number): string {
  const elapsed = Date.now() - timestamp;
  if (elapsed < 60_000) return "now";
  if (elapsed < 3_600_000) return `${Math.floor(elapsed / 60_000)}m`;
  if (elapsed < 86_400_000) return `${Math.floor(elapsed / 3_600_000)}h`;
  return `${Math.floor(elapsed / 86_400_000)}d`;
}

export function Sidebar(props: SidebarProps) {
  return (
    <aside className="sidebar">
      <div className="sidebar-project">
        <button className="project-button" onClick={props.onChooseProject} title={props.projectPath}>
          <span className="project-mark">π</span>
          <span className="project-copy">
            <strong>{props.projectName}</strong>
            <small>{props.projectPath}</small>
          </span>
          <FolderOpen size={15} aria-hidden="true" />
        </button>
        <button className="icon-button sidebar-collapse" onClick={props.onCollapse} aria-label="Collapse sidebar">
          <PanelLeftClose size={17} />
        </button>
      </div>

      <button className="new-thread-button" onClick={props.onNewSession} disabled={props.disabled}>
        <MessageSquarePlus size={16} />
        New thread
        <kbd>Ctrl N</kbd>
      </button>

      <div className="sidebar-label">Threads</div>
      <nav className="session-list" aria-label="Conversation sessions">
        {props.sessions.length === 0 ? (
          <p className="sidebar-empty">Your conversations will appear here.</p>
        ) : (
          props.sessions.map((session) => (
            <button
              key={session.path}
              className={`session-row ${session.path === props.activeSessionFile ? "active" : ""}`}
              onClick={() => props.onSwitchSession(session.path)}
              disabled={props.disabled}
            >
              <span>{session.title}</span>
              <time>{relativeTime(session.modifiedAt)}</time>
            </button>
          ))
        )}
      </nav>
      {props.taskPlan && <TaskPlanPanel plan={props.taskPlan} />}
      <div className="sidebar-footer">Local sessions · pi</div>
    </aside>
  );
}
