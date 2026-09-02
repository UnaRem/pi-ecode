import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Api, Message, Model, ToolCall, ToolResultMessage } from "@earendil-works/pi-ai";
import {
  convertToLlm,
  sessionEntryToContextMessages,
  type AgentSession,
  type BeforeProviderRequestEvent,
  type ExtensionAPI,
  type ExtensionContext,
  type InlineExtension,
  type SessionBeforeCompactEvent,
  type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import {
  RemoteCompactionError,
  requestRemoteCompaction,
  type RemoteCompactionRequest,
} from "./remote-compaction-client.js";

const NATIVE_SUMMARY_MARKER = "[pi-ecode:remote-compaction-v2]";
const DETAILS_KIND = "pi-ecode.remote-compaction-v2";
const LEGACY_DETAILS_KIND = "pi-ecode.openai-native-compaction.v1";
const EXTRA_FIELDS = ["tools", "parallel_tool_calls", "reasoning", "service_tier", "prompt_cache_key", "text"] as const;

type NativeOutput = Array<Record<string, unknown> & { type: "compaction"; encrypted_content: string }>;

interface NativeDetails {
  kind: typeof DETAILS_KIND | typeof LEGACY_DETAILS_KIND;
  provider: string;
  model: string;
  baseUrl: string;
  output: NativeOutput;
  estimatedTokensAfter: number;
  responseId?: string;
  usage?: Record<string, unknown>;
}

interface RequestContext {
  sessionId: string;
  extras: Partial<RemoteCompactionRequest>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nativeDetails(entry: SessionEntry | undefined): NativeDetails | undefined {
  if (entry?.type !== "compaction" || !isRecord(entry.details)) return undefined;
  if (![DETAILS_KIND, LEGACY_DETAILS_KIND].includes(String(entry.details.kind))) return undefined;
  const details = entry.details as unknown as NativeDetails;
  return Array.isArray(details.output) && details.output.length > 0 ? details : undefined;
}

function latestCompaction(entries: SessionEntry[]): SessionEntry | undefined {
  return [...entries].reverse().find((entry) => entry.type === "compaction");
}

function latestNative(entries: SessionEntry[]): { entry: SessionEntry; details: NativeDetails; index: number } | undefined {
  const entry = latestCompaction(entries);
  const details = nativeDetails(entry);
  if (!entry || !details) return undefined;
  return { entry, details, index: entries.indexOf(entry) };
}

function supportsNative(model: Model<Api>): boolean {
  return model.api === "openai-responses" || model.api === "openai-codex-responses";
}

function normalizedBaseUrl(value: string): string {
  return value.replace(/\/+$/u, "").toLowerCase();
}

function parseTextSignature(signature: string | undefined): { id?: string; phase?: "commentary" | "final_answer" } {
  if (!signature) return {};
  if (!signature.startsWith("{")) return { id: signature };
  try {
    const parsed = JSON.parse(signature) as Record<string, unknown>;
    return {
      ...(typeof parsed.id === "string" ? { id: parsed.id } : {}),
      ...(parsed.phase === "commentary" || parsed.phase === "final_answer" ? { phase: parsed.phase } : {}),
    };
  } catch {
    return {};
  }
}

function userContent(content: unknown, model: Model<Api>): unknown[] {
  const blocks = typeof content === "string" ? [{ type: "text", text: content }] : Array.isArray(content) ? content : [];
  const items: unknown[] = [];
  for (const block of blocks) {
    if (!isRecord(block)) continue;
    if (block.type === "text" && typeof block.text === "string") items.push({ type: "input_text", text: block.text });
    if (block.type === "image" && model.input.includes("image") && typeof block.data === "string" && typeof block.mimeType === "string") {
      items.push({ type: "input_image", detail: "auto", image_url: `data:${block.mimeType};base64,${block.data}` });
    }
  }
  return items;
}

function assistantItems(message: Extract<Message, { role: "assistant" }>, index: number): unknown[] {
  if (message.stopReason === "error" || message.stopReason === "aborted") return [];
  return message.content.flatMap((block, blockIndex) => {
    if (block.type === "thinking") {
      if (!block.thinkingSignature) return [];
      try { return [JSON.parse(block.thinkingSignature)]; } catch { return []; }
    }
    if (block.type === "text") {
      const signature = parseTextSignature(block.textSignature);
      return [{
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: block.text, annotations: [] }],
        status: "completed",
        id: signature.id ?? `msg_pi_${index}_${blockIndex}`,
        ...(signature.phase ? { phase: signature.phase } : {}),
      }];
    }
    const [callId, itemId] = block.id.split("|");
    return [{
      type: "function_call",
      ...(itemId ? { id: itemId } : {}),
      call_id: callId,
      name: block.name,
      arguments: JSON.stringify(block.arguments),
    }];
  });
}

function toolOutput(message: ToolResultMessage, model: Model<Api>): unknown {
  const content = userContent(message.content, model);
  const hasImage = content.some((item) => isRecord(item) && item.type === "input_image");
  if (hasImage) return content;
  return content.flatMap((item) => isRecord(item) && typeof item.text === "string" ? [item.text] : []).join("\n") || "No result provided";
}

function serializeMessages(model: Model<Api>, messages: AgentMessage[]): unknown[] {
  const converted = convertToLlm(messages);
  const input: unknown[] = [];
  const pendingCalls = new Map<string, ToolCall>();
  converted.forEach((message, index) => {
    if (message.role === "user") {
      for (const call of pendingCalls.values()) input.push({ type: "function_call_output", call_id: call.id.split("|")[0], output: "No result provided" });
      pendingCalls.clear();
      const content = userContent(message.content, model);
      if (content.length > 0) input.push({ role: "user", content });
      return;
    }
    if (message.role === "assistant") {
      for (const call of pendingCalls.values()) input.push({ type: "function_call_output", call_id: call.id.split("|")[0], output: "No result provided" });
      pendingCalls.clear();
      input.push(...assistantItems(message, index));
      for (const block of message.content) if (block.type === "toolCall") pendingCalls.set(block.id, block);
      return;
    }
    pendingCalls.delete(message.toolCallId);
    input.push({ type: "function_call_output", call_id: message.toolCallId.split("|")[0], output: toolOutput(message, model) });
  });
  for (const call of pendingCalls.values()) input.push({ type: "function_call_output", call_id: call.id.split("|")[0], output: "No result provided" });
  return input;
}

function codexAccountId(token: string): string | undefined {
  try {
    const payloadPart = token.split(".")[1];
    if (!payloadPart) return undefined;
    const payload = JSON.parse(Buffer.from(payloadPart, "base64url").toString("utf8")) as Record<string, unknown>;
    const auth = payload["https://api.openai.com/auth"];
    return isRecord(auth) && typeof auth.chatgpt_account_id === "string" ? auth.chatgpt_account_id : undefined;
  } catch {
    return undefined;
  }
}

function authHeaders(model: Model<Api>, auth: { apiKey?: string; headers?: Record<string, string | null> }): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const source of [model.headers, auth.headers]) {
    for (const [name, value] of Object.entries(source ?? {})) if (value !== null) headers[name] = value;
  }
  if (auth.apiKey && !Object.keys(headers).some((name) => name.toLowerCase() === "authorization")) headers.authorization = `Bearer ${auth.apiKey}`;
  if (model.api === "openai-codex-responses" && auth.apiKey) {
    const accountId = codexAccountId(auth.apiKey);
    if (accountId) headers["chatgpt-account-id"] = accountId;
    headers.originator = "pi";
    headers["OpenAI-Beta"] = "responses=experimental";
  }
  return headers;
}

function requestExtras(payload: Record<string, unknown>): Partial<RemoteCompactionRequest> {
  const extras: Record<string, unknown> = {};
  for (const field of EXTRA_FIELDS) if (payload[field] !== undefined) extras[field] = structuredClone(payload[field]);
  return extras as Partial<RemoteCompactionRequest>;
}

function markerIndex(input: unknown[]): number {
  return input.findIndex((item) => JSON.stringify(item).includes(NATIVE_SUMMARY_MARKER));
}

export class NativeCompaction {
  private estimatedTokensAfter: number | null = null;
  private requestContext: RequestContext | undefined;

  constructor(
    private readonly getSession: () => AgentSession | undefined,
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  asExtension(): InlineExtension {
    return { name: "pi-ecode-native-compaction", factory: (pi) => this.register(pi) };
  }

  consumeEstimatedTokensAfter(): number | null {
    const estimate = this.estimatedTokensAfter;
    this.estimatedTokensAfter = null;
    return estimate;
  }

  storedEstimatedTokensAfter(session: AgentSession): number | null {
    return latestNative(session.sessionManager.getBranch())?.details.estimatedTokensAfter ?? null;
  }

  supports(model: Model<Api> | undefined): boolean {
    return Boolean(model && supportsNative(model));
  }

  private register(pi: ExtensionAPI): void {
    pi.on("before_provider_request", (event, ctx) => this.handleProviderRequest(event, ctx));
    pi.on("session_before_compact", (event, ctx) => this.handleCompaction(event, ctx));
  }

  private async handleProviderRequest(event: BeforeProviderRequestEvent, ctx: ExtensionContext): Promise<unknown> {
    const session = this.getSession();
    const model = ctx.model;
    if (!session || !model || !supportsNative(model) || !isRecord(event.payload) || !Array.isArray(event.payload.input)) return undefined;
    this.requestContext = { sessionId: session.sessionId, extras: requestExtras(event.payload) };
    const current = latestNative(ctx.sessionManager.getBranch());
    if (!current) return undefined;
    const auth = await session.modelRuntime.getAuth(model);
    const baseUrl = auth?.auth.baseUrl ?? model.baseUrl;
    if (normalizedBaseUrl(baseUrl) !== normalizedBaseUrl(current.details.baseUrl)) return undefined;
    const index = markerIndex(event.payload.input);
    if (index < 0) {
      ctx.abort();
      throw new Error("Native compaction replay failed: the pi summary marker was not found; provider request aborted.");
    }
    return {
      ...event.payload,
      input: [...event.payload.input.slice(0, index), ...structuredClone(current.details.output), ...event.payload.input.slice(index + 1)],
    };
  }

  private async handleCompaction(event: SessionBeforeCompactEvent, ctx: ExtensionContext) {
    const session = this.getSession();
    const model = ctx.model;
    if (!session || !model || !supportsNative(model)) return undefined;
    const auth = await session.modelRuntime.getAuth(model);
    const baseUrl = auth?.auth.baseUrl ?? model.baseUrl;
    const branch = event.branchEntries;
    const previous = latestNative(branch);
    if (previous && normalizedBaseUrl(previous.details.baseUrl) !== normalizedBaseUrl(baseUrl)) {
      throw new Error("Native compaction endpoint changed; preserving the existing opaque checkpoint.");
    }
    const input = this.compactionInput(event, ctx, model, previous);
    const extras = this.requestContext?.sessionId === session.sessionId ? this.requestContext.extras : {};
    let result;
    try {
      result = await requestRemoteCompaction({
        model,
        baseUrl,
        headers: authHeaders(model, auth?.auth ?? {}),
        request: { model: model.id, input, instructions: ctx.getSystemPrompt(), ...extras },
        signal: event.signal,
        fetcher: this.fetcher,
      });
    } catch (error) {
      if (event.signal.aborted || (error instanceof Error && error.name === "AbortError")) return { cancel: true };
      if (error instanceof RemoteCompactionError && error.unsupported && !previous) return undefined;
      throw error;
    }
    const estimatedTokensAfter = Math.min(
      event.preparation.tokensBefore,
      Math.ceil(JSON.stringify(result.output).length / 4) + event.preparation.settings.keepRecentTokens,
    );
    this.estimatedTokensAfter = estimatedTokensAfter;
    return {
      compaction: {
        summary: NATIVE_SUMMARY_MARKER,
        firstKeptEntryId: event.preparation.firstKeptEntryId,
        tokensBefore: event.preparation.tokensBefore,
        details: {
          kind: DETAILS_KIND,
          provider: model.provider,
          model: model.id,
          baseUrl,
          output: result.output,
          estimatedTokensAfter,
          ...(result.responseId ? { responseId: result.responseId } : {}),
          ...(result.usage ? { usage: result.usage } : {}),
        } satisfies NativeDetails,
      },
    };
  }

  private compactionInput(
    event: SessionBeforeCompactEvent,
    ctx: ExtensionContext,
    model: Model<Api>,
    previous: ReturnType<typeof latestNative>,
  ): unknown[] {
    if (previous) {
      const liveTail = event.branchEntries.slice(previous.index + 1).flatMap(sessionEntryToContextMessages);
      return [...structuredClone(previous.details.output), ...serializeMessages(model, liveTail)];
    }
    const manager = ctx.sessionManager as typeof ctx.sessionManager & { buildSessionContext?: () => { messages: AgentMessage[] } };
    const messages = manager.buildSessionContext?.().messages ?? [...event.preparation.messagesToSummarize, ...event.preparation.turnPrefixMessages];
    return serializeMessages(model, messages);
  }
}
