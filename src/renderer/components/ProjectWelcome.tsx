import { Sparkles } from "lucide-react";
import type { ProjectProfile } from "@shared/contracts";
import { useI18n } from "../i18n/i18n";

export function ProjectWelcome({ projectName, profile, disabled, onChoose }: {
  projectName: string;
  profile?: ProjectProfile | undefined;
  disabled: boolean;
  onChoose?: ((prompt: string) => void) | undefined;
}) {
  const { t } = useI18n();
  const recommendations = profile?.recommendations;
  const status = recommendations?.status ?? "empty";
  const technologies = profile?.technologies.join(" · ") ?? "";
  return <section className="welcome project-welcome">
    <div className="welcome-icon"><Sparkles size={21} aria-hidden="true" /></div>
    <h1>{t("conversation.welcomeTitle")}</h1>
    <p>{t("conversation.welcomeBody", { project: projectName })}</p>
    {technologies && <p className="project-welcome-stack">{technologies}</p>}
    <div className="project-recommendations" aria-live="polite" aria-busy={status === "loading"}>
      <p className="project-recommendations-label">{t("suggestion.recentWork")}</p>
      {status === "ready" ? <p>{recommendations?.summary}</p> :
        <p>{t(`suggestion.${status}`)}{status === "error" && recommendations?.error ? ` ${recommendations.error}` : ""}</p>}
    </div>
    {status === "ready" && recommendations && recommendations.suggestions.length > 0 && <div className="project-suggestions">
      {recommendations.suggestions.map((suggestion, index) => <button type="button" key={`${index}:${suggestion.title}`}
        disabled={disabled || !onChoose} onClick={() => onChoose?.(suggestion.prompt)}>
        <strong>{suggestion.title}</strong>
        <span>{suggestion.description}</span>
      </button>)}
    </div>}
  </section>;
}
