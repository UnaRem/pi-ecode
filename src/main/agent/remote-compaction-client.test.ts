import { describe, expect, it, vi } from "vitest";
import type { Api, Model } from "@earendil-works/pi-ai";
import {
  RemoteCompactionError,
  parseSseEvents,
  requestRemoteCompaction,
  responsesUrl,
} from "./remote-compaction-client.js";

const model = {
  api: "openai-responses",
  id: "model-1",
} as Model<Api>;

const request = {
  model: "model-1",
  input: [{ role: "user", content: [{ type: "input_text", text: "hello" }] }],
  instructions: "instructions",
};

describe("remote compaction v2 client", () => {
  it("builds Responses and Codex Responses endpoints", () => {
    expect(responsesUrl(model, "https://example.com/v1")).toBe("https://example.com/v1/responses");
    expect(responsesUrl({ ...model, api: "openai-codex-responses" }, "https://chatgpt.com/backend-api"))
      .toBe("https://chatgpt.com/backend-api/codex/responses");
  });

  it("parses response.completed and rejects a missing completion", async () => {
    const opaque = { type: "compaction", encrypted_content: "opaque" };
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(
      `event: response.output_item.done\ndata: ${JSON.stringify({ type: "response.output_item.done", item: opaque })}\n\n` +
      `event: response.completed\ndata: ${JSON.stringify({ type: "response.completed", response: { id: "r1", status: "completed", output: [opaque] } })}\n\n`,
      { status: 200 },
    ));
    await expect(requestRemoteCompaction({ model, baseUrl: "https://example.com/v1", headers: {}, request, signal: new AbortController().signal, fetcher }))
      .resolves.toMatchObject({ responseId: "r1", output: [opaque] });

    expect(() => parseSseEvents("not-sse")).toThrow("no SSE events");
  });

  it("preserves a provider 400 response instead of reporting an abort", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(
      JSON.stringify({ error: { message: "unsupported compaction model" } }),
      { status: 400, statusText: "Bad Request" },
    ));
    const operation = requestRemoteCompaction({ model, baseUrl: "https://example.com/v1", headers: {}, request, signal: new AbortController().signal, fetcher });
    await expect(operation).rejects.toMatchObject({
      name: "RemoteCompactionError",
      status: 400,
      message: expect.stringContaining("unsupported compaction model"),
    } satisfies Partial<RemoteCompactionError>);
  });
});
