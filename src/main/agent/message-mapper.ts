import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ConversationMessage, ToolActivity } from "../../shared/contracts.js";
import { parsePastedTexts } from "../../shared/pasted-text.js";

const TOOL_OUTPUT_PREVIEW_LENGTH = 64 * 1024;
const TOOL_OUTPUT_PREFIX_LENGTH = 48 * 1024;

interface TextBlock {
  type?: string;
  text?: string;
  thinking?: string;
  id?: string;
  name?: string;
  arguments?: unknown;
}

function contentBlocks(content: unknown): TextBlock[] {
  if (typeof content === "string") return [{ type: "text", text: content }];
  if (!Array.isArray(content)) return [];
  return content.filter((block): block is TextBlock => typeof block === "object" && block !== null);
}

export function textFromContent(content: unknown): string {
  return contentBlocks(content)
    .filter((block) => block.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("\n");
}

export function textFromToolResult(result: unknown): string {
  if (typeof result !== "object" || result === null || !("content" in result)) return "";
  return textFromContent(result.content);
}

export function toolOutputView(output: string): Pick<ToolActivity, "output" | "outputLength" | "outputTruncated"> {
  if (output.length <= TOOL_OUTPUT_PREVIEW_LENGTH) return { output };
  const omitted = output.length - TOOL_OUTPUT_PREVIEW_LENGTH;
  return {
    output: `${output.slice(0, TOOL_OUTPUT_PREFIX_LENGTH)}\n\n… ${omitted} characters omitted …\n\n${output.slice(-16 * 1024)}`,
    outputLength: output.length,
    outputTruncated: true,
  };
}

export function formatToolInput(args: unknown): string {
  if (typeof args === "object" && args !== null && "command" in args && typeof args.command === "string") {
    return args.command;
  }
  try {
    return JSON.stringify(args, null, 2) ?? "";
  } catch {
    return String(args);
  }
}

export function toolTitle(name: string, args: unknown): string {
  if (typeof args === "object" && args !== null) {
    const record = args as Record<string, unknown>;
    const target = record.path ?? record.filePath ?? record.pattern ?? record.command;
    if (typeof target === "string" && target.length > 0) {
      const compact = target.replaceAll("\\", "/");
      return `${name} · ${compact.length > 62 ? `${compact.slice(0, 59)}…` : compact}`;
    }
  }
  return name;
}

export function mapMessages(messages: AgentMessage[]): { messages: ConversationMessage[]; tools: ToolActivity[] } {
  const mappedMessages: ConversationMessage[] = [];
  const tools = new Map<string, ToolActivity>();

  messages.forEach((message, index) => {
    const timestamp = "timestamp" in message && typeof message.timestamp === "number" ? message.timestamp : Date.now() + index;
    if (message.role === "user" || message.role === "assistant") {
      const rawText = textFromContent(message.content);
      const parsedText = message.role === "user" ? parsePastedTexts(rawText) : { message: rawText, attachments: [] };
      if (parsedText.message || parsedText.attachments.length > 0) {
        mappedMessages.push({
          id: `${message.role}-${timestamp}-${index}`,
          role: message.role,
          text: parsedText.message,
          timestamp,
          ...(parsedText.attachments.length > 0 ? { pastedTexts: parsedText.attachments } : {}),
          ...(message.role === "assistant" && message.stopReason === "error" ? { isError: true } : {}),
        });
      }
      if (message.role === "assistant") {
        for (const block of contentBlocks(message.content)) {
          if (block.type !== "toolCall" || !block.id || !block.name) continue;
          tools.set(block.id, {
            id: block.id,
            name: block.name,
            title: toolTitle(block.name, block.arguments),
            input: formatToolInput(block.arguments),
            output: "",
            status: "success",
          });
        }
      }
    }

    if (message.role === "toolResult") {
      const existing = tools.get(message.toolCallId);
      tools.set(message.toolCallId, {
        id: message.toolCallId,
        name: message.toolName,
        title: existing?.title ?? message.toolName,
        input: existing?.input ?? "",
        ...toolOutputView(textFromContent(message.content)),
        status: message.isError ? "error" : "success",
      });
    }
  });

  return { messages: mappedMessages, tools: [...tools.values()] };
}
