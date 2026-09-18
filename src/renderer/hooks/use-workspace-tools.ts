import { useEffect, useMemo, useRef, useState } from "react";
import type { ConversationItem, ToolActivity } from "@shared/contracts";

export function toolsInLatestTurn(timeline: ConversationItem[]): ToolActivity[] {
  let latestUserIndex = -1;
  for (let index = timeline.length - 1; index >= 0; index -= 1) {
    const item = timeline[index];
    if (item?.kind === "message" && item.message.role === "user") {
      latestUserIndex = index;
      break;
    }
  }
  return timeline.slice(latestUserIndex + 1).flatMap((item) => item.kind === "tool" ? [item.tool] : []);
}

export function useWorkspaceTools(timeline: ConversationItem[], conversationKey: string) {
  const tools = useMemo(() => toolsInLatestTurn(timeline), [timeline]);
  const [selectedToolId, setSelectedToolId] = useState<string | null>(null);
  const seenRunningTools = useRef(new Set<string>());

  useEffect(() => {
    seenRunningTools.current.clear();
    setSelectedToolId(null);
  }, [conversationKey]);
  useEffect(() => {
    const latestRunning = tools.filter((tool) => tool.status === "running" && !seenRunningTools.current.has(tool.id)).at(-1);
    for (const tool of tools) {
      if (tool.status === "running") seenRunningTools.current.add(tool.id);
    }
    if (latestRunning) {
      setSelectedToolId(latestRunning.id);
      return;
    }
    const selectionExists = tools.some((tool) => tool.id === selectedToolId);
    if (!selectionExists) setSelectedToolId(tools.at(-1)?.id ?? null);
  }, [selectedToolId, tools]);

  return {
    tools,
    selectedToolId,
    selectedTool: tools.find((tool) => tool.id === selectedToolId) ?? tools.at(-1) ?? null,
    selectTool: setSelectedToolId,
  };
}
