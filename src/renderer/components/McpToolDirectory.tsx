import type { McpToolSummary } from "../../shared/mcp-contracts.js";
import { useI18n } from "../i18n/i18n";

export function McpToolDirectory({ tools }: { tools: McpToolSummary[] }) {
  const { t } = useI18n();
  const servers = [...new Set(tools.map((tool) => tool.server))].sort();
  return <section className="inspector-section inspector-mcp">
    <header><strong>{t("mcp.directoryTitle")}</strong><span>{tools.length}</span></header>
    {tools.length === 0 ? <p>{t("mcp.emptyDirectory")}</p> : servers.map((server) => {
      const offered = tools.filter((tool) => tool.server === server);
      return <details key={server} className="inspector-mcp-server">
        <summary><strong>{server}</strong><span>{offered.length}</span></summary>
        <ul>{offered.map((tool) => <li key={tool.name}>
          <code>{tool.name}</code>
          <span className="inspector-mcp-exposure">{t(`mcp.${tool.exposure === "model-only" ? "direct" : tool.exposure}`)}</span>
          <p>{tool.description}</p>
        </li>)}</ul>
      </details>;
    })}
  </section>;
}
