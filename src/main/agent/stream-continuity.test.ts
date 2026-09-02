import { describe, expect, it } from "vitest";
import type { AssistantMessageEvent } from "@earendil-works/pi-ai";
import { normalizeRetryableError } from "./stream-continuity.js";

function errorEvent(message: string): AssistantMessageEvent {
  return {
    type: "error",
    reason: "error",
    error: {
      role: "assistant",
      content: [],
      api: "openai-responses",
      provider: "custom-openai",
      model: "model",
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "error",
      errorMessage: message,
      timestamp: 1,
    },
  };
}

describe("normalizeRetryableError", () => {
  it.each([
    ["upstream_error: Upstream request failed", "service unavailable"],
    ["stream_read_error", "connection lost"],
  ])("marks %s as retryable", (message, expectedAlias) => {
    const normalized = normalizeRetryableError(errorEvent(message));
    expect(normalized.type === "error" ? normalized.error.errorMessage : "").toContain(expectedAlias);
  });

  it("does not alter authentication errors", () => {
    const event = errorEvent("401 invalid API key");
    expect(normalizeRetryableError(event)).toBe(event);
  });
});
