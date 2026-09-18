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
const SCROLLABLE_TOOL_COUNT = 3;

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

  return (
    <section className="tool-batch" aria-label={t("tool.batch", { count: tools.length })}>
      <div
        ref={listRef}
        className={scrollable ? "tool-batch-list scrollable" : "tool-batch-list"}
        data-scroll-follow
        role={scrollable ? "region" : undefined}
        aria-label={scrollable ? t("tool.batch", { count: tools.length }) : undefined}
        tabIndex={scrollable ? 0 : undefined}
      >
        <div ref={contentRef} className="tool-batch-content">
          {tools.map((tool) => (
            <div className={animatedToolIds.has(tool.id) ? "timeline-tool entering" : "timeline-tool"} key={tool.id}>
              <div className="tool-card-reveal">
                <ToolCard
                  tool={tool}
                  selected={tool.id === selectedToolId}
                  onSelect={() => onSelectTool(tool.id)}
                />
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
