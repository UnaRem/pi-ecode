import { useEffect, useLayoutEffect, useMemo, useRef, useState, type AnimationEvent } from "react";
import { Check, CircleAlert, LoaderCircle, X } from "lucide-react";
import type { ConversationItem, ToolActivity } from "@shared/contracts";
import { useI18n } from "../i18n/i18n";
import { isScrollAreaAtBottom } from "./ToolBatch";

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
  const closePanel = (): void => setPanelOpen(false);
  return {
    selectedToolId: panelOpen ? selectedToolId : null,
    selectedTool,
    turnTools,
    panelOpen,
    selectTool,
    closePanel,
  };
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

interface ToolExecutionPanelProps {
  tool: ToolActivity;
  turnTools: ToolActivity[];
  onSelect: (toolId: string) => void;
  onClose: () => void;
  leaving?: boolean;
  onAnimationEnd?: (event: AnimationEvent<HTMLElement>) => void;
}

export function ToolExecutionPanelPresence({
  open,
  tool,
  turnTools,
  onSelect,
  onClose,
}: Omit<ToolExecutionPanelProps, "tool" | "leaving" | "onAnimationEnd"> & { open: boolean; tool: ToolActivity | null }) {
  const [mounted, setMounted] = useState(open && tool !== null);
  const [leaving, setLeaving] = useState(false);

  useEffect(() => {
    if (open && tool) {
      setMounted(true);
      setLeaving(false);
    } else if (mounted) {
      setLeaving(true);
    }
  }, [mounted, open, tool?.id]);

  const finishLeaving = (event: AnimationEvent<HTMLElement>): void => {
    if (!leaving || event.currentTarget !== event.target || !["tool-panel-leave", "tool-drawer-leave"].includes(event.animationName)) return;
    setMounted(false);
    setLeaving(false);
  };
  if (!mounted || !tool) return null;
  return (
    <ToolExecutionPanel
      tool={tool}
      turnTools={turnTools}
      onSelect={onSelect}
      onClose={onClose}
      leaving={leaving}
      onAnimationEnd={finishLeaving}
    />
  );
}

export function ToolExecutionPanel({
  tool,
  turnTools,
  onSelect,
  onClose,
  leaving = false,
  onAnimationEnd,
}: ToolExecutionPanelProps) {
  const { t } = useI18n();
  const selectedToolButtonRef = useRef<HTMLButtonElement>(null);
  const detailRef = useRef<HTMLDivElement>(null);
  const followingDetailRef = useRef(true);
  const previousToolIdRef = useRef(tool.id);
  const outputRequestRef = useRef(0);
  const [fullOutput, setFullOutput] = useState<{ toolId: string; text: string } | null>(null);
  const [outputLoading, setOutputLoading] = useState(false);
  const [outputError, setOutputError] = useState<string | null>(null);

  useLayoutEffect(() => {
    selectedToolButtonRef.current?.scrollIntoView({ block: "nearest" });
  }, [tool.id, turnTools.length]);

  useEffect(() => {
    outputRequestRef.current += 1;
    setFullOutput(null);
    setOutputLoading(false);
    setOutputError(null);
  }, [tool.id]);

  useLayoutEffect(() => {
    const detail = detailRef.current;
    if (!detail) return;
    if (previousToolIdRef.current !== tool.id) {
      previousToolIdRef.current = tool.id;
      followingDetailRef.current = true;
    }
    if (followingDetailRef.current) detail.scrollTop = detail.scrollHeight;
  }, [tool.id, tool.output, tool.status]);

  const updateDetailFollowing = (): void => {
    const detail = detailRef.current;
    if (!detail) return;
    followingDetailRef.current = isScrollAreaAtBottom(detail.scrollTop, detail.clientHeight, detail.scrollHeight);
  };

  const loadFullOutput = async (): Promise<void> => {
    const request = ++outputRequestRef.current;
    setOutputLoading(true);
    setOutputError(null);
    try {
      const text = await window.piDesktop.getToolOutput(tool.id);
      if (outputRequestRef.current === request) setFullOutput({ toolId: tool.id, text });
    } catch (error) {
      if (outputRequestRef.current === request) setOutputError(error instanceof Error ? error.message : String(error));
    } finally {
      if (outputRequestRef.current === request) setOutputLoading(false);
    }
  };

  const displayedOutput = fullOutput?.toolId === tool.id ? fullOutput.text : tool.output;

  return (
    <aside
      className={leaving ? "tool-execution-panel leaving" : "tool-execution-panel"}
      aria-label={t("tool.panelTitle")}
      onAnimationEnd={onAnimationEnd}
    >
      <header className="tool-execution-header">
        <div><strong>{t("tool.panelTitle")}</strong><ToolStatus status={tool.status} /></div>
        <button className="icon-button" onClick={onClose} aria-label={t("tool.closePanel")}><X size={17} /></button>
      </header>
      <nav className="tool-execution-list" aria-label={t("tool.turnCalls")}>
        {turnTools.map((item, index) => (
          <button
            key={item.id}
            ref={item.id === tool.id ? selectedToolButtonRef : undefined}
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
      <div ref={detailRef} className="tool-execution-detail" onScroll={updateDetailFollowing}>
        <h2>{tool.title}</h2>
        <section>
          <h3>{t("tool.input")}</h3>
          <pre>{tool.input || t("tool.noInput")}</pre>
        </section>
        <section>
          <h3>{t("tool.output")}</h3>
          {tool.outputTruncated && fullOutput?.toolId !== tool.id && (
            <div className="tool-output-truncated">
              <span>{t("tool.outputTruncated", { count: tool.outputLength ?? tool.output.length })}</span>
              {tool.status !== "running" && (
                <button type="button" disabled={outputLoading} onClick={() => void loadFullOutput()}>
                  {t(outputLoading ? "tool.loadingFullOutput" : "tool.loadFullOutput")}
                </button>
              )}
            </div>
          )}
          {outputError && <div className="tool-output-error" role="alert">{outputError}</div>}
          <pre className="tool-execution-output">{displayedOutput || (tool.status === "running" ? t("tool.waitingOutput") : t("tool.noOutput"))}</pre>
        </section>
      </div>
    </aside>
  );
}
