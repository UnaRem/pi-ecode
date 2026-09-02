import type { StreamFn } from "@earendil-works/pi-agent-core";
import {
  createAssistantMessageEventStream,
  type Api,
  type AssistantMessage,
  type AssistantMessageEvent,
  type Model,
} from "@earendil-works/pi-ai";
import type { AgentSession } from "@earendil-works/pi-coding-agent";

interface StreamAgent {
  streamFunction: StreamFn;
}

interface SessionWithAgent {
  agent: StreamAgent;
}

const ERROR_ALIASES: ReadonlyArray<[RegExp, string]> = [
  [/\bupstream_error\b/iu, "service unavailable"],
  [/\bstream_read_error\b/iu, "connection lost"],
];

export function normalizeRetryableError(event: AssistantMessageEvent): AssistantMessageEvent {
  if (event.type !== "error" || event.reason !== "error" || !event.error.errorMessage) return event;
  const alias = ERROR_ALIASES.find(([pattern]) => pattern.test(event.error.errorMessage ?? ""));
  if (!alias) return event;
  const [, retryableDescription] = alias;
  return {
    ...event,
    error: { ...event.error, errorMessage: `${event.error.errorMessage} (${retryableDescription})` },
  };
}

function failedMessage(model: Model<Api>, error: unknown, aborted: boolean): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: aborted ? "aborted" : "error",
    errorMessage: error instanceof Error ? error.message : String(error),
    timestamp: Date.now(),
  };
}

export class StreamContinuity {
  private readonly installedSessions = new WeakSet<AgentSession>();

  install(session: AgentSession): void {
    if (this.installedSessions.has(session)) return;
    const agent = (session as unknown as SessionWithAgent).agent;
    const original = agent.streamFunction;
    agent.streamFunction = (model, context, options) => {
      const output = createAssistantMessageEventStream();
      void (async () => {
        try {
          const source = await original(model, context, options);
          for await (const event of source) output.push(normalizeRetryableError(event));
        } catch (error) {
          const aborted = options?.signal?.aborted ?? false;
          const message = failedMessage(model, error, aborted);
          output.push({ type: "error", reason: aborted ? "aborted" : "error", error: message });
        }
      })();
      return output;
    };
    this.installedSessions.add(session);
  }
}
