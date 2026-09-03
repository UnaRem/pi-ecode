import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { describe, expect, it } from "vitest";
import { providerFailure } from "./provider-recovery.js";

function failedAssistant(errorMessage: string): AgentMessage {
  return {
    role: "assistant",
    content: [],
    stopReason: "error",
    errorMessage,
  } as unknown as AgentMessage;
}

describe("providerFailure", () => {
  it.each([
    "502 Bad Gateway",
    "HTTP 429 Too Many Requests",
    "upstream_error: service unavailable",
    "stream_read_error: connection lost",
    "Request timed out",
    "fetch failed",
  ])("allows continuation after %s", (message) => {
    expect(providerFailure([failedAssistant(message)])).toEqual({ message, canContinue: true });
  });

  it.each([
    "401 Unauthorized",
    "403 Forbidden",
    "Invalid API key",
    "context length exceeded",
  ])("does not offer continuation for %s", (message) => {
    expect(providerFailure([failedAssistant(message)])).toEqual({ message, canContinue: false });
  });

  it("ignores a failure that is no longer the latest session message", () => {
    const userMessage = { role: "user", content: "new request" } as unknown as AgentMessage;
    expect(providerFailure([failedAssistant("502 Bad Gateway"), userMessage])).toBeNull();
  });
});
