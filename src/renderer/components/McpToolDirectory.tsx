import { ChevronRight } from "lucide-react";
import type { McpToolSummary } from "../../shared/mcp-contracts.js";
import { useI18n } from "../i18n/i18n";

export function McpToolDirectory({ tools }: { tools: McpToolSummary[] }) {
  const { t } = useI18n();
  const groups = new Map<string, McpToolSummary[]>();
  for (const tool of tools) {
    const offered = groups.get(tool.server) ?? [];
    offered.push(tool);
    groups.set(tool.server, offered);
  }
  const servers = [...groups.keys()].sort();
  return <section className="inspector-section inspector-mcp">
    <details className="inspector-mcp-directory inspector-mcp-server">
    <summary><ChevronRight size={14} aria-hidden="true" /><strong>{t("mcp.directoryTitle")}</strong><span>{tools.length}</span></summary>
    {tools.length === 0 ? <p>{t("mcp.emptyDirectory")}</p> : servers.map((server) => {
      const offered = groups.get(server)!;
      return <details key={server} className="inspector-mcp-server">
        <summary><ChevronRight size={14} aria-hidden="true" /><strong title={server}>{server}</strong><span>{offered.length}</span></summary>
        <ul>{offered.map((tool) => <li key={tool.name}>
          <code>{tool.name}</code>
          <span className="inspector-mcp-exposure">{t(`mcp.${tool.exposure === "model-only" ? "direct" : tool.exposure}`)}</span>
          <p>{tool.description}</p>
        </li>)}</ul>
      </details>;
    })}
    </details>
  </section>;
}
