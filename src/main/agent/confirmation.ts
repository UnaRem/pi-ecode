import type { ExtensionAPI, ExtensionContext, InlineExtension, SessionEntry } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export const CONFIRMATION_TOOL_NAME = "request_confirmation";
const CONFIRMATION_TIMEOUT_MS = 60_000;
const CONFIRMATION_TIMEOUT_NOTICE = "60 秒内未确认将自动结束本轮。";

function latestAssistantRequestsConfirmation(entries: SessionEntry[]): boolean {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry?.type !== "message" || entry.message.role !== "assistant") continue;
    return Array.isArray(entry.message.content) && entry.message.content.some((block) => (
      block.type === "toolCall" && block.name === CONFIRMATION_TOOL_NAME
    ));
  }
  return false;
}

export class ConfirmationService {
  asExtension(): InlineExtension {
    return { name: "pi-ecode-confirmation", factory: (pi) => this.register(pi) };
  }

  private register(pi: ExtensionAPI): void {
    pi.on("tool_call", (event, context) => {
      if (event.toolName === CONFIRMATION_TOOL_NAME) return;
      if (!latestAssistantRequestsConfirmation(context.sessionManager.getBranch())) return;
      return {
        block: true,
        terminate: true,
        reason: "Blocked because request_confirmation must be the only tool in its assistant response.",
      };
    });

    pi.registerTool({
      name: CONFIRMATION_TOOL_NAME,
      label: "Request confirmation",
      description: "Pause work for up to one minute and ask the user to confirm or cancel a proposed action through a visible confirmation dialog.",
      promptSnippet: "Ask the user for explicit approval through a confirmation dialog before gated work",
      promptGuidelines: [
        "Use request_confirmation whenever explicit user approval is required; do not ask the user to type confirmation in ordinary prose.",
        "Call request_confirmation as the only tool in that assistant response, and continue work only when its result says the user confirmed.",
        "If the user does not confirm within one minute, closes the dialog, or cancels, the tool terminates the current turn; do not produce further output.",
      ],
      executionMode: "sequential",
      parameters: Type.Object({
        title: Type.String({ minLength: 1, maxLength: 120, description: "Short confirmation question" }),
        message: Type.String({ minLength: 1, maxLength: 2_000, description: "Concise summary of the proposed action and its impact" }),
      }),
      execute: async (_toolCallId, params, signal, _onUpdate, context) => {
        signal?.throwIfAborted();
        const confirmed = await context.ui.confirm(
          params.title,
          `${params.message}\n\n${CONFIRMATION_TIMEOUT_NOTICE}`,
          { timeout: CONFIRMATION_TIMEOUT_MS },
        );
        signal?.throwIfAborted();
        return {
          content: [{
            type: "text",
            text: confirmed
              ? "The user confirmed the proposed action. Continue with the approved work."
              : "The proposal was not confirmed. This turn is terminated; do not perform it or produce further output.",
          }],
          details: { confirmed },
          ...(confirmed ? {} : { terminate: true }),
        };
      },
    });
  }
}
