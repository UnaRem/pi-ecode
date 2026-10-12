import type { AgentSession, ExtensionAPI, InlineExtension, SessionEntry } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  CONFIRMATION_RESPONSE_TAG, CONFIRMATION_TOOL_NAME, confirmationParameters, findPendingConfirmation,
  matchesConfirmationResponse, parseConfirmationMarker, parseConfirmationResponse, type PendingConfirmation,
} from "../../shared/confirmation.js";
import { historyMessages, mapTimeline } from "./timeline-mapper.js";

export { CONFIRMATION_TOOL_NAME } from "../../shared/confirmation.js";

function currentTurn(entries: SessionEntry[]): SessionEntry[] {
  const lastUser = entries.findLastIndex((entry) => entry.type === "message" && entry.message.role === "user");
  return entries.slice(lastUser + 1);
}

function latestAssistant(entries: SessionEntry[]) {
  const entry = currentTurn(entries).findLast((candidate) => candidate.type === "message" && candidate.message.role === "assistant");
  return entry?.type === "message" && entry.message.role === "assistant" ? entry.message : undefined;
}

function persistedPending(entries: SessionEntry[]): PendingConfirmation | undefined {
  const turn = currentTurn(entries);
  const pending = findPendingConfirmation(mapTimeline(historyMessages(turn)));
  if (!pending) return undefined;
  const result = turn.findLast((entry) => entry.type === "message" && entry.message.role === "toolResult"
    && entry.message.toolCallId === pending.requestId);
  if (result?.type !== "message" || result.message.role !== "toolResult") return undefined;
  const marker = parseConfirmationMarker(result.message.details);
  const parameters = confirmationParameters(result.message.details);
  if (marker?.requestId !== pending.requestId || parameters?.title !== pending.title || parameters.message !== pending.message) return undefined;
  return pending;
}

export class ConfirmationService {
  private readonly installedSessions = new WeakSet<AgentSession>();

  asExtension(): InlineExtension {
    return { name: "pi-ecode-confirmation", factory: (pi) => this.register(pi) };
  }

  install(session: AgentSession): void {
    if (this.installedSessions.has(session)) return;
    const sendCustomMessage = session.sendCustomMessage.bind(session);
    session.sendCustomMessage = (message, options) => {
      // Background task notifications remain in history without restarting a pending approval.
      const guardedOptions = persistedPending(session.sessionManager.getBranch())
        ? { ...options, triggerTurn: false }
        : options;
      return sendCustomMessage(message, guardedOptions);
    };
    const original = session.agent.finishTurn;
    session.agent.finishTurn = async (context, signal) => {
      const previous = await original?.(context, signal);
      const pending = context.toolResults.some((result) => result.toolName === CONFIRMATION_TOOL_NAME
        && !result.isError && parseConfirmationMarker(result.details)?.requestId === result.toolCallId);
      if (!pending) return previous || undefined;
      session.clearQueue();
      // abort() waits for settlement, so awaiting it inside finishTurn would deadlock.
      // The aborted flag also stops AgentSession's outer continuation/queue drain.
      void session.abort();
      return { action: "end" };
    };
    this.installedSessions.add(session);
  }

  assertResponse(session: AgentSession, text: string, promptActive = false): void {
    if (!text.includes(`<${CONFIRMATION_RESPONSE_TAG}>`) && !text.includes(`</${CONFIRMATION_RESPONSE_TAG}>`)) return;
    const response = parseConfirmationResponse(text);
    if (!response) throw new Error("确认回复格式无效，请重新选择确认或取消。");
    if (promptActive || !session.isIdle) throw new Error("请等待当前任务结束后再回复确认请求。");
    const pending = persistedPending(session.sessionManager.getBranch());
    if (!pending || !matchesConfirmationResponse(pending, response)) throw new Error("确认请求已失效或回复与当前请求不匹配。");
  }

  private register(pi: ExtensionAPI): void {
    pi.on("tool_call", (event, context) => {
      const entries = context.sessionManager.getBranch();
      const assistant = latestAssistant(entries);
      const first = assistant?.content.find((block) => block.type === "toolCall" && block.name === CONFIRMATION_TOOL_NAME);
      if (!first || first.type !== "toolCall") return;
      const completed = currentTurn(entries).some((entry) => entry.type === "message" && entry.message.role === "toolResult"
        && entry.message.toolCallId === first.id);
      if (event.toolName === CONFIRMATION_TOOL_NAME && event.toolCallId === first.id && !completed) return;
      return { block: true, terminate: true, reason: "确认请求必须独立执行；同批其他工具及重复确认已阻断。" };
    });

    pi.registerTool({
      name: CONFIRMATION_TOOL_NAME,
      label: "Request confirmation",
      description: "Save a pending confirmation in the conversation and end this run immediately. The user can confirm or cancel later, including after reopening the session.",
      promptSnippet: "Request explicit approval and end the current run until the user responds",
      promptGuidelines: [
        "Use request_confirmation whenever explicit user approval is required; do not ask for confirmation in ordinary prose.",
        "Call request_confirmation as the only tool in that assistant response. It saves a pending request and ends the run; do not continue work.",
        "Only a later user confirmation authorizes the proposed action. Cancellation does not authorize it. There is no timeout.",
      ],
      executionMode: "sequential",
      parameters: Type.Object({
        title: Type.String({ minLength: 1, maxLength: 120, description: "Short confirmation question" }),
        message: Type.String({ minLength: 1, maxLength: 2_000, description: "Proposed action and its impact" }),
      }),
      execute: async (toolCallId, params, signal) => {
        signal?.throwIfAborted();
        if (!confirmationParameters(params)) throw new Error("确认标题和说明不能为空。");
        const marker = { kind: "pi-ecode.confirmation", version: 1, status: "pending", requestId: toolCallId } as const;
        return {
          content: [
            { type: "text", text: "确认请求已保存，本轮已结束。等待用户确认或取消后再继续。" },
            { type: "text", text: JSON.stringify(marker) },
          ],
          details: { ...marker, title: params.title, message: params.message },
          terminate: true,
        };
      },
    });
  }
}
