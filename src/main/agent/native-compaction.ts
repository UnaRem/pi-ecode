import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { AgentSession, ExtensionAPI, InlineExtension, SessionEntry } from "@earendil-works/pi-coding-agent";

const NATIVE_SUMMARY_MARKER = "[pi-ecode:openai-native-compaction]";
const NATIVE_DETAILS_KIND = "pi-ecode.openai-native-compaction.v1";
const UNSUPPORTED_STATUSES = new Set([404, 405, 501]);

interface NativeDetails {
  kind: typeof NATIVE_DETAILS_KIND;
  provider: string;
  model: string;
  baseUrl: string;
  output: unknown[];
  usage: { inputTokens: number; outputTokens: number; totalTokens: number };
  estimatedTokensAfter: number;
}

interface PayloadAgent {
  onPayload?: (payload: unknown, model: Model<Api>) => unknown | undefined | Promise<unknown | undefined>;
}

interface SessionWithAgent {
  agent: PayloadAgent;
}

interface NativeResponse {
  output: unknown[];
  usage?: { input_tokens?: number; output_tokens?: number; total_tokens?: number };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function nativeDetails(entry: SessionEntry | undefined): NativeDetails | undefined {
  if (entry?.type !== "compaction" || !isRecord(entry.details) || entry.details.kind !== NATIVE_DETAILS_KIND) return undefined;
  const details = entry.details as unknown as NativeDetails;
  return Array.isArray(details.output) ? details : undefined;
}

function latestNativeDetails(entries: SessionEntry[]): NativeDetails | undefined {
  const latestCompaction = [...entries].reverse().find((entry) => entry.type === "compaction");
  return nativeDetails(latestCompaction);
}

function textAndImages(content: unknown): unknown[] {
  if (typeof content === "string") return [{ type: "input_text", text: content }];
  if (!Array.isArray(content)) return [];
  const items: unknown[] = [];
  for (const block of content) {
    if (!isRecord(block)) continue;
    if (block.type === "text" && typeof block.text === "string") items.push({ type: "input_text", text: block.text });
    if (block.type === "image" && typeof block.data === "string" && typeof block.mimeType === "string") {
      items.push({ type: "input_image", detail: "auto", image_url: `data:${block.mimeType};base64,${block.data}` });
    }
  }
  return items;
}

function responseItems(messages: AgentMessage[]): unknown[] {
  const items: unknown[] = [];
  for (const message of messages) {
    if (message.role === "user") {
      const content = textAndImages(message.content);
      if (content.length > 0) items.push({ role: "user", content });
      continue;
    }
    if (message.role === "assistant") {
      for (const block of message.content) {
        if (block.type === "text" && block.text) items.push({ role: "assistant", content: block.text });
        if (block.type === "thinking" && block.thinkingSignature) {
          try { items.push(JSON.parse(block.thinkingSignature)); } catch { /* Ignore an invalid optional signature. */ }
        }
        if (block.type === "toolCall") {
          items.push({ type: "function_call", call_id: block.id.split("|")[0], name: block.name, arguments: JSON.stringify(block.arguments) });
        }
      }
      continue;
    }
    if (message.role === "toolResult") {
      items.push({ type: "function_call_output", call_id: message.toolCallId.split("|")[0], output: textAndImages(message.content).map((item) => isRecord(item) ? item.text ?? "" : "").join("\n") });
    }
  }
  return items;
}

function supportsNativeCompaction(model: Model<Api>): boolean {
  return model.api === "openai-responses" || model.api === "openai-codex-responses";
}

function compactUrl(model: Model<Api>, baseUrl: string): string {
  const normalized = baseUrl.replace(/\/+$/u, "");
  if (model.api === "openai-codex-responses") {
    if (normalized.endsWith("/codex/responses")) return `${normalized}/compact`;
    if (normalized.endsWith("/codex")) return `${normalized}/responses/compact`;
    return `${normalized}/codex/responses/compact`;
  }
  return normalized.endsWith("/responses") ? `${normalized}/compact` : `${normalized}/responses/compact`;
}

function codexAccountId(token: string): string | undefined {
  try {
    const encodedPayload = token.split(".")[1];
    if (!encodedPayload) return undefined;
    const payload = JSON.parse(Buffer.from(encodedPayload, "base64url").toString("utf8")) as Record<string, unknown>;
    const auth = payload["https://api.openai.com/auth"];
    return isRecord(auth) && typeof auth.chatgpt_account_id === "string" ? auth.chatgpt_account_id : undefined;
  } catch {
    return undefined;
  }
}

function authHeaders(model: Model<Api>, auth: { apiKey?: string; headers?: Record<string, string | null> }): Record<string, string> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  for (const source of [model.headers, auth.headers]) {
    for (const [name, value] of Object.entries(source ?? {})) if (value !== null) headers[name] = value;
  }
  const hasAuthorization = Object.keys(headers).some((name) => name.toLowerCase() === "authorization");
  if (auth.apiKey && !hasAuthorization) headers.authorization = `Bearer ${auth.apiKey}`;
  if (model.api === "openai-codex-responses" && auth.apiKey) {
    const accountId = codexAccountId(auth.apiKey);
    if (accountId) headers["chatgpt-account-id"] = accountId;
    headers.originator = "pi";
    headers["OpenAI-Beta"] = "responses=experimental";
  }
  return headers;
}

function responseError(status: number, body: string): Error {
  const detail = body.trim().slice(0, 600);
  if (status === 401 || status === 403) return new Error(`Native compaction authentication failed (${status}). ${detail}`);
  if (status === 429) return new Error(`Native compaction was rate limited (429). ${detail}`);
  return new Error(`Native compaction request failed (${status}). ${detail}`);
}

function injectNativeOutput(payload: unknown, details: NativeDetails): unknown {
  if (!isRecord(payload) || !Array.isArray(payload.input)) return payload;
  const markerIndex = payload.input.findIndex((item) => JSON.stringify(item).includes(NATIVE_SUMMARY_MARKER));
  if (markerIndex < 0) return payload;
  return { ...payload, input: [...payload.input.slice(0, markerIndex), ...details.output, ...payload.input.slice(markerIndex + 1)] };
}

export class NativeCompaction {
  private readonly installedSessions = new WeakSet<AgentSession>();
  private estimatedTokensAfter: number | null = null;

  constructor(
    private readonly getSession: () => AgentSession | undefined,
    private readonly request: typeof fetch = fetch,
  ) {}

  asExtension(): InlineExtension {
    return { name: "pi-ecode-native-compaction", factory: (pi) => this.register(pi) };
  }

  installPayloadInjection(session: AgentSession): void {
    if (this.installedSessions.has(session)) return;
    const agent = (session as unknown as SessionWithAgent).agent;
    const previous = agent.onPayload;
    agent.onPayload = async (payload, model) => {
      const transformed = await previous?.(payload, model) ?? payload;
      const details = latestNativeDetails(session.sessionManager.getBranch());
      const compatible = details && supportsNativeCompaction(model) && details.provider === model.provider;
      return compatible ? injectNativeOutput(transformed, details) : transformed;
    };
    this.installedSessions.add(session);
  }

  consumeEstimatedTokensAfter(): number | null {
    const estimate = this.estimatedTokensAfter;
    this.estimatedTokensAfter = null;
    return estimate;
  }

  storedEstimatedTokensAfter(session: AgentSession): number | null {
    return latestNativeDetails(session.sessionManager.getBranch())?.estimatedTokensAfter ?? null;
  }

  supports(model: Model<Api> | undefined): boolean {
    return Boolean(model && supportsNativeCompaction(model));
  }

  private register(pi: ExtensionAPI): void {
    pi.on("session_before_compact", async (event, ctx) => {
      const session = this.getSession();
      const model = ctx.model;
      if (!session || !model || !supportsNativeCompaction(model)) return undefined;
      const authResult = await session.modelRuntime.getAuth(model);
      const baseUrl = authResult?.auth.baseUrl ?? model.baseUrl;
      const previous = latestNativeDetails(event.branchEntries);
      const input = [
        ...(previous?.output ?? []),
        ...responseItems([...event.preparation.messagesToSummarize, ...event.preparation.turnPrefixMessages]),
      ];
      const response = await this.request(compactUrl(model, baseUrl), {
        method: "POST",
        headers: authHeaders(model, authResult?.auth ?? {}),
        body: JSON.stringify({ model: model.id, input, instructions: ctx.getSystemPrompt() }),
        signal: event.signal,
      });
      if (UNSUPPORTED_STATUSES.has(response.status)) {
        if (previous) throw new Error("The provider no longer supports native compaction; preserving the existing native checkpoint without fallback.");
        return undefined;
      }
      const body = await response.text();
      if (!response.ok) throw responseError(response.status, body);
      let parsed: NativeResponse;
      try { parsed = JSON.parse(body) as NativeResponse; } catch { throw new Error("Native compaction returned invalid JSON."); }
      if (!Array.isArray(parsed.output) || !parsed.output.some((item) => isRecord(item) && item.type === "compaction" && typeof item.encrypted_content === "string")) {
        throw new Error("Native compaction response did not contain a compaction item.");
      }
      const opaqueTokens = Math.max(1, Math.ceil(JSON.stringify(parsed.output).length / 4));
      const estimatedTokensAfter = Math.min(
        event.preparation.tokensBefore,
        opaqueTokens + event.preparation.settings.keepRecentTokens,
      );
      const details: NativeDetails = {
        kind: NATIVE_DETAILS_KIND,
        provider: model.provider,
        model: model.id,
        baseUrl,
        output: parsed.output,
        usage: {
          inputTokens: parsed.usage?.input_tokens ?? 0,
          outputTokens: parsed.usage?.output_tokens ?? 0,
          totalTokens: parsed.usage?.total_tokens ?? 0,
        },
        estimatedTokensAfter,
      };
      this.estimatedTokensAfter = estimatedTokensAfter;
      return {
        compaction: {
          summary: NATIVE_SUMMARY_MARKER,
          firstKeptEntryId: event.preparation.firstKeptEntryId,
          tokensBefore: event.preparation.tokensBefore,
          details,
        },
      };
    });
  }
}
