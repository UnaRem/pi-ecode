import { useEffect, useMemo, useRef, useState } from "react";
import { Check, CircleAlert, LoaderCircle, X } from "lucide-react";
import type { ConversationItem, ToolActivity } from "@shared/contracts";
import { useI18n } from "../i18n/i18n";

export function latestUnseenRunningTool(tools: ToolActivity[], seenToolIds: ReadonlySet<string>): ToolActivity | null {
  return tools.filter((tool) => tool.status === "running" && !seenToolIds.has(tool.id)).at(-1) ?? null;
}

export function toolsInSelectedTurn(timeline: ConversationItem[], selectedToolId: string | null): ToolActivity[] {
  const selectedIndex = timeline.findIndex((item) => item.kind === "tool" && item.tool.id === selectedToolId);
  if (selectedIndex < 0) return [];
  let start = 0;
  let end = timeline.length;
  for (let index = selectedIndex; index >= 0; index--) {
    const item = timeline[index];
    if (item?.kind === "message" && item.message.role === "user") {
      start = index + 1;
      break;
    }
  }
  for (let index = selectedIndex + 1; index < timeline.length; index++) {
    const item = timeline[index];
    if (item?.kind === "message" && item.message.role === "user") {
      end = index;
      break;
    }
  }
  return timeline.slice(start, end).flatMap((item) => item.kind === "tool" ? [item.tool] : []);
}

export function useToolExecution(timeline: ConversationItem[], conversationKey: string) {
  const [selectedToolId, setSelectedToolId] = useState<string | null>(null);
  const [panelOpen, setPanelOpen] = useState(false);
  const seenRunningTools = useRef(new Set<string>());
  const tools = useMemo(() => timeline.flatMap((item) => item.kind === "tool" ? [item.tool] : []), [timeline]);
  const selectedTool = tools.find((tool) => tool.id === selectedToolId) ?? null;
  const turnTools = useMemo(() => toolsInSelectedTurn(timeline, selectedToolId), [timeline, selectedToolId]);

  useEffect(() => {
    seenRunningTools.current.clear();
    setSelectedToolId(null);
    setPanelOpen(false);
  }, [conversationKey]);

  useEffect(() => {
    const latest = latestUnseenRunningTool(tools, seenRunningTools.current);
    for (const tool of tools) {
      if (tool.status === "running") seenRunningTools.current.add(tool.id);
    }
    if (!latest) return;
    setSelectedToolId(latest.id);
    setPanelOpen(true);
  }, [tools]);

  const selectTool = (toolId: string): void => {
    setSelectedToolId(toolId);
    setPanelOpen(true);
  };
  const closePanel = (): void => {
    setSelectedToolId(null);
    setPanelOpen(false);
  };
  return { selectedToolId, selectedTool, turnTools, panelOpen, selectTool, closePanel };
}

function ToolStatus({ status }: { status: ToolActivity["status"] }) {
  const { t } = useI18n();
  const label = status === "running" ? t("tool.running") : status === "error" ? t("tool.failed") : t("tool.done");
  const icon = status === "running"
    ? <LoaderCircle className="spin" size={14} aria-hidden="true" />
    : status === "error"
      ? <CircleAlert size={14} aria-hidden="true" />
      : <Check size={14} aria-hidden="true" />;
  return <span className={`tool-execution-status ${status}`}>{icon}{label}</span>;
}

export function ToolExecutionPanel({
  tool,
  turnTools,
  onSelect,
  onClose,
}: {
  tool: ToolActivity;
  turnTools: ToolActivity[];
  onSelect: (toolId: string) => void;
  onClose: () => void;
}) {
  const { t } = useI18n();
  return (
    <aside className="tool-execution-panel" aria-label={t("tool.panelTitle")}>
      <header className="tool-execution-header">
        <div><strong>{t("tool.panelTitle")}</strong><ToolStatus status={tool.status} /></div>
        <button className="icon-button" onClick={onClose} aria-label={t("tool.closePanel")}><X size={17} /></button>
      </header>
      <nav className="tool-execution-list" aria-label={t("tool.turnCalls")}>
        {turnTools.map((item, index) => (
          <button
            key={item.id}
            className={`${item.status} ${item.id === tool.id ? "selected" : ""}`}
            onClick={() => onSelect(item.id)}
            aria-current={item.id === tool.id ? "true" : undefined}
          >
            <span>{index + 1}</span>
            <strong>{item.title}</strong>
            <ToolStatus status={item.status} />
          </button>
        ))}
      </nav>
      <div className="tool-execution-detail">
        <h2>{tool.title}</h2>
        <section>
          <h3>{t("tool.input")}</h3>
          <pre>{tool.input || t("tool.noInput")}</pre>
        </section>
        <section>
          <h3>{t("tool.output")}</h3>
          <pre className="tool-execution-output">{tool.output || (tool.status === "running" ? t("tool.waitingOutput") : t("tool.noOutput"))}</pre>
        </section>
      </div>
    </aside>
  );
}
