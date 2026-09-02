import { ChevronDown, ChevronUp } from "lucide-react";
import { useState } from "react";
import type { ConversationItem, ToolActivity } from "@shared/contracts";
import { ToolCard } from "./ToolCard";

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

export function visibleToolsInBatch(tools: ToolActivity[], expanded: boolean): ToolActivity[] {
  return tools.length > 3 && !expanded ? tools.slice(-3) : tools;
}

export function ToolBatch({ tools }: { tools: ToolActivity[] }) {
  const [expanded, setExpanded] = useState(false);
  const collapsible = tools.length > 3;
  const visibleTools = visibleToolsInBatch(tools, expanded);
  const hiddenCount = tools.length - visibleTools.length;

  return (
    <section className="tool-batch" aria-label={`${tools.length} consecutive tool calls`}>
      {collapsible && (
        <button className="tool-batch-toggle" onClick={() => setExpanded((value) => !value)} aria-expanded={expanded}>
          {expanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
          {expanded ? "Collapse tool calls" : `${hiddenCount} earlier tool calls folded`}
        </button>
      )}
      {visibleTools.map((tool) => (
        <div className="timeline-tool" key={tool.id}>
          <ToolCard tool={tool} />
        </div>
      ))}
    </section>
  );
}
