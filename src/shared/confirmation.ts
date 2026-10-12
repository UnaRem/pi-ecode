import type { ConversationItem, ToolActivity } from "./contracts.js";

export const CONFIRMATION_TOOL_NAME = "request_confirmation";
export const CONFIRMATION_RESPONSE_TAG = "pi-ecode-confirmation-response";

export interface PendingConfirmation {
  requestId: string;
  title: string;
  message: string;
}

export interface ConfirmationMarker {
  kind: "pi-ecode.confirmation";
  version: 1;
  status: "pending";
  requestId: string;
}

export interface ConfirmationResponse {
  requestId: string;
  confirmed: boolean;
  displayText: string;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseJson(text: string): unknown {
  try { return JSON.parse(text) as unknown; } catch { return undefined; }
}

export function parseConfirmationMarker(value: unknown): ConfirmationMarker | undefined {
  if (!record(value)) return undefined;
  if (value.kind !== "pi-ecode.confirmation" || value.version !== 1 || value.status !== "pending") return undefined;
  if (typeof value.requestId !== "string" || !value.requestId.trim()) return undefined;
  return { kind: value.kind, version: value.version, status: value.status, requestId: value.requestId };
}

export function confirmationParameters(value: unknown): Pick<PendingConfirmation, "title" | "message"> | undefined {
  if (!record(value)) return undefined;
  if (typeof value.title !== "string" || !value.title.trim() || value.title.length > 120) return undefined;
  if (typeof value.message !== "string" || !value.message.trim() || value.message.length > 2_000) return undefined;
  return { title: value.title, message: value.message };
}

function pendingTool(tool: ToolActivity): PendingConfirmation | undefined {
  if (tool.name !== CONFIRMATION_TOOL_NAME || tool.status !== "success" || tool.outputTruncated) return undefined;
  const parameters = confirmationParameters(parseJson(tool.input));
  // The final text block carries the wire marker; prose alone never creates a button.
  const marker = parseConfirmationMarker(parseJson(tool.output.split("\n").at(-1) ?? ""));
  if (!parameters || !marker || marker.requestId !== tool.id) return undefined;
  return { ...parameters, requestId: marker.requestId };
}

export function findPendingConfirmation(timeline: ConversationItem[]): PendingConfirmation | undefined {
  let pending: PendingConfirmation | undefined;
  for (const item of timeline) {
    if (item.kind === "tool") {
      const request = pendingTool(item.tool);
      if (request) pending = request;
    }
    if (item.kind !== "message" || item.message.role !== "user") continue;
    if (item.id.startsWith("pending-user-") || item.message.id.startsWith("pending-user-")) continue;
    pending = undefined;
  }
  return pending;
}

export function createConfirmationResponse(request: PendingConfirmation, confirmed: boolean, additionalMessage: string): string {
  const action = confirmed ? "确认执行" : "取消执行";
  const extra = additionalMessage.trim();
  const displayText = `${action}：${request.title}${extra ? `\n补充要求：${extra}` : ""}`;
  const marker = JSON.stringify({ requestId: request.requestId, confirmed });
  return `${displayText}\n<${CONFIRMATION_RESPONSE_TAG}>${marker}</${CONFIRMATION_RESPONSE_TAG}>`;
}

export function parseConfirmationResponse(text: string): ConfirmationResponse | undefined {
  // Only a single complete suffix is protocol data; malformed or embedded tags remain visible.
  const match = /\n<pi-ecode-confirmation-response>([^\n]*)<\/pi-ecode-confirmation-response>$/u.exec(text);
  if (!match || match.index !== text.indexOf(`\n<${CONFIRMATION_RESPONSE_TAG}>`)) return undefined;
  const response = parseJson(match[1] ?? "");
  if (!record(response) || typeof response.requestId !== "string" || !response.requestId.trim()) return undefined;
  if (typeof response.confirmed !== "boolean") return undefined;
  return { requestId: response.requestId, confirmed: response.confirmed, displayText: text.slice(0, match.index) };
}

export function confirmationDisplayText(text: string): string {
  return parseConfirmationResponse(text)?.displayText ?? text;
}

export function matchesConfirmationResponse(request: PendingConfirmation, response: ConfirmationResponse): boolean {
  if (request.requestId !== response.requestId) return false;
  const action = response.confirmed ? "确认执行" : "取消执行";
  const expected = `${action}：${request.title}`;
  if (response.displayText === expected) return true;
  const prefix = `${expected}\n补充要求：`;
  return response.displayText.startsWith(prefix) && response.displayText.slice(prefix.length).trim().length > 0;
}
