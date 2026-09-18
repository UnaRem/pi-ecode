import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CandidateState, ChangeReview, ValidationState } from "@shared/contracts";
import { I18nProvider } from "../i18n/i18n";
import { WorkspaceInspector } from "./WorkspaceInspector";

const validation: ValidationState = { supported: true, isSelfProject: false, status: "idle", runId: null, activeStep: null, steps: [], verifiedAt: null, message: null };
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

describe("WorkspaceInspector", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("combines current-turn tools, output, validation and changed files", () => {
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
    expect(markup).toContain("Run checks");
  });
});
