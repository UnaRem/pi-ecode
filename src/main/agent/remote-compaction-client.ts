import type { Api, Model } from "@earendil-works/pi-ai";

export interface RemoteCompactionRequest {
  model: string;
  input: unknown[];
  instructions: string;
  tools?: unknown[];
  parallel_tool_calls?: boolean;
  reasoning?: Record<string, unknown>;
  service_tier?: string;
  prompt_cache_key?: string;
  text?: Record<string, unknown>;
}

export interface RemoteCompactionResult {
  output: [Record<string, unknown> & { type: "compaction"; encrypted_content: string }];
  responseId?: string;
  usage?: { input_tokens?: number; output_tokens?: number; total_tokens?: number };
}

export class RemoteCompactionError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly unsupported = false,
  ) {
    super(message);
    this.name = "RemoteCompactionError";
  }
}

interface ParsedSseEvent {
  event?: string;
  data: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function safeResponseText(text: string): string {
  return text.replace(/sk-[A-Za-z0-9_-]+/gu, "[redacted]").trim().slice(0, 800);
}

function eventType(event: ParsedSseEvent): string | undefined {
  return isRecord(event.data) && typeof event.data.type === "string" ? event.data.type : event.event;
}

function errorText(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined;
  if (typeof value.message === "string") return value.message;
  if (isRecord(value.error) && typeof value.error.message === "string") return value.error.message;
  return typeof value.error === "string" ? value.error : undefined;
}

export function responsesUrl(model: Model<Api>, baseUrl: string): string {
  const normalized = baseUrl.replace(/\/+$/u, "");
  if (model.api === "openai-codex-responses") {
    if (normalized.endsWith("/codex/responses")) return normalized;
    if (normalized.endsWith("/codex")) return `${normalized}/responses`;
    return `${normalized}/codex/responses`;
  }
  return normalized.endsWith("/responses") ? normalized : `${normalized}/responses`;
}

export function parseSseEvents(raw: string): ParsedSseEvent[] {
  const events: ParsedSseEvent[] = [];
  for (const block of raw.replaceAll("\r\n", "\n").replaceAll("\r", "\n").split(/\n\n+/u)) {
    if (!block.trim()) continue;
    let event: string | undefined;
    const dataLines: string[] = [];
    for (const line of block.split("\n")) {
      if (line.startsWith("event:")) event = line.slice(6).trim();
      if (line.startsWith("data:")) dataLines.push(line.slice(5).replace(/^ /u, ""));
    }
    if (dataLines.length === 0 || dataLines.join("\n") === "[DONE]") continue;
    try {
      events.push({ ...(event ? { event } : {}), data: JSON.parse(dataLines.join("\n")) });
    } catch {
      throw new RemoteCompactionError("Remote compaction returned malformed SSE JSON.");
    }
  }
  if (events.length === 0) throw new RemoteCompactionError("Remote compaction returned no SSE events.");
  return events;
}

function completedResult(events: ParsedSseEvent[]): RemoteCompactionResult {
  const failure = events.find((event) => ["error", "response.failed", "response.incomplete"].includes(eventType(event) ?? ""));
  if (failure) throw new RemoteCompactionError(`Remote compaction failed: ${errorText(failure.data) ?? eventType(failure) ?? "provider error"}`);
  const completed = events.find((event) => eventType(event) === "response.completed");
  const response = completed && isRecord(completed.data) && isRecord(completed.data.response)
    ? completed.data.response
    : undefined;
  if (!response) throw new RemoteCompactionError("Remote compaction ended without response.completed.");
  if (response.status !== "completed" || !Array.isArray(response.output)) {
    throw new RemoteCompactionError("Remote compaction returned an incomplete response.");
  }
  const compactItems = response.output.filter((item) => isRecord(item) && item.type === "compaction");
  if (compactItems.length !== 1 || typeof compactItems[0]?.encrypted_content !== "string" || !compactItems[0].encrypted_content) {
    throw new RemoteCompactionError("Remote compaction must return exactly one opaque compaction item.");
  }
  return {
    output: [compactItems[0] as RemoteCompactionResult["output"][0]],
    ...(typeof response.id === "string" ? { responseId: response.id } : {}),
    ...(isRecord(response.usage) ? { usage: response.usage } : {}),
  };
}

export async function requestRemoteCompaction(args: {
  model: Model<Api>;
  baseUrl: string;
  headers: Record<string, string>;
  request: RemoteCompactionRequest;
  signal: AbortSignal;
  fetcher?: typeof fetch;
}): Promise<RemoteCompactionResult> {
  const endpoint = responsesUrl(args.model, args.baseUrl);
  const body = {
    ...structuredClone(args.request),
    input: [...structuredClone(args.request.input), { type: "compaction_trigger" }],
    stream: true,
    store: false,
  };
  const response = await (args.fetcher ?? fetch)(endpoint, {
    method: "POST",
    headers: { ...args.headers, accept: "text/event-stream", "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: args.signal,
  });
  let responseBody = "";
  try {
    responseBody = await response.text();
  } catch (error) {
    if (!response.ok) {
      throw new RemoteCompactionError(`Remote compaction failed (${response.status} ${response.statusText}).`, response.status);
    }
    throw error;
  }
  if (!response.ok) {
    const detail = safeResponseText(responseBody);
    throw new RemoteCompactionError(
      `Remote compaction failed (${response.status} ${response.statusText}) at ${endpoint}${detail ? `: ${detail}` : ""}`,
      response.status,
      [404, 405, 501].includes(response.status),
    );
  }
  return completedResult(parseSseEvents(responseBody));
}
