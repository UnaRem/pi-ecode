import { ChevronRight } from "lucide-react";
import type { ToolStatistic } from "../../shared/tool-statistics";
import { useI18n } from "../i18n/i18n";

export function ToolStatisticsPanel({ statistics }: { statistics: ToolStatistic[] }) {
  const { t } = useI18n();
  return <section className="inspector-section inspector-statistics">
    <header><strong>{t("statistics.title")}</strong><span>{statistics.length}</span></header>
    <p className="tool-statistics-note">{t("statistics.note")}</p>
    {statistics.length === 0 ? <p className="tool-statistics-note">{t("statistics.empty")}</p> : statistics.map((entry) => {
      const completed = entry.successes + entry.failures;
      const percent = (count: number) => completed ? `${(count / completed * 100).toFixed(0)}%` : "—";
      const duration = (ms: number | null) => ms === null ? "—" : `${Math.round(ms)} ms`;
      return <details className="inspector-mcp-server" key={`${entry.name}:${entry.nested}`}>
        <summary><ChevronRight size={14} aria-hidden="true" /><strong title={entry.name}>{entry.name}</strong><span>{completed}</span></summary>
        <div className="tool-statistics-detail">
          <p>{t(`statistics.capability.${entry.capability}`)}{entry.nested ? ` · ${t("statistics.nested")}` : ""}</p>
          <dl>
            <div><dt>{t("statistics.success")}</dt><dd>{percent(entry.successes)} ({entry.successes})</dd></div>
            <div><dt>{t("statistics.failure")}</dt><dd>{percent(entry.failures)} ({entry.failures})</dd></div>
            <div><dt>{t("statistics.median")}</dt><dd>{duration(entry.medianMs)}</dd></div>
            <div><dt>P95</dt><dd>{duration(entry.p95Ms)}</dd></div>
            <div><dt>{t("statistics.cancelled")}</dt><dd>{entry.cancelled}</dd></div>
            <div><dt>{t("statistics.blocked")}</dt><dd>{entry.blocked}</dd></div>
          </dl>
          <p>{t(`statistics.adjustment.${entry.adjustment}`)}</p>
        </div>
      </details>;
    })}
  </section>;
}
