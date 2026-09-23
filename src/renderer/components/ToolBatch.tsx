import { useLayoutEffect, useRef, useState } from "react";
import { ChevronDown } from "lucide-react";
import type { ConversationItem, ExplorerTask, ToolActivity, ValidationState } from "@shared/contracts";
import type { AgentRole } from "@shared/agent-contracts";
import { useI18n, type Translate } from "../i18n/i18n";
import type { MessageKey } from "../i18n/messages";
import { useScrollFollow } from "../hooks/use-scroll-follow";
import { ValidationCard } from "./ValidationCard";

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

const ROLE_LABEL_KEYS = {
  explorer: "agent.role.explorer",
  validator: "agent.role.validator",
  reviewer: "agent.role.reviewer",
  editor: "agent.role.editor",
} as const satisfies Record<AgentRole, MessageKey>;

/**
 * 只有全部关联任务都带同一个已知角色时才显示该角色名；混合角色或缺少 agentRole（历史任务）
 * 一律回退到中性标签，避免把混合批次误标成某一种角色。
 */
function compactBatchLabel(linkedExplorers: ExplorerTask[], t: Translate): string {
  const roles = new Set<AgentRole>();
  const everyTaskHasRole = linkedExplorers.every((task) => {
    if (!task.agentRole) return false;
    roles.add(task.agentRole);
    return true;
  });
  const [onlyRole] = roles;
  if (everyTaskHasRole && roles.size === 1 && onlyRole) return t(ROLE_LABEL_KEYS[onlyRole]);
  return t("explorer.compactAgents");
}

export function ToolBatch({
  tools,
  animateNewTools = false,
  selectedToolId,
  onSelectTool,
  explorers = [],
  validation,
}: {
  tools: ToolActivity[];
  animateNewTools?: boolean;
  selectedToolId: string | null;
  onSelectTool: (toolId: string) => void;
  explorers?: ExplorerTask[];
  validation?: ValidationState;
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
  const [expanded, setExpanded] = useState(false);
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
  const toolIds = new Set(tools.map((tool) => tool.id));
  const linkedExplorers = explorers.filter((task) => toolIds.has(task.originToolCallId));
  const activeExplorers = linkedExplorers.filter((task) => task.status === "queued" || task.status === "running").length;
  const summaryTitle = linkedExplorers.length > 0
    ? t("explorer.compactSummary", { label: compactBatchLabel(linkedExplorers, t), active: activeExplorers, total: linkedExplorers.length })
    : firstTool?.title ?? t("tool.panelTitle");
  const linkedValidation = validation?.originToolCallId && toolIds.has(validation.originToolCallId) ? validation : null;
  return (
    <section className="tool-batch plaintext-tool-batch" aria-label={t("tool.batch", { count: tools.length })}>
      <div className={expanded ? "tool-dropdown open" : "tool-dropdown"}>
        <button className="tool-summary" type="button" aria-expanded={expanded} onClick={() => setExpanded((current) => !current)}>
          <span className={`tool-inline-status ${firstTool?.status ?? "success"}`} />
          <span>{summaryTitle}</span>
          <span className="tool-inline-count">{t("tool.batch", { count: tools.length })}</span>
          <ChevronDown className="tool-inline-chevron" size={13} aria-hidden="true" />
        </button>
        <div className="tool-batch-reveal" aria-hidden={!expanded} inert={!expanded ? true : undefined}>
          <div ref={listRef} className={scrollable ? "tool-batch-list scrollable" : "tool-batch-list"} data-scroll-follow role={scrollable ? "region" : undefined} aria-label={scrollable ? t("tool.batch", { count: tools.length }) : undefined} tabIndex={expanded && scrollable ? 0 : undefined}>
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
        </div>
      </div>
      {linkedValidation && <ValidationCard validation={linkedValidation} />}
    </section>
  );
}
