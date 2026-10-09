import { useRef, useState } from "react";
import type { ManagedProcess, ManagedProcessStatus } from "@shared/process-contracts";
import { useScrollFollow } from "../hooks/use-scroll-follow";
import { useI18n } from "../i18n/i18n";

interface ManagedProcessPanelProps {
  processes: ManagedProcess[];
  onStop: (id: string) => Promise<void>;
}

const activeStatuses: ManagedProcessStatus[] = ["starting", "running", "stopping"];

function ProcessLogs({ process }: { process: ManagedProcess }) {
  const { t } = useI18n();
  const containerRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLPreElement>(null);
  const followingRef = useRef(true);
  // The parent keys this component by process ID so each selection gets fresh observers and bottom following.
  const onWheel = useScrollFollow(containerRef, contentRef, followingRef);
  return <>
    {process.outputTruncated && <p className="managed-process-note">{t("process.truncated")}</p>}
    <div className="managed-process-logs" ref={containerRef} data-scroll-follow onWheel={onWheel}
      role="region" aria-label={t("process.logs", { command: process.command })} tabIndex={0}>
      <pre ref={contentRef}>{process.output || t("process.noOutput")}</pre>
    </div>
  </>;
}

export function ManagedProcessPanel({ processes, onStop }: ManagedProcessPanelProps) {
  const { t } = useI18n();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [pendingIds, setPendingIds] = useState<Set<string>>(new Set());
  const pendingRef = useRef(new Set<string>());
  const [stopErrors, setStopErrors] = useState<Record<string, string>>({});
  const ordered = [...processes].sort((left, right) => right.startedAt - left.startedAt);
  const selected = ordered.find((process) => process.id === selectedId)
    ?? ordered.find((process) => activeStatuses.includes(process.status)) ?? ordered[0];
  const stop = async (process: ManagedProcess): Promise<void> => {
    if (pendingRef.current.has(process.id) || !["starting", "running"].includes(process.status)) return;
    // Guard synchronously as well as disabling markup; rapid clicks can precede React's next commit.
    pendingRef.current.add(process.id);
    setPendingIds(new Set(pendingRef.current));
    setStopErrors((current) => ({ ...current, [process.id]: "" }));
    try {
      await onStop(process.id);
    } catch (error) {
      setStopErrors((current) => ({ ...current, [process.id]: error instanceof Error ? error.message : t("process.stopFailed") }));
    } finally {
      pendingRef.current.delete(process.id);
      setPendingIds(new Set(pendingRef.current));
    }
  };
  return <section className="inspector-section managed-process-panel" aria-label={t("process.title")}>
    <header><strong>{t("process.title")}</strong><span>{processes.length}</span></header>
    {selected ? <>
      <div className="managed-process-list" role="group" aria-label={t("process.title")}>
        {ordered.map((process) => <button key={process.id} type="button" aria-pressed={process.id === selected.id}
          onClick={() => setSelectedId(process.id)} title={process.command}>
          <code>{process.command}</code>
          <span>{t(`process.status.${process.status}`)}</span>
          <small>{t("process.pid", { pid: process.pid ?? "—" })}{process.exitCode !== null && ` · ${t("process.exitCode", { code: process.exitCode })}`}</small>
        </button>)}
      </div>
      <div className="managed-process-detail">
        <code className="managed-process-command">{selected.command}</code>
        <div className="managed-process-actions">
          <span>{t(`process.status.${selected.status}`)}</span>
          <button type="button" onClick={() => void stop(selected)}
            disabled={pendingIds.has(selected.id) || !["starting", "running"].includes(selected.status)}>
            {t(pendingIds.has(selected.id) || selected.status === "stopping" ? "process.stopping" : "process.stop")}
          </button>
        </div>
        {selected.errorMessage && <p className="managed-process-error" role="alert">{selected.errorMessage}</p>}
        {stopErrors[selected.id] && stopErrors[selected.id] !== selected.errorMessage && <p className="managed-process-error" role="alert">{stopErrors[selected.id]}</p>}
        <ProcessLogs key={selected.id} process={selected} />
      </div>
    </> : <p className="managed-process-empty">{t("process.empty")}</p>}
  </section>;
}
