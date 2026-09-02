import { describe, expect, it, vi } from "vitest";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { AgentSession, ExtensionAPI, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import { NativeCompaction } from "./native-compaction.js";

const model = {
  api: "openai-responses",
  provider: "third-party",
  id: "model-1",
  baseUrl: "https://provider.example/v1",
  headers: { "x-provider": "ecode" },
  input: ["text", "image"],
} as unknown as Model<Api>;

interface Handlers {
  compact?: (event: any, context: ExtensionContext) => Promise<any>;
  provider?: (event: any, context: ExtensionContext) => Promise<unknown>;
}

function register(nativeCompaction: NativeCompaction): Handlers {
  const handlers: Handlers = {};
  const pi = {
    on: (name: string, callback: (event: any, context: ExtensionContext) => Promise<unknown>) => {
      if (name === "session_before_compact") handlers.compact = callback;
      if (name === "before_provider_request") handlers.provider = callback;
    },
  } as unknown as ExtensionAPI;
  const extension = nativeCompaction.asExtension();
  if (typeof extension === "function") void extension(pi);
  else void extension.factory(pi);
  return handlers;
}

function fakeSession(branch: SessionEntry[] = []): AgentSession {
  return {
    sessionId: "session-1",
    modelRuntime: {
      getAuth: vi.fn().mockResolvedValue({
        auth: { apiKey: "secret", baseUrl: "https://gateway.example/v1", headers: { "x-auth": "yes" } },
      }),
    },
    sessionManager: { getBranch: () => branch },
  } as unknown as AgentSession;
}

function context(branch: SessionEntry[] = [], activeModel: Model<Api> = model): ExtensionContext {
  return {
    model: activeModel,
    getSystemPrompt: () => "project instructions",
    abort: vi.fn(),
    sessionManager: {
      getBranch: () => branch,
      buildSessionContext: () => ({
        messages: [{ role: "user", content: [{ type: "text", text: "old question" }], timestamp: 1 }],
      }),
    },
  } as unknown as ExtensionContext;
}

function compactEvent(branch: SessionEntry[] = [], signal = new AbortController().signal): any {
  return {
    type: "session_before_compact",
    preparation: {
      firstKeptEntryId: "kept-1",
      messagesToSummarize: [{ role: "user", content: [{ type: "text", text: "old question" }], timestamp: 1 }],
      turnPrefixMessages: [],
      tokensBefore: 50_000,
      settings: { keepRecentTokens: 20_000 },
    },
    branchEntries: branch,
    reason: "manual",
    willRetry: false,
    signal,
  };
}

function sse(opaque = "opaque"): Response {
  return new Response(
    `event: response.completed\ndata: ${JSON.stringify({
      type: "response.completed",
      response: {
        id: "resp-1",
        status: "completed",
        output: [{ type: "compaction", id: "cmp-1", encrypted_content: opaque }],
        usage: { input_tokens: 1000, output_tokens: 10, total_tokens: 1010 },
      },
    })}\n\n`,
    { status: 200, headers: { "content-type": "text/event-stream" } },
  );
}

describe("NativeCompaction", () => {
  it("uses remote_compaction_v2 on the normal Responses endpoint", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(sse());
    const session = fakeSession();
    const handlers = register(new NativeCompaction(() => session, fetcher));

    const result = await handlers.compact?.(compactEvent(), context());

    expect(fetcher).toHaveBeenCalledWith(
      "https://gateway.example/v1/responses",
      expect.objectContaining({ headers: expect.objectContaining({ authorization: "Bearer secret", accept: "text/event-stream" }) }),
    );
    const body = JSON.parse(String((fetcher.mock.calls[0]?.[1] as RequestInit).body)) as Record<string, any>;
    expect(body).toMatchObject({ model: "model-1", instructions: "project instructions", stream: true, store: false });
    expect(body.input.at(-1)).toEqual({ type: "compaction_trigger" });
    expect(result?.compaction).toMatchObject({
      summary: "[pi-ecode:remote-compaction-v2]",
      details: { kind: "pi-ecode.remote-compaction-v2", output: [{ type: "compaction", encrypted_content: "opaque" }] },
    });
  });

  it("migrates an existing pi text summary to a remote v2 checkpoint", async () => {
    const textCompaction = {
      type: "compaction",
      id: "text-compact-1",
      parentId: "parent",
      timestamp: new Date().toISOString(),
      summary: "legacy text summary",
      firstKeptEntryId: "kept-1",
      tokensBefore: 40_000,
    } as SessionEntry;
    const branch = [textCompaction];
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(sse());
    const session = fakeSession(branch);
    const handlers = register(new NativeCompaction(() => session, fetcher));

    const result = await handlers.compact?.(compactEvent(branch), context(branch));

    expect(fetcher).toHaveBeenCalledOnce();
    const body = JSON.parse(String((fetcher.mock.calls[0]?.[1] as RequestInit).body)) as Record<string, any>;
    expect(JSON.stringify(body.input)).toContain("old question");
    expect(result?.compaction?.details).toMatchObject({ kind: "pi-ecode.remote-compaction-v2" });
  });

  it("replaces only the pi summary sentinel during provider replay", async () => {
    const details = {
      kind: "pi-ecode.remote-compaction-v2",
      provider: "third-party",
      model: "model-1",
      baseUrl: "https://gateway.example/v1",
      output: [{ type: "compaction", encrypted_content: "opaque" }],
      estimatedTokensAfter: 20_010,
    };
    const entry = { type: "compaction", id: "compact-1", parentId: "parent", timestamp: new Date().toISOString(), summary: "marker", firstKeptEntryId: "kept-1", tokensBefore: 10, details } as SessionEntry;
    const branch = [entry];
    const session = fakeSession(branch);
    const handlers = register(new NativeCompaction(() => session));
    const payload = {
      model: "model-1",
      input: [
        { role: "developer", content: "system" },
        { role: "user", content: [{ type: "input_text", text: "<summary>[pi-ecode:remote-compaction-v2]</summary>" }] },
        { role: "user", content: [{ type: "input_text", text: "recent" }] },
      ],
      reasoning: { effort: "high" },
    };

    const rewritten = await handlers.provider?.({ type: "before_provider_request", payload }, context(branch)) as typeof payload;

    expect(rewritten.input).toEqual([
      { role: "developer", content: "system" },
      { type: "compaction", encrypted_content: "opaque" },
      { role: "user", content: [{ type: "input_text", text: "recent" }] },
    ]);
  });

  it("returns cancel when the remote request is aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const fetcher = vi.fn<typeof fetch>().mockRejectedValue(new DOMException("aborted", "AbortError"));
    const session = fakeSession();
    const handlers = register(new NativeCompaction(() => session, fetcher));

    await expect(handlers.compact?.(compactEvent([], controller.signal), context())).resolves.toEqual({ cancel: true });
  });
});
