import type { AgentMessage } from "@earendil-works/pi-agent-core";

export interface ProviderFailure {
  message: string;
  canContinue: boolean;
}

export const PROVIDER_RECOVERY_PROMPT = "The previous assistant response was interrupted by a temporary provider or network error. Continue from where it stopped. Review the existing conversation and tool results, do not repeat work already completed, and finish the remaining task.";

const NON_RECOVERABLE_PATTERNS = [
  /\b(?:401|403)\b/iu,
  /\b(?:unauthori[sz]ed|forbidden|authentication)\b/iu,
  /invalid[^\n]*(?:api[ _-]?key|credential)/iu,
  /context[^\n]*(?:length|window)|too many tokens/iu,
];

const RECOVERABLE_PATTERNS = [
  /\b(?:408|429|5\d{2})\b/u,
  /\b(?:upstream_error|stream_read_error|overloaded)\b/iu,
  /\b(?:timed? out|timeout|econnreset|etimedout|socket hang up)\b/iu,
  /\b(?:connection|network|stream)[^\n]*(?:closed|failed|interrupted|lost|reset|unavailable)/iu,
  /\bfetch failed\b/iu,
];

export function providerFailure(messages: AgentMessage[]): ProviderFailure | null {
  const lastMessage = messages.at(-1);
  if (lastMessage?.role !== "assistant" || lastMessage.stopReason !== "error" || !lastMessage.errorMessage) return null;
  const message = lastMessage.errorMessage;
  const excluded = NON_RECOVERABLE_PATTERNS.some((pattern) => pattern.test(message));
  return {
    message,
    canContinue: !excluded && RECOVERABLE_PATTERNS.some((pattern) => pattern.test(message)),
  };
}
