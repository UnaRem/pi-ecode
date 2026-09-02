import { randomUUID } from "node:crypto";
import type { ExtensionUIContext, ExtensionUIDialogOptions } from "@earendil-works/pi-coding-agent";
import type { ExtensionUiRequest, ExtensionUiResponse } from "../../shared/contracts.js";

type ExtensionUiValue = ExtensionUiResponse["value"];

interface PendingRequest {
  request: ExtensionUiRequest;
  resolve: (value: ExtensionUiValue) => void;
  timer: ReturnType<typeof setTimeout> | undefined;
}

interface QuestionnaireOption {
  label: string;
  description: string;
}

interface QuestionnaireQuestion {
  question: string;
  header: string;
  multiSelect: boolean;
  options: QuestionnaireOption[];
}

interface QuestionnaireMetadata {
  questions: QuestionnaireQuestion[];
}

function questionnaireMetadata(value: unknown): QuestionnaireMetadata | null {
  if (!value || typeof value !== "object") return null;
  const questions = (value as { questions?: unknown }).questions;
  if (!Array.isArray(questions)) return null;
  const normalized: QuestionnaireQuestion[] = [];
  for (const question of questions) {
    if (!question || typeof question !== "object") return null;
    const candidate = question as Record<string, unknown>;
    if (typeof candidate.question !== "string" || typeof candidate.header !== "string" || typeof candidate.multiSelect !== "boolean" || !Array.isArray(candidate.options)) return null;
    const options = candidate.options.flatMap((option) => {
      if (!option || typeof option !== "object") return [];
      const item = option as Record<string, unknown>;
      return typeof item.label === "string" && typeof item.description === "string"
        ? [{ label: item.label, description: item.description }]
        : [];
    });
    if (options.length !== candidate.options.length) return null;
    normalized.push({ question: candidate.question, header: candidate.header, multiSelect: candidate.multiSelect, options });
  }
  return { questions: normalized };
}

export class ExtensionUiBridge {
  private pending: PendingRequest | undefined;
  private questionnaire: QuestionnaireMetadata | null = null;

  constructor(
    private readonly onRequest: (request: ExtensionUiRequest | null) => void,
    private readonly onNotice: (message: string, type?: "info" | "warning" | "error") => void,
  ) {}

  get current(): ExtensionUiRequest | null {
    return this.pending ? structuredClone(this.pending.request) : null;
  }

  setQuestionnaireMetadata(value: unknown): void {
    this.questionnaire = questionnaireMetadata(value);
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
    if (Array.isArray(value)) return value.join(",");
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
    const enrichedRequest = this.enrichRequest(request);
    return new Promise((resolve) => {
      const timeout = dialogOptions?.timeout;
      const timer = timeout === undefined
        ? undefined
        : setTimeout(() => this.settle(null), timeout);
      this.pending = { request: enrichedRequest, resolve, timer };
      this.onRequest(structuredClone(enrichedRequest));
    });
  }

  private enrichRequest(request: ExtensionUiRequest): ExtensionUiRequest {
    const questions = this.questionnaire?.questions;
    if (!questions) return request;
    const questionIndex = questions.findIndex((question) => request.title.includes(question.question));
    if (questionIndex < 0) return request;
    const question = questions[questionIndex];
    if (!question) return request;
    const title = question.header ? `[${question.header}] ${question.question}` : question.question;
    const titleSuffix = request.title.slice(request.title.indexOf(question.question) + question.question.length).trim();
    const common = {
      ...request,
      title,
      ...(titleSuffix ? { message: titleSuffix } : {}),
      questionIndex,
      questionCount: questions.length,
    };
    if (request.method === "input" && question.multiSelect) {
      return {
        ...common,
        method: "multi-select",
        options: question.options.map((option, index) => ({ value: String(index + 1), ...option })),
      };
    }
    if (request.method !== "select" || !request.options) return common;
    return {
      ...common,
      options: request.options.map((option, index) => ({
        value: option.value,
        label: question.options[index]?.label ?? option.label,
        ...(question.options[index] ? { description: question.options[index].description } : {}),
      })),
    };
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
    if (request.method === "multi-select") {
      return typeof value === "string" || (Array.isArray(value) && value.every((item) => request.options?.some((option) => option.value === item)));
    }
    if (typeof value !== "string") return false;
    return request.method !== "select" || Boolean(request.options?.some((option) => option.value === value));
  }
}
