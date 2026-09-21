import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProjectAgentCatalog } from "@shared/agent-contracts";
import type { CandidateState, ChangeReview, ValidationState } from "@shared/contracts";
import { I18nProvider } from "../i18n/i18n";
import { ValidationLogs, WorkspaceInspector } from "./WorkspaceInspector";

const validation: ValidationState = { supported: true, isSelfProject: false, status: "idle", runId: null, activeStep: null, steps: [], sourceRevision: null, originToolCallId: null, startedAt: null, verifiedAt: null, message: null };
const review: ChangeReview = {
  available: true,
  baseCommit: null,
  headCommit: null,
  files: [{ path: "src/App.tsx", status: "modified", additions: 3, deletions: 1 }],
  patch: "diff --git a/src/App.tsx b/src/App.tsx",
  truncated: false,
  message: null,
};
const candidate: CandidateState = { status: "idle", candidateId: null, candidatePath: null, preparedAt: null, message: null, history: [] };
const agentCatalog: ProjectAgentCatalog = {
  version: 1,
  projectPath: "C:/workspace",
  maxConcurrent: 3,
  updatedAt: 1,
  agents: [{
    id: "explorer-1",
    name: "探索者 1",
    role: "explorer",
    builtIn: true,
    enabled: true,
    model: { mode: "inherit" },
    thinkingLevel: "high",
    autoCompaction: { enabled: true, thresholdPercent: null },
    prompt: "只读",
    disabledTools: [],
    createdAt: 1,
    updatedAt: 1,
  }],
};

describe("WorkspaceInspector", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("offers validation for any project with configured scripts", () => {
    vi.stubGlobal("localStorage", { getItem: () => "en", setItem: vi.fn() });
    const tool = { id: "bash-1", name: "bash", title: "npm test", input: "npm test", output: "203 passed", status: "success" as const };
    const markup = renderToStaticMarkup(
      <I18nProvider>
        <WorkspaceInspector
          tools={[tool]}
          selectedTool={tool}
          validation={validation}
          review={review}
          candidate={candidate}
          projectPath="C:/workspace"
          isStreaming={false}
          agentCatalog={agentCatalog}
          onSelectTool={vi.fn()}
          onRunValidation={vi.fn()}
          onStopValidation={vi.fn()}
          onRejectFile={vi.fn()}
          onPrepareCandidate={vi.fn()}
          onActivateCandidate={vi.fn()}
        />
      </I18nProvider>,
    );
    expect(markup).toContain("npm test");
    expect(markup).toContain("203 passed");
    expect(markup).toContain("src/App.tsx");
    expect(markup).toContain('class="inspector-patch-reveal" aria-hidden="true" inert=""');
    expect(markup).toContain('class="inspector-tab-panel entering"');
    expect(markup).toContain('id="inspector-tab-validation"');
    expect(markup).toContain('aria-selected="false" aria-controls="inspector-panel-validation"');
    expect(markup).not.toContain("PiECode project verification");
    expect(markup).toContain('id="inspector-tab-agents"');
    expect(markup).toContain('class="inspector-tab-with-badge" data-count="1"');
    expect(markup).toContain('aria-label="Agents: 1"');
    expect(markup).not.toContain("Agents<span>");
  });

  it("shows output from the selected non-command tool", () => {
    vi.stubGlobal("localStorage", { getItem: () => "en", setItem: vi.fn() });
    const command = { id: "bash-1", name: "bash", title: "npm test", input: "npm test", output: "command output", status: "success" as const };
    const read = { id: "read-1", name: "read", title: "Read file", input: "src/App.tsx", output: "selected read output", status: "success" as const };
    const markup = renderToStaticMarkup(
      <I18nProvider>
        <WorkspaceInspector
          tools={[command, read]}
          selectedTool={read}
          validation={validation}
          review={review}
          candidate={candidate}
          projectPath="C:/workspace"
          isStreaming={false}
          onSelectTool={vi.fn()}
          onRunValidation={vi.fn()}
          onStopValidation={vi.fn()}
          onRejectFile={vi.fn()}
          onPrepareCandidate={vi.fn()}
          onActivateCandidate={vi.fn()}
        />
      </I18nProvider>,
    );
    expect(markup).toContain("selected read output");
    expect(markup).not.toContain("command output</pre>");
  });

  it("keeps completed validation logs available by step", () => {
    vi.stubGlobal("localStorage", { getItem: () => "en", setItem: vi.fn() });
    const markup = renderToStaticMarkup(
      <I18nProvider>
        <ValidationLogs validation={{
          ...validation,
          status: "failed",
          steps: [{ id: "test", label: "Tests", command: "npm run test", status: "failed", output: "assertion failed", exitCode: 1, durationMs: 20 }],
        }} />
      </I18nProvider>,
    );
    expect(markup).toContain("Validation logs");
    expect(markup).toContain("assertion failed");
    expect(markup).toContain("open=\"\"");
  });

  it("keeps the PiECode candidate pipeline limited to the source project", () => {
    vi.stubGlobal("localStorage", { getItem: () => "en", setItem: vi.fn() });
    const markup = renderToStaticMarkup(
      <I18nProvider>
        <WorkspaceInspector
          tools={[]}
          selectedTool={null}
          validation={{ ...validation, isSelfProject: true }}
          review={review}
          candidate={candidate}
          projectPath="C:/Files/Projects/pi-ecode"
          isStreaming={false}
          onSelectTool={vi.fn()}
          onRunValidation={vi.fn()}
          onStopValidation={vi.fn()}
          onRejectFile={vi.fn()}
          onPrepareCandidate={vi.fn()}
          onActivateCandidate={vi.fn()}
        />
      </I18nProvider>,
    );
    expect(markup).toContain('id="inspector-tab-validation"');
    expect(markup).toContain('aria-selected="false" aria-controls="inspector-panel-validation"');
  });
});
