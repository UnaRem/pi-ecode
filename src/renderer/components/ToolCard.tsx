import { Check, CircleAlert, LoaderCircle, PanelRightOpen } from "lucide-react";
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

export function ToolCard({ tool, selected, onSelect }: { tool: ToolActivity; selected: boolean; onSelect: () => void }) {
  const { t } = useI18n();
  const category = toolCategory(tool.name, tool.input);
  const statusIcon = tool.status === "running"
    ? <LoaderCircle className="spin" size={14} aria-hidden="true" />
    : tool.status === "error"
      ? <CircleAlert size={14} aria-hidden="true" />
      : <Check size={14} aria-hidden="true" />;

  return (
    <section
      className={`tool-card category-${category} ${tool.status} ${selected ? "selected" : ""}`}
      data-tool-label={t(CATEGORY_KEYS[category])}
    >
      <button className="tool-summary" onClick={onSelect} aria-pressed={selected}>
        <PanelRightOpen className="tool-panel-icon" size={14} aria-hidden="true" />
        <span className="tool-status">{statusIcon}</span>
        <span className="tool-title">{tool.title}</span>
        <span className="sr-only">{tool.status === "running" ? t("tool.running") : tool.status === "error" ? t("tool.failed") : t("tool.done")}</span>
      </button>
      {tool.output && <pre className="tool-preview">{previewLines(tool.output)}</pre>}
    </section>
  );
}
