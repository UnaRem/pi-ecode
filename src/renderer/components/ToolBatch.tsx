import { useLayoutEffect, useRef, useState } from "react";
import type { ConversationItem, ToolActivity } from "@shared/contracts";
import { ToolCard } from "./ToolCard";
import { useI18n } from "../i18n/i18n";
import { useScrollFollow } from "../hooks/use-scroll-follow";

export type ConversationRenderGroup =
  | { kind: "message"; id: string; item: Extract<ConversationItem, { kind: "message" }> }
  | { kind: "tools"; id: string; tools: ToolActivity[] };

export function groupConsecutiveTools(timeline: ConversationItem[]): ConversationRenderGroup[] {
  const groups: ConversationRenderGroup[] = [];
  for (const item of timeline) {
    if (item.kind === "message") {
      groups.push({ kind: "message", id: item.id, item });
      continue;
    }
    const previous = groups.at(-1);
    if (previous?.kind === "tools") {
      previous.tools.push(item.tool);
    } else {
      groups.push({ kind: "tools", id: `tools-${item.id}`, tools: [item.tool] });
    }
  }
  return groups;
}

const BOTTOM_THRESHOLD = 8;
const SCROLLABLE_TOOL_COUNT = 4;

function formatToolDuration(tool: ToolActivity): string {
  if (!tool.startedAt) return "";
  const end = tool.endedAt ?? Date.now();
  const elapsed = Math.max(0, end - tool.startedAt);
  return elapsed < 1000 ? `${elapsed}ms` : `${(elapsed / 1000).toFixed(1)}s`;
}

export function isScrollAreaAtBottom(scrollTop: number, clientHeight: number, scrollHeight: number): boolean {
  return scrollHeight - scrollTop - clientHeight <= BOTTOM_THRESHOLD;
}

export function ToolBatch({
  tools,
  animateNewTools = false,
  selectedToolId,
  onSelectTool,
}: {
  tools: ToolActivity[];
  animateNewTools?: boolean;
  selectedToolId: string | null;
  onSelectTool: (toolId: string) => void;
}) {
  const { t } = useI18n();
  const listRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const followingRef = useRef(true);
  const knownToolIdsRef = useRef(new Set(tools.map((tool) => tool.id)));
  const [animatedToolIds, setAnimatedToolIds] = useState(() => {
    const latestTool = animateNewTools ? tools.at(-1) : undefined;
    return new Set(latestTool ? [latestTool.id] : []);
  });
  const scrollable = tools.length > SCROLLABLE_TOOL_COUNT;

  useLayoutEffect(() => {
    const newToolIds = animateNewTools
      ? tools.filter((tool) => !knownToolIdsRef.current.has(tool.id)).map((tool) => tool.id)
      : [];
    knownToolIdsRef.current = new Set(tools.map((tool) => tool.id));
    if (newToolIds.length > 0) {
      setAnimatedToolIds((current) => new Set([...current, ...newToolIds]));
    }
  }, [animateNewTools, tools]);

  useScrollFollow(listRef, contentRef, followingRef);

  const firstTool = tools[0];
  return (
    <section className="tool-batch plaintext-tool-batch" aria-label={t("tool.batch", { count: tools.length })}>
      <details className="tool-dropdown" open={false}>
        <summary>
          <span className={`tool-inline-status ${firstTool?.status ?? "success"}`} />
          <span>{firstTool?.title ?? t("tool.panelTitle")}</span>
          <span className="tool-inline-count">{t("tool.batch", { count: tools.length })}</span>
        </summary>
        <div ref={listRef} className={scrollable ? "tool-batch-list scrollable" : "tool-batch-list"} data-scroll-follow role={scrollable ? "region" : undefined} aria-label={scrollable ? t("tool.batch", { count: tools.length }) : undefined} tabIndex={scrollable ? 0 : undefined}>
          <div ref={contentRef} className="tool-batch-content">
            {tools.map((tool) => (
              <button className={`tool-plaintext-row ${tool.id === selectedToolId ? "selected" : ""} ${animatedToolIds.has(tool.id) ? "entering" : ""}`} key={tool.id} type="button" onClick={() => onSelectTool(tool.id)}>
                <span className={`tool-inline-status ${tool.status}`} />
                <span>{tool.title}</span>
                <span className="tool-inline-duration">{formatToolDuration(tool)}</span>
              </button>
            ))}
          </div>
        </div>
      </details>
    </section>
  );
}
