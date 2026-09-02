import { describe, expect, it, vi } from "vitest";
import type { Api, Model } from "@earendil-works/pi-ai";
import type {
  AgentSession,
  ExtensionAPI,
  ExtensionContext,
  SessionBeforeCompactEvent,
} from "@earendil-works/pi-coding-agent";
import { NativeCompaction } from "./native-compaction.js";

type CompactHandler = (
  event: SessionBeforeCompactEvent,
  context: ExtensionContext,
) => Promise<{
  compaction?: { summary: string; firstKeptEntryId: string; details?: unknown };
} | undefined>;

const model = {
  api: "openai-responses",
  provider: "third-party",
  id: "model-1",
  baseUrl: "https://provider.example/v1",
  headers: { "x-provider": "ecode" },
} as unknown as Model<Api>;

function compactEvent(): SessionBeforeCompactEvent {
  return {
    type: "session_before_compact",
    preparation: {
      firstKeptEntryId: "kept-1",
      messagesToSummarize: [{ role: "user", content: [{ type: "text", text: "old question" }], timestamp: 1 }],
      turnPrefixMessages: [],
      isSplitTurn: false,
      tokensBefore: 50_000,
      fileOps: { read: new Set(), written: new Set(), edited: new Set() },
      settings: { enabled: true, reserveTokens: 16_384, keepRecentTokens: 20_000 },
    },
    branchEntries: [],
    reason: "manual",
    willRetry: false,
    signal: new AbortController().signal,
  } as unknown as SessionBeforeCompactEvent;
}

function registerHandler(nativeCompaction: NativeCompaction): CompactHandler {
  let handler: CompactHandler | undefined;
  const pi = {
    on: (event: string, callback: CompactHandler) => {
      if (event === "session_before_compact") handler = callback;
    },
  } as unknown as ExtensionAPI;
  const extension = nativeCompaction.asExtension();
  if (typeof extension === "function") void extension(pi);
  else void extension.factory(pi);
  if (!handler) throw new Error("Compaction handler was not registered.");
  return handler;
}

function fakeSession(entries: unknown[] = []): AgentSession {
  return {
    modelRuntime: {
      getAuth: vi.fn().mockResolvedValue({
        auth: { apiKey: "secret", baseUrl: "https://gateway.example/v1", headers: { "x-auth": "yes" } },
      }),
    },
    sessionManager: { getBranch: () => entries },
    agent: { streamFunction: vi.fn(), onPayload: undefined },
  } as unknown as AgentSession;
}

function context(activeModel: Model<Api> = model): ExtensionContext {
  return { model: activeModel, getSystemPrompt: () => "project instructions" } as unknown as ExtensionContext;
}

describe("NativeCompaction", () => {
  it("uses the active Responses base URL and persists the opaque compaction item", async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
      output: [{ type: "compaction", id: "cmp_1", encrypted_content: "opaque" }],
      usage: { input_tokens: 1200, output_tokens: 80, total_tokens: 1280 },
    }), { status: 200 }));
    const session = fakeSession();
    const nativeCompaction = new NativeCompaction(() => session, request);

    const result = await registerHandler(nativeCompaction)(compactEvent(), context());

    expect(request).toHaveBeenCalledWith(
      "https://gateway.example/v1/responses/compact",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ authorization: "Bearer secret", "x-auth": "yes" }),
      }),
    );
    const requestBody = JSON.parse(String((request.mock.calls[0]?.[1] as RequestInit).body)) as Record<string, unknown>;
    expect(requestBody.instructions).toBe("project instructions");
    expect(result?.compaction).toMatchObject({
      summary: "[pi-ecode:openai-native-compaction]",
      firstKeptEntryId: "kept-1",
      details: {
        kind: "pi-ecode.openai-native-compaction.v1",
        output: [{ type: "compaction", encrypted_content: "opaque" }],
      },
    });
  });

  it("builds the Codex backend endpoint and account header for OAuth models", async () => {
    const accountPayload = Buffer.from(JSON.stringify({
      "https://api.openai.com/auth": { chatgpt_account_id: "account-1" },
    })).toString("base64url");
    const request = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
      output: [{ type: "compaction", encrypted_content: "opaque" }],
      usage: {},
    }), { status: 200 }));
    const session = fakeSession();
    vi.mocked(session.modelRuntime.getAuth).mockResolvedValue({
      auth: { apiKey: `header.${accountPayload}.signature`, baseUrl: "https://chatgpt.com/backend-api" },
    });
    const codexModel = { ...model, api: "openai-codex-responses", provider: "openai-codex" } as Model<Api>;

    await registerHandler(new NativeCompaction(() => session, request))(compactEvent(), context(codexModel));

    expect(request).toHaveBeenCalledWith(
      "https://chatgpt.com/backend-api/codex/responses/compact",
      expect.objectContaining({ headers: expect.objectContaining({ "chatgpt-account-id": "account-1" }) }),
    );
  });

  it("falls back to pi summarization when compact is explicitly unsupported", async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(new Response("not found", { status: 404 }));
    const nativeCompaction = new NativeCompaction(() => fakeSession(), request);
    await expect(registerHandler(nativeCompaction)(compactEvent(), context())).resolves.toBeUndefined();
  });

  it("injects a persisted native output in place of the pi summary marker", async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
      output: [{ type: "compaction", encrypted_content: "opaque" }],
      usage: {},
    }), { status: 200 }));
    const initialSession = fakeSession();
    const nativeCompaction = new NativeCompaction(() => initialSession, request);
    const result = await registerHandler(nativeCompaction)(compactEvent(), context());
    const details = result?.compaction?.details;
    const entry = { type: "compaction", summary: "marker", details };
    const session = fakeSession([entry]);

    nativeCompaction.installPayloadInjection(session);
    const agent = (session as unknown as { agent: { onPayload: NonNullable<unknown> } }).agent;
    const transform = agent.onPayload as (payload: unknown, activeModel: Model<Api>) => Promise<unknown>;
    const transformed = await transform({
      input: [
        { role: "developer", content: "system" },
        { role: "user", content: [{ type: "input_text", text: "Summary [pi-ecode:openai-native-compaction]" }] },
        { role: "user", content: "recent" },
      ],
    }, model) as { input: unknown[] };

    expect(transformed.input).toEqual([
      { role: "developer", content: "system" },
      { type: "compaction", encrypted_content: "opaque" },
      { role: "user", content: "recent" },
    ]);
  });
});
