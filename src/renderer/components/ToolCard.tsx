import { Check, ChevronRight, CircleAlert, LoaderCircle } from "lucide-react";
import { useState } from "react";
import type { ToolActivity } from "@shared/contracts";
import { toolCategory, toolCategoryLabel } from "../lib/tool-category";

function previewLines(output: string): string {
  const lines = output.split("\n");
  const preview = lines.slice(0, 3).join("\n");
  return lines.length > 3 ? `${preview}\n…` : preview;
}

export function ToolCard({ tool }: { tool: ToolActivity }) {
  const [expanded, setExpanded] = useState(false);
  const category = toolCategory(tool.name, tool.input);
  const statusIcon = tool.status === "running"
    ? <LoaderCircle className="spin" size={14} />
    : tool.status === "error"
      ? <CircleAlert size={14} />
      : <Check size={14} />;

  return (
    <section
      className={`tool-card category-${category} ${tool.status} ${expanded ? "expanded" : ""}`}
      data-tool-label={toolCategoryLabel(category)}
    >
      <button className="tool-summary" onClick={() => setExpanded((value) => !value)} aria-expanded={expanded}>
        <ChevronRight className="tool-chevron" size={14} />
        <span className="tool-status">{statusIcon}</span>
        <span className="tool-title">{tool.title}</span>
        <small>{tool.status === "running" ? "Running" : tool.status === "error" ? "Failed" : "Done"}</small>
      </button>
      {!expanded && tool.output && <pre className="tool-preview">{previewLines(tool.output)}</pre>}
      {expanded && (
        <div className="tool-detail">
          {tool.input && <pre>{tool.input}</pre>}
          {tool.output && <pre className="tool-output">{tool.output}</pre>}
        </div>
      )}
    </section>
  );
}
