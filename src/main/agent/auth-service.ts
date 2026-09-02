import { randomUUID } from "node:crypto";
import type { AuthEvent, AuthInteraction, AuthPrompt } from "@earendil-works/pi-ai";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { AuthFlowEvent, AuthPromptRequest, AuthPromptResponse, AuthType } from "../../shared/settings-contracts.js";

interface PendingPrompt {
  request: AuthPromptRequest;
  resolve: (value: string) => void;
  reject: (error: Error) => void;
}

function cancelledError(): Error {
  const error = new Error("Authentication cancelled.");
  error.name = "AbortError";
  return error;
}

export class AuthService {
  private controller: AbortController | undefined;
  private pending: PendingPrompt | undefined;
  private providerId: string | undefined;

  constructor(
    private readonly getRuntime: () => ModelRuntime | undefined,
    private readonly emit: (event: AuthFlowEvent) => void,
    private readonly openExternal: (url: string) => Promise<void>,
  ) {}

  async login(providerId: string, type: AuthType): Promise<void> {
    if (this.controller) throw new Error("Another authentication flow is already running.");
    const runtime = this.requireRuntime();
    const provider = runtime.getProvider(providerId);
    if (!provider) throw new Error(`Provider not found: ${providerId}`);
    const method = type === "oauth" ? provider.auth.oauth : provider.auth.apiKey;
    if (!method?.login) throw new Error(`${provider.name} does not support ${type} login.`);

    this.controller = new AbortController();
    this.providerId = providerId;
    this.publish("running", `Starting ${method.name}…`, null);
    const interaction: AuthInteraction = {
      signal: this.controller.signal,
      prompt: (prompt) => this.requestPrompt(providerId, prompt),
      notify: (event) => this.handleNotification(event),
    };
    try {
      await runtime.login(providerId, type, interaction);
      this.publish("completed", `${provider.name} authentication completed.`, null);
    } catch (error) {
      const cancelled = this.controller.signal.aborted || (error instanceof Error && error.name === "AbortError");
      this.publish(cancelled ? "cancelled" : "failed", cancelled ? "Authentication cancelled." : error instanceof Error ? error.message : String(error), null);
      if (!cancelled) throw error;
    } finally {
      this.rejectPending(cancelledError());
      this.controller = undefined;
      this.providerId = undefined;
    }
  }

  async logout(providerId: string): Promise<void> {
    await this.requireRuntime().logout(providerId);
    this.emit({ type: "auth-flow", state: { providerId, status: "completed", message: "Signed out.", request: null } });
  }

  respond(response: AuthPromptResponse): boolean {
    const pending = this.pending;
    if (!pending || pending.request.id !== response.requestId) return false;
    if (response.value !== null && pending.request.type === "select" && !pending.request.options?.some((option) => option.id === response.value)) return false;
    this.pending = undefined;
    if (response.value === null) pending.reject(cancelledError());
    else pending.resolve(response.value);
    return true;
  }

  cancel(): void {
    this.controller?.abort();
    this.rejectPending(cancelledError());
  }

  private requireRuntime(): ModelRuntime {
    const runtime = this.getRuntime();
    if (!runtime) throw new Error("Open a project before configuring provider authentication.");
    return runtime;
  }

  private requestPrompt(providerId: string, prompt: AuthPrompt): Promise<string> {
    if (this.pending) return Promise.reject(new Error("Authentication already has a pending prompt."));
    const request: AuthPromptRequest = {
      id: randomUUID(),
      providerId,
      type: prompt.type,
      message: prompt.message,
      ...("placeholder" in prompt && prompt.placeholder ? { placeholder: prompt.placeholder } : {}),
      ...(prompt.type === "select" ? { options: prompt.options.map((option) => ({ ...option })) } : {}),
    };
    return new Promise((resolve, reject) => {
      this.pending = { request, resolve, reject };
      prompt.signal?.addEventListener("abort", () => this.rejectPending(cancelledError()), { once: true });
      this.publish("running", prompt.message, request);
    });
  }

  private handleNotification(event: AuthEvent): void {
    if (event.type === "auth_url") {
      void this.openExternal(event.url);
      this.publish("running", event.instructions ?? "Continue authentication in your browser.", null);
      return;
    }
    if (event.type === "device_code") {
      void this.openExternal(event.verificationUri);
      this.publish("running", `Enter device code: ${event.userCode}`, null);
      return;
    }
    this.publish("running", event.message, null);
  }

  private publish(status: "running" | "completed" | "failed" | "cancelled", message: string, request: AuthPromptRequest | null): void {
    this.emit({ type: "auth-flow", state: { providerId: this.providerId ?? "", status, message, request } });
  }

  private rejectPending(error: Error): void {
    const pending = this.pending;
    if (!pending) return;
    this.pending = undefined;
    pending.reject(error);
  }
}
