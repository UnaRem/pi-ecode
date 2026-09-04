import { Check, ChevronRight, CircleAlert, LoaderCircle } from "lucide-react";
import { useState } from "react";
import type { ToolActivity } from "@shared/contracts";
import { toolCategory, type ToolCategory } from "../lib/tool-category";
import { useI18n } from "../i18n/i18n";
import type { MessageKey } from "../i18n/messages";

const CATEGORY_KEYS: Record<ToolCategory, MessageKey> = {
  inspect: "tool.inspect",
  mutate: "tool.change",
  execute: "tool.run",
  research: "tool.research",
  version: "tool.version",
  plan: "tool.plan",
  other: "tool.generic",
};

function previewLines(output: string): string {
  const lines = output.split("\n");
  const preview = lines.slice(0, 3).join("\n");
  return lines.length > 3 ? `${preview}\n…` : preview;
}

export function ToolCard({ tool }: { tool: ToolActivity }) {
  const { t } = useI18n();
  const [expanded, setExpanded] = useState(false);
  const category = toolCategory(tool.name, tool.input);
  const statusIcon = tool.status === "running"
    ? <LoaderCircle className="spin" size={14} aria-hidden="true" />
    : tool.status === "error"
      ? <CircleAlert size={14} aria-hidden="true" />
      : <Check size={14} aria-hidden="true" />;

  return (
    <section
      className={`tool-card category-${category} ${tool.status} ${expanded ? "expanded" : ""}`}
      data-tool-label={t(CATEGORY_KEYS[category])}
    >
      <button className="tool-summary" onClick={() => setExpanded((value) => !value)} aria-expanded={expanded}>
        <ChevronRight className="tool-chevron" size={14} />
        <span className="tool-status">{statusIcon}</span>
        <span className="tool-title">{tool.title}</span>
        <span className="sr-only">{tool.status === "running" ? t("tool.running") : tool.status === "error" ? t("tool.failed") : t("tool.done")}</span>
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
