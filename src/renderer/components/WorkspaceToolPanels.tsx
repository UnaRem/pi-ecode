import { TerminalSquare } from "lucide-react";
import { useRef } from "react";
import type { ToolActivity, ValidationState } from "@shared/contracts";
import { useScrollFollow } from "../hooks/use-scroll-follow";
import { toolCategory } from "../lib/tool-category";
import { useI18n } from "../i18n/i18n";
import { ValidationStepStatusIcon } from "./ValidationSteps";

function formatToolDuration(tool: ToolActivity): string {
  if (!tool.startedAt) return "";
  const elapsed = Math.max(0, (tool.endedAt ?? Date.now()) - tool.startedAt);
  return elapsed < 1000 ? `${elapsed}ms` : `${(elapsed / 1000).toFixed(1)}s`;
}

export function ToolQueue({ tools, selectedTool, onSelect }: {
  tools: ToolActivity[];
  selectedTool: ToolActivity | null;
  onSelect: (id: string) => void;
}) {
  const { t } = useI18n();
  const containerRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const followingRef = useRef(true);
  const onWheel = useScrollFollow(containerRef, contentRef, followingRef);
  return <section className="inspector-section inspector-tools">
    <header><strong>{t("tool.panelTitle")}</strong><span>{tools.length}</span></header>
    <div ref={containerRef} className="inspector-tool-list" data-scroll-follow onWheel={onWheel}>
      <div ref={contentRef}>
        {tools.length === 0 ? <p>{t("tool.waitingOutput")}</p> : tools.map((tool) => <button
          key={tool.id} className={tool.id === selectedTool?.id ? "selected" : ""}
          onClick={() => onSelect(tool.id)} aria-pressed={tool.id === selectedTool?.id}
        >
          <span className={`inspector-tool-status ${tool.status}`}><ValidationStepStatusIcon step={{ id: "build", label: tool.title, command: tool.name, status: tool.status === "success" ? "passed" : tool.status === "error" ? "failed" : "running", output: tool.output, exitCode: null, durationMs: null }} /></span>
          <strong>{tool.title}</strong><time>{formatToolDuration(tool)}</time>
        </button>)}
      </div>
    </div>
  </section>;
}

function FollowingOutput({ output }: { output: string }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLPreElement>(null);
  const followingRef = useRef(true);
  const onWheel = useScrollFollow(containerRef, contentRef, followingRef);
  return <div ref={containerRef} className="inspector-output-scroll" data-scroll-follow onWheel={onWheel} tabIndex={0}>
    <pre ref={contentRef}>{output}</pre>
  </div>;
}

export function OutputPanel({ tools, selectedTool, validation }: {
  tools: ToolActivity[];
  selectedTool: ToolActivity | null;
  validation: ValidationState;
}) {
  const { t } = useI18n();
  const runningStep = validation.status === "running" ? validation.steps.find((step) => step.status === "running" && step.output) : undefined;
  const tool = selectedTool ?? [...tools].reverse().find((entry) => toolCategory(entry.name, entry.input) === "execute");
  const output = runningStep?.output ?? tool?.output ?? "";
  // A different source starts at its latest output; updates to that source preserve reading position.
  const sourceKey = runningStep ? `${validation.runId}:${runningStep.id}` : tool?.id ?? "empty";
  return <section className="inspector-section inspector-output">
    <header><strong><TerminalSquare size={14} aria-hidden="true" />{t("tool.output")}</strong></header>
    <FollowingOutput key={sourceKey} output={output || t("tool.noOutput")} />
  </section>;
}
