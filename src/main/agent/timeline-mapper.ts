import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ConversationItem, ConversationMessage, ImageAttachment, ToolActivity } from "../../shared/contracts.js";
import { parsePastedTexts } from "../../shared/pasted-text.js";
import { formatToolInput, textFromContent, toolTitle } from "./message-mapper.js";

interface ContentBlock {
  type?: string;
  text?: string;
  data?: string;
  mimeType?: string;
  id?: string;
  name?: string;
  arguments?: unknown;
}

function blocks(content: unknown): ContentBlock[] {
  if (typeof content === "string") return [{ type: "text", text: content }];
  if (!Array.isArray(content)) return [];
  return content.filter((block): block is ContentBlock => typeof block === "object" && block !== null);
}

function imagesFromContent(content: unknown): ImageAttachment[] {
  return blocks(content).flatMap((block, index) => {
    if (block.type !== "image" || typeof block.data !== "string" || !["image/png", "image/jpeg", "image/gif", "image/webp"].includes(block.mimeType ?? "")) return [];
    const mimeType = block.mimeType as ImageAttachment["mimeType"];
    return [{
      id: `message-image-${index}-${block.data.slice(0, 12)}`,
      fileName: `image-${index + 1}.${mimeType === "image/jpeg" ? "jpg" : mimeType.split("/")[1]}`,
      mimeType,
      data: block.data,
    }];
  });
}

export function messageItem(message: ConversationMessage): ConversationItem {
  return { kind: "message", id: message.id, message };
}

export function toolItem(tool: ToolActivity): ConversationItem {
  return { kind: "tool", id: tool.id, tool };
}

export interface MessageWindow {
  messages: AgentMessage[];
  startIndex: number;
  hasMore: boolean;
}

export function recentMessageWindow(messages: AgentMessage[], maximumTurns: number): MessageWindow {
  let turns = 0;
  let startIndex = 0;
  for (let index = messages.length - 1; index >= 0; index--) {
    if (messages[index]?.role !== "user") continue;
    turns += 1;
    if (turns === maximumTurns) {
      startIndex = index;
      break;
    }
  }
  return { messages: messages.slice(startIndex), startIndex, hasMore: startIndex > 0 };
}

export function mapTimeline(messages: AgentMessage[], startIndex = 0): ConversationItem[] {
  const timeline: ConversationItem[] = [];
  const toolIndexes = new Map<string, number>();

  messages.forEach((message, localIndex) => {
    const messageIndex = startIndex + localIndex;
    const timestamp = "timestamp" in message && typeof message.timestamp === "number"
      ? message.timestamp
      : Date.now() + messageIndex;
    if (message.role === "user") {
      const parsedText = parsePastedTexts(textFromContent(message.content));
      const images = imagesFromContent(message.content);
      if (parsedText.message || images.length > 0 || parsedText.attachments.length > 0) timeline.push(messageItem({
        id: `user-${timestamp}-${messageIndex}`,
        role: "user",
        text: parsedText.message,
        timestamp,
        ...(images.length > 0 ? { images } : {}),
        ...(parsedText.attachments.length > 0 ? { pastedTexts: parsedText.attachments } : {}),
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
