import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CandidateState, ChangeReview, ValidationState } from "@shared/contracts";
import { I18nProvider } from "../i18n/i18n";
import { ValidationPanelPresence } from "./ValidationPanel";

const validation: ValidationState = {
  supported: true,
  isSelfProject: false,
  status: "idle",
  runId: null,
  activeStep: null,
  steps: [],
  verifiedAt: null,
  message: null,
};
const review: ChangeReview = {
  available: false,
  baseCommit: null,
  headCommit: null,
  files: [],
  patch: "",
  truncated: false,
  message: null,
};
const candidate: CandidateState = {
  status: "idle",
  candidateId: null,
  candidatePath: null,
  preparedAt: null,
  message: null,
  history: [],
};
const handlers = {
  onRun: vi.fn(),
  onStop: vi.fn(),
  onRejectFile: vi.fn(),
  onPrepareCandidate: vi.fn(),
  onActivateCandidate: vi.fn(),
  onClose: vi.fn(),
};

describe("ValidationPanelPresence", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("renders the animated shell when initially open", () => {
    vi.stubGlobal("localStorage", { getItem: () => "en", setItem: vi.fn() });
    const markup = renderToStaticMarkup(
      <I18nProvider>
        <ValidationPanelPresence open validation={validation} review={review} candidate={candidate} {...handlers} />
      </I18nProvider>,
    );
    expect(markup).toContain('class="validation-panel-shell"');
    expect(markup).toContain('class="validation-panel"');
  });

  it("does not mount the panel when initially closed", () => {
    vi.stubGlobal("localStorage", { getItem: () => "en", setItem: vi.fn() });
    const markup = renderToStaticMarkup(
      <I18nProvider>
        <ValidationPanelPresence open={false} validation={validation} review={review} candidate={candidate} {...handlers} />
      </I18nProvider>,
    );
    expect(markup).toBe("");
  });
});
