import { randomUUID } from "node:crypto";
import type { ExtensionUIContext, ExtensionUIDialogOptions } from "@earendil-works/pi-coding-agent";
import type { ExtensionUiRequest, ExtensionUiResponse } from "../../shared/contracts.js";

type ExtensionUiValue = ExtensionUiResponse["value"];

interface PendingRequest {
  request: ExtensionUiRequest;
  resolve: (value: ExtensionUiValue) => void;
  timer: ReturnType<typeof setTimeout> | undefined;
}

export class ExtensionUiBridge {
  private pending: PendingRequest | undefined;

  constructor(
    private readonly onRequest: (request: ExtensionUiRequest | null) => void,
    private readonly onNotice: (message: string, type?: "info" | "warning" | "error") => void,
  ) {}

  get current(): ExtensionUiRequest | null {
    return this.pending ? structuredClone(this.pending.request) : null;
  }

  createContext(fallback: ExtensionUIContext): ExtensionUIContext {
    const context = Object.create(fallback) as ExtensionUIContext;
    context.select = (title, options, dialogOptions) => this.select(title, options, dialogOptions);
    context.confirm = (title, message, dialogOptions) => this.confirm(title, message, dialogOptions);
    context.input = (title, placeholder, dialogOptions) => this.input(title, placeholder, dialogOptions);
    context.editor = (title, prefill) => this.editor(title, prefill);
    context.notify = (message, type) => this.onNotice(message, type);
    return context;
  }

  respond(response: ExtensionUiResponse): boolean {
    const pending = this.pending;
    if (!pending || pending.request.id !== response.requestId) return false;
    if (!this.isValidResponse(pending.request, response.value)) return false;
    this.settle(response.value);
    return true;
  }

  cancelPending(): void {
    if (this.pending) this.settle(null);
  }

  private async select(title: string, options: string[], dialogOptions?: ExtensionUIDialogOptions): Promise<string | undefined> {
    const value = await this.request({
      id: randomUUID(),
      method: "select",
      title,
      options: options.map((option) => ({ value: option, label: option })),
    }, dialogOptions);
    return typeof value === "string" ? value : undefined;
  }

  private async confirm(title: string, message: string, dialogOptions?: ExtensionUIDialogOptions): Promise<boolean> {
    const value = await this.request({ id: randomUUID(), method: "confirm", title, message }, dialogOptions);
    return typeof value === "boolean" ? value : false;
  }

  private async input(title: string, placeholder?: string, dialogOptions?: ExtensionUIDialogOptions): Promise<string | undefined> {
    const value = await this.request({
      id: randomUUID(),
      method: "input",
      title,
      ...(placeholder !== undefined ? { placeholder } : {}),
    }, dialogOptions);
    return typeof value === "string" ? value : undefined;
  }

  private async editor(title: string, prefill?: string): Promise<string | undefined> {
    const value = await this.request({
      id: randomUUID(),
      method: "editor",
      title,
      ...(prefill !== undefined ? { prefill } : {}),
    });
    return typeof value === "string" ? value : undefined;
  }

  private request(request: ExtensionUiRequest, dialogOptions?: ExtensionUIDialogOptions): Promise<ExtensionUiValue> {
    if (this.pending) return Promise.resolve(null);
    return new Promise((resolve) => {
      const timeout = dialogOptions?.timeout;
      const timer = timeout === undefined
        ? undefined
        : setTimeout(() => this.settle(null), timeout);
      this.pending = { request, resolve, timer };
      this.onRequest(structuredClone(request));
    });
  }

  private settle(value: ExtensionUiValue): void {
    const pending = this.pending;
    if (!pending) return;
    if (pending.timer) clearTimeout(pending.timer);
    this.pending = undefined;
    this.onRequest(null);
    pending.resolve(value);
  }

  private isValidResponse(request: ExtensionUiRequest, value: ExtensionUiValue): boolean {
    if (value === null) return true;
    if (request.method === "confirm") return typeof value === "boolean";
    if (request.method === "multi-select") return Array.isArray(value) && value.every((item) => typeof item === "string");
    if (typeof value !== "string") return false;
    return request.method !== "select" || Boolean(request.options?.some((option) => option.value === value));
  }
}
