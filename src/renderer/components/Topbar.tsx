import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { FolderClosed, PanelLeftOpen, Pencil } from "lucide-react";
import type { RuntimePolicy } from "@shared/contracts";
import { useI18n } from "../i18n/i18n";

interface TopbarProps {
  sidebarOpen: boolean;
  projectName: string;
  projectPath: string;
  sessionTitle: string | null;
  policy: RuntimePolicy;
  onOpenSidebar: () => void;
  onRenameSession: (title: string) => void;
}

export function normalizeSessionTitle(title: string): string {
  return title.replace(/\s+/gu, " ").trim().slice(0, 80);
}

function SessionTitleEditor(props: { title: string; onRename: (title: string) => void }) {
  const { t } = useI18n();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(props.title);
  const inputRef = useRef<HTMLInputElement>(null);
  const cancelledRef = useRef(false);

  useEffect(() => {
    if (!editing) setDraft(props.title);
    else requestAnimationFrame(() => inputRef.current?.select());
  }, [editing, props.title]);

  const finish = (): void => {
    setEditing(false);
    if (cancelledRef.current) {
      cancelledRef.current = false;
      setDraft(props.title);
      return;
    }
    const normalizedTitle = normalizeSessionTitle(draft);
    if (normalizedTitle !== props.title) props.onRename(normalizedTitle);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === "Enter") event.currentTarget.blur();
    if (event.key !== "Escape") return;
    cancelledRef.current = true;
    event.currentTarget.blur();
  };

  if (editing) return <input ref={inputRef} className="session-title-input" value={draft} maxLength={80} onChange={(event) => setDraft(event.target.value)} onBlur={finish} onKeyDown={onKeyDown} aria-label={t("topbar.renameSession")} />;
  return (
    <span className="session-title-display">
      <strong title={props.title}>{props.title}</strong>
      <button onClick={() => setEditing(true)} aria-label={t("topbar.renameSession")} title={t("topbar.renameSession")}><Pencil size={12} /></button>
    </span>
  );
}

export function Topbar(props: TopbarProps) {
  const { t } = useI18n();
  return (
    <header className="topbar" data-region="topbar">
      <div className="topbar-title">
        {!props.sidebarOpen && (
          <button className="icon-button" onClick={props.onOpenSidebar} aria-label={t("topbar.openSidebar")}>
            <PanelLeftOpen size={18} />
          </button>
        )}
        <FolderClosed className="topbar-project-icon" size={16} aria-hidden="true" />
        <strong className="topbar-project-name" title={props.projectPath}>{props.projectName}</strong>
        <span className="topbar-divider" aria-hidden="true" />
        <SessionTitleEditor title={props.sessionTitle || t("topbar.newThread")} onRename={props.onRenameSession} />
        <span
          className={`policy-indicator ${props.policy.contextFiles.length > 0 ? "loaded" : "missing"}`}
          title={props.policy.contextFiles.length > 0
            ? t("topbar.loadedContext", { files: props.policy.contextFiles.join("\n") })
            : t("topbar.noContext")}
        >
          {props.policy.contextFiles.length > 0 ? t("topbar.contextLoaded") : t("topbar.noPrompt")}
        </span>
      </div>

    </header>
  );
}
