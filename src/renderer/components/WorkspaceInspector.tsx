import { Check, CircleAlert, CircleDashed, FileCode2, LoaderCircle, Play, Square, TerminalSquare } from "lucide-react";
import { useState, type AnimationEvent } from "react";
import type { CandidateState, ChangeReview, ToolActivity, ValidationState, ValidationStep } from "@shared/contracts";
import { toolCategory } from "../lib/tool-category";
import { useI18n } from "../i18n/i18n";
import { GitPushButton } from "./GitPushButton";

interface WorkspaceInspectorProps {
  tools: ToolActivity[];
  selectedTool: ToolActivity | null;
  validation: ValidationState;
  review: ChangeReview;
  candidate: CandidateState;
  projectPath: string;
  isStreaming: boolean;
  onSelectTool: (toolId: string) => void;
  onRunValidation: () => void;
  onStopValidation: () => void;
  onRejectFile: (path: string) => void;
  onPrepareCandidate: () => void;
  onActivateCandidate: () => void;
}

function StepStatus({ step }: { step: ValidationStep }) {
  if (step.status === "running") return <LoaderCircle className="spin" size={13} aria-hidden="true" />;
  if (step.status === "passed") return <Check size={13} aria-hidden="true" />;
  if (step.status === "failed") return <CircleAlert size={13} aria-hidden="true" />;
  return <CircleDashed size={13} aria-hidden="true" />;
}

function formatToolDuration(tool: ToolActivity): string {
  if (!tool.startedAt) return "";
  const elapsed = Math.max(0, (tool.endedAt ?? Date.now()) - tool.startedAt);
  return elapsed < 1000 ? `${elapsed}ms` : `${(elapsed / 1000).toFixed(1)}s`;
}

function ToolQueue({ tools, selectedTool, onSelect }: Pick<WorkspaceInspectorProps, "tools" | "selectedTool" | "onSelectTool"> & { onSelect: (id: string) => void }) {
  const { t } = useI18n();
  return (
    <section className="inspector-section inspector-tools">
      <header><strong>{t("tool.panelTitle")}</strong><span>{tools.length}</span></header>
      <div className="inspector-tool-list">
        {tools.length === 0 ? <p>{t("tool.waitingOutput")}</p> : tools.map((tool) => (
          <button key={tool.id} className={tool.id === selectedTool?.id ? "selected" : ""} onClick={() => onSelect(tool.id)} aria-pressed={tool.id === selectedTool?.id}>
            <span className={`inspector-tool-status ${tool.status}`}><StepStatus step={{ id: "build", label: tool.title, command: tool.name, status: tool.status === "success" ? "passed" : tool.status === "error" ? "failed" : "running", output: tool.output, exitCode: null, durationMs: null }} /></span>
            <strong>{tool.title}</strong>
            <time>{formatToolDuration(tool)}</time>
          </button>
        ))}
      </div>
    </section>
  );
}

function terminalOutput(props: Pick<WorkspaceInspectorProps, "tools" | "selectedTool" | "validation">): string {
  const validationOutput = props.validation.steps.find((step) => step.status === "running")?.output;
  if (props.validation.status === "running" && validationOutput) return validationOutput;
  if (props.selectedTool) return props.selectedTool.output;
  const latestExecution = [...props.tools].reverse().find((tool) => toolCategory(tool.name, tool.input) === "execute");
  return latestExecution?.output || "";
}

function OutputPanel(props: Pick<WorkspaceInspectorProps, "tools" | "selectedTool" | "validation">) {
  const { t } = useI18n();
  const output = terminalOutput(props);
  return (
    <section className="inspector-section inspector-output">
      <header><strong><TerminalSquare size={14} aria-hidden="true" />{t("tool.output")}</strong></header>
      <pre>{output || t("tool.noOutput")}</pre>
    </section>
  );
}

function ValidationControls(props: Pick<WorkspaceInspectorProps, "validation" | "candidate" | "projectPath" | "isStreaming" | "onRunValidation" | "onStopValidation" | "onPrepareCandidate" | "onActivateCandidate">) {
  const { t } = useI18n();
  const running = props.validation.status === "running";
  return (
    <section className="inspector-section inspector-validation" tabIndex={-1}>
      <header>
        <strong>{t("validation.piECodeTitle")}</strong>
        {running ? (
          <button onClick={props.onStopValidation}><Square size={10} fill="currentColor" />{t("validation.stop")}</button>
        ) : (
          <button onClick={props.onRunValidation} disabled={!props.validation.supported}><Play size={11} fill="currentColor" />{t("validation.run")}</button>
        )}
      </header>
      <GitPushButton projectKey={props.projectPath} disabled={props.isStreaming} validationStatus={props.validation.status} />
      <div className="inspector-validation-steps">
        {props.validation.steps.map((step) => (
          <div key={step.id} className={step.status}><StepStatus step={step} /><span>{step.label}</span></div>
        ))}
      </div>
      {props.validation.message && <p className={`inspector-validation-message ${props.validation.status}`}>{props.validation.message}</p>}
      {props.validation.isSelfProject && (
        <button
          className="inspector-candidate-action"
          onClick={props.candidate.status === "ready" ? props.onActivateCandidate : props.onPrepareCandidate}
          disabled={props.candidate.status !== "ready" && (props.validation.status !== "passed" || props.candidate.status === "preparing")}
        >
          {props.candidate.status === "ready" ? t("validation.restart") : t(props.candidate.status === "preparing" ? "validation.preparing" : "validation.prepare")}
        </button>
      )}
      {props.candidate.message && <p className={`inspector-validation-message ${props.candidate.status}`}>{props.candidate.message}</p>}
      {props.candidate.history.length > 0 && (
        <div className="inspector-version-list">
          {props.candidate.history.slice(0, 3).map((record) => <code key={record.id}>{record.id}</code>)}
        </div>
      )}
    </section>
  );
}

function PatchDisclosure({ patch }: { patch: string }) {
  const { t } = useI18n();
  const [expanded, setExpanded] = useState(false);
  if (!patch) return null;
  return (
    <div className={`inspector-patch ${expanded ? "open" : ""}`}>
      <button type="button" aria-expanded={expanded} onClick={() => setExpanded((current) => !current)}>{t("validation.viewPatch")}</button>
      <div className="inspector-patch-reveal" aria-hidden={!expanded} inert={!expanded ? true : undefined}>
        <pre>{patch}</pre>
      </div>
    </div>
  );
}

function ChangeFiles(props: Pick<WorkspaceInspectorProps, "review" | "onRejectFile">) {
  const { t } = useI18n();
  const files = [...props.review.files].sort((left, right) => (right.additions ?? -1) + (right.deletions ?? -1) - ((left.additions ?? -1) + (left.deletions ?? -1)));
  return (
    <section className="inspector-section inspector-changes">
      <header><strong>{t("validation.review")}</strong><span>{props.review.files.length}</span></header>
      <div className="inspector-file-list">
        {files.length === 0 ? <p>{props.review.message ?? t("validation.noChanges")}</p> : files.map((file) => (
          <div key={file.path} className="inspector-file">
            <FileCode2 size={13} aria-hidden="true" />
            <code title={file.path}>{file.path}</code>
            <span>{file.status.slice(0, 1).toUpperCase()}</span>
            <button
              onClick={() => {
                if (window.confirm(t("validation.restoreFile", { path: file.path }))) props.onRejectFile(file.path);
              }}
              title={t("validation.rejectTitle")}
            >{t("validation.reject")}</button>
          </div>
        ))}
      </div>
      <PatchDisclosure patch={props.review.patch} />
    </section>
  );
}

type InspectorTab = "tools" | "validation";

export function WorkspaceInspector(props: WorkspaceInspectorProps) {
  const { t } = useI18n();
  const [tab, setTab] = useState<InspectorTab>("tools");
  const [leavingTab, setLeavingTab] = useState<InspectorTab | null>(null);
  const activeTab = props.validation.isSelfProject ? tab : "tools";
  const selectTab = (nextTab: InspectorTab): void => {
    if (nextTab === activeTab) return;
    setLeavingTab(activeTab);
    setTab(nextTab);
  };
  const renderTab = (target: InspectorTab) => target === "tools" ? <>
    <ToolQueue {...props} onSelect={props.onSelectTool} />
    <OutputPanel {...props} />
    <ChangeFiles {...props} />
  </> : <ValidationControls {...props} />;
  const finishLeaving = (event: AnimationEvent<HTMLDivElement>): void => {
    if (event.animationName === "inspector-tab-leave") setLeavingTab(null);
  };
  return (
    <aside className="workspace-inspector" data-region="inspector" aria-label={t("tool.panelTitle")}>
      <div className="inspector-tabs" role="tablist" aria-label={t("tool.panelTitle")}>
        <button type="button" role="tab" aria-selected={activeTab === "tools"} onClick={() => selectTab("tools")}>{t("tool.panelTitle")}</button>
        {props.validation.isSelfProject && <button type="button" role="tab" aria-selected={activeTab === "validation"} onClick={() => selectTab("validation")}>{t("validation.tab")}</button>}
      </div>
      <div className="inspector-scroll">
        <div className="inspector-tab-stack">
          {leavingTab && leavingTab !== activeTab && (
            <div className="inspector-tab-panel leaving" inert onAnimationEnd={finishLeaving}>{renderTab(leavingTab)}</div>
          )}
          <div key={activeTab} className="inspector-tab-panel entering">{renderTab(activeTab)}</div>
        </div>
      </div>
    </aside>
  );
}
