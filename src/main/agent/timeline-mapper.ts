import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ConversationItem, ConversationMessage, ToolActivity } from "../../shared/contracts.js";
import { formatToolInput, textFromContent, toolTitle } from "./message-mapper.js";

interface ContentBlock {
  type?: string;
  text?: string;
  id?: string;
  name?: string;
  arguments?: unknown;
}

function blocks(content: unknown): ContentBlock[] {
  if (typeof content === "string") return [{ type: "text", text: content }];
  if (!Array.isArray(content)) return [];
  return content.filter((block): block is ContentBlock => typeof block === "object" && block !== null);
}

export function messageItem(message: ConversationMessage): ConversationItem {
  return { kind: "message", id: message.id, message };
}

export function toolItem(tool: ToolActivity): ConversationItem {
  return { kind: "tool", id: tool.id, tool };
}

export function mapTimeline(messages: AgentMessage[]): ConversationItem[] {
  const timeline: ConversationItem[] = [];
  const toolIndexes = new Map<string, number>();

  messages.forEach((message, messageIndex) => {
    const timestamp = "timestamp" in message && typeof message.timestamp === "number"
      ? message.timestamp
      : Date.now() + messageIndex;
    if (message.role === "user") {
      const text = textFromContent(message.content);
      if (text) timeline.push(messageItem({
        id: `user-${timestamp}-${messageIndex}`,
        role: "user",
        text,
        timestamp,
      }));
      return;
    }
    if (message.role === "assistant") {
      let textPart = 0;
      for (const block of blocks(message.content)) {
        if (block.type === "text" && block.text) {
          timeline.push(messageItem({
            id: `assistant-${timestamp}-${messageIndex}-${textPart++}`,
            role: "assistant",
            text: block.text,
            timestamp,
            ...(message.stopReason === "error" ? { isError: true } : {}),
          }));
        } else if (block.type === "toolCall" && block.id && block.name) {
          const tool: ToolActivity = {
            id: block.id,
            name: block.name,
            title: toolTitle(block.name, block.arguments),
            input: formatToolInput(block.arguments),
            output: "",
            status: "success",
          };
          toolIndexes.set(tool.id, timeline.length);
          timeline.push(toolItem(tool));
        }
      }
      return;
    }
    if (message.role === "toolResult") {
      const index = toolIndexes.get(message.toolCallId);
      const existing = index === undefined ? undefined : timeline[index];
      const tool: ToolActivity = {
        id: message.toolCallId,
        name: message.toolName,
        title: existing?.kind === "tool" ? existing.tool.title : message.toolName,
        input: existing?.kind === "tool" ? existing.tool.input : "",
        output: textFromContent(message.content),
        status: message.isError ? "error" : "success",
      };
      if (index === undefined) {
        toolIndexes.set(tool.id, timeline.length);
        timeline.push(toolItem(tool));
      } else {
        timeline[index] = toolItem(tool);
      }
    }
  });
  return timeline;
}
