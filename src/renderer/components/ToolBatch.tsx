import { useLayoutEffect, useRef } from "react";
import type { ConversationItem, ToolActivity } from "@shared/contracts";
import { ToolCard } from "./ToolCard";
import { useI18n } from "../i18n/i18n";

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

export function isToolBatchAtBottom(scrollTop: number, clientHeight: number, scrollHeight: number): boolean {
  return scrollHeight - scrollTop - clientHeight <= BOTTOM_THRESHOLD;
}

export function ToolBatch({
  tools,
  selectedToolId,
  onSelectTool,
}: {
  tools: ToolActivity[];
  selectedToolId: string | null;
  onSelectTool: (toolId: string) => void;
}) {
  const { t } = useI18n();
  const listRef = useRef<HTMLDivElement>(null);
  const followingRef = useRef(true);
  const scrollable = tools.length > SCROLLABLE_TOOL_COUNT;

  useLayoutEffect(() => {
    const list = listRef.current;
    if (!list) return;
    if (!scrollable) {
      followingRef.current = true;
      return;
    }
    if (followingRef.current) list.scrollTop = list.scrollHeight;
  }, [scrollable, tools]);

  const updateFollowing = (): void => {
    const list = listRef.current;
    if (!list) return;
    followingRef.current = isToolBatchAtBottom(list.scrollTop, list.clientHeight, list.scrollHeight);
  };

  return (
    <section className="tool-batch" aria-label={t("tool.batch", { count: tools.length })}>
      <div
        ref={listRef}
        className={scrollable ? "tool-batch-list scrollable" : "tool-batch-list"}
        onScroll={updateFollowing}
        role={scrollable ? "region" : undefined}
        aria-label={scrollable ? t("tool.batch", { count: tools.length }) : undefined}
        tabIndex={scrollable ? 0 : undefined}
      >
        {tools.map((tool) => (
          <div className="timeline-tool" key={tool.id}>
            <ToolCard
              tool={tool}
              selected={tool.id === selectedToolId}
              onSelect={() => onSelectTool(tool.id)}
            />
          </div>
        ))}
      </div>
    </section>
  );
}
