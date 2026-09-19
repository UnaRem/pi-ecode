import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ConversationImagePayload, ConversationItem, ConversationMessage, ImageAttachment, ThinkingActivity, ToolActivity } from "../../shared/contracts.js";
import { parsePastedTexts } from "../../shared/pasted-text.js";
import { formatToolInput, textFromContent, toolOutputView, toolTitle } from "./message-mapper.js";

interface ContentBlock {
  type?: string;
  text?: string;
  thinking?: string;
  redacted?: boolean;
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

function imagesFromContent(content: unknown, messageIndex: number): NonNullable<ConversationMessage["images"]> {
  return blocks(content).flatMap((block, blockIndex) => {
    if (block.type !== "image" || typeof block.data !== "string" || !["image/png", "image/jpeg", "image/gif", "image/webp"].includes(block.mimeType ?? "")) return [];
    const mimeType = block.mimeType as ImageAttachment["mimeType"];
    return [{
      id: `message-image-${messageIndex}-${blockIndex}`,
      fileName: `image-${blockIndex + 1}.${mimeType === "image/jpeg" ? "jpg" : mimeType.split("/")[1]}`,
      mimeType,
      sourceId: `${messageIndex}:${blockIndex}`,
    }];
  });
}

export function conversationImagePayload(messages: AgentMessage[], sourceId: string): ConversationImagePayload | null {
  const match = /^(\d+):(\d+)$/u.exec(sourceId);
  if (!match) return null;
  const messageIndex = Number(match[1]);
  const blockIndex = Number(match[2]);
  const message = messages[messageIndex];
  if (!message || !("content" in message)) return null;
  const block = blocks(message.content)[blockIndex];
  if (!block || block.type !== "image" || typeof block.data !== "string"
    || !["image/png", "image/jpeg", "image/gif", "image/webp"].includes(block.mimeType ?? "")) return null;
  return {
    mimeType: block.mimeType as ImageAttachment["mimeType"],
    data: Uint8Array.from(Buffer.from(block.data, "base64")),
  };
}

export function messageItem(message: ConversationMessage): ConversationItem {
  return { kind: "message", id: message.id, message };
}

export function thinkingItem(thinking: ThinkingActivity): ConversationItem {
  return { kind: "thinking", id: thinking.id, thinking };
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
      const images = imagesFromContent(message.content, messageIndex);
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
      let thinkingPart = 0;
      for (const block of blocks(message.content)) {
        if (block.type === "text" && block.text) {
          timeline.push(messageItem({
            id: `assistant-${timestamp}-${messageIndex}-${textPart++}`,
            role: "assistant",
            text: block.text,
            timestamp,
            ...(message.stopReason === "error" ? { isError: true } : {}),
          }));
        } else if (block.type === "thinking" && (block.thinking || block.redacted)) {
          const id = `thinking-${timestamp}-${messageIndex}-${thinkingPart++}`;
          timeline.push(thinkingItem({
            id,
            text: block.redacted ? "" : block.thinking ?? "",
            status: "completed",
            ...(block.redacted ? { redacted: true } : {}),
          }));
        } else if (block.type === "toolCall" && block.id && block.name) {
          const tool: ToolActivity = {
            id: block.id,
            name: block.name,
            title: toolTitle(block.name, block.arguments),
            input: formatToolInput(block.arguments),
            output: "",
            status: "success",
            startedAt: timestamp,
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
        ...toolOutputView(textFromContent(message.content)),
        status: message.isError ? "error" : "success",
        startedAt: existing?.kind === "tool" ? existing.tool.startedAt ?? timestamp : timestamp,
        endedAt: timestamp,
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
