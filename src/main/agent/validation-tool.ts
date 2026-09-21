import type { ExtensionAPI, InlineExtension } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { ValidationState } from "../../shared/contracts.js";

const VALIDATION_RESULT_MESSAGE = "pi-ecode.validation-result";
const TERMINAL_STATUSES = new Set<ValidationState["status"]>(["passed", "failed", "cancelled", "stale"]);

interface ValidationToolOptions {
  getState: () => ValidationState;
  start: (originToolCallId: string) => void;
}

function resultText(state: ValidationState): string {
  const steps = state.steps
    .filter((step) => step.status !== "skipped")
    .map((step) => `- ${step.id}: ${step.status}${step.exitCode === null ? "" : ` (exit ${step.exitCode})`}`)
    .join("\n");
  return `<validation_result run_id="${state.runId ?? "unknown"}" status="${state.status}">
${state.message ?? "Validation finished."}
${steps}
</validation_result>`;
}

export class ValidationToolService {
  private extensionApi: ExtensionAPI | undefined;
  private readonly deliveredRunIds = new Set<string>();
  private preserveNextAgentStart = false;

  constructor(private readonly options: ValidationToolOptions) {}

  asExtension(): InlineExtension {
    return { name: "pi-ecode-validation-tool", factory: (pi) => this.register(pi) };
  }

  onValidationChanged(state: ValidationState): void {
    const runId = state.runId;
    if (!runId || !state.originToolCallId || !TERMINAL_STATUSES.has(state.status)) return;
    if (this.deliveredRunIds.has(runId)) return;
    this.deliveredRunIds.add(runId);
    this.preserveNextAgentStart = true;
    this.extensionApi?.sendMessage({
      customType: VALIDATION_RESULT_MESSAGE,
      content: [{ type: "text", text: resultText(state) }],
      display: false,
      details: { runId, originToolCallId: state.originToolCallId, validation: state },
    }, { triggerTurn: true, deliverAs: "followUp" });
  }

  consumePreservedAgentStart(): boolean {
    const preserve = this.preserveNextAgentStart;
    this.preserveNextAgentStart = false;
    return preserve;
  }

  reset(): void {
    this.extensionApi = undefined;
    this.deliveredRunIds.clear();
    this.preserveNextAgentStart = false;
  }

  private register(pi: ExtensionAPI): void {
    this.extensionApi = pi;
    pi.registerTool({
      name: "run_validation",
      label: "Run validation",
      description: "Start the host-owned typecheck, test, and build pipeline in the background. The command list is fixed by pi-ecode and cannot be supplied by the model.",
      promptSnippet: "Start the fixed host validation pipeline without blocking this agent turn",
      promptGuidelines: [
        "Use run_validation only after implementation is complete and you no longer plan to modify source files during this run.",
        "The host runs configured typecheck, test, and build scripts sequentially; never pass or invent shell commands.",
        "After starting validation, continue only read-only work or end the turn. Do not poll; one completion result is delivered automatically.",
        "Do not start another validation while one is running. Source changes during validation make the result stale.",
      ],
      executionMode: "sequential",
      parameters: Type.Object({}),
      execute: async (toolCallId, _params, signal) => {
        signal?.throwIfAborted();
        const state = this.options.getState();
        if (!state.supported) throw new Error("This project has no configured typecheck, test, or build scripts.");
        if (state.status === "running") throw new Error("Validation is already running.");
        this.options.start(toolCallId);
        return {
          content: [{ type: "text", text: "Validation started in the background. Continue only read-only work or end the turn; the final result will be delivered automatically." }],
          details: { kind: "pi-ecode.validation-start", version: 1, originToolCallId: toolCallId },
        };
      },
    });
  }
}
