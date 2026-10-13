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
  const suggestions = [
    { category: "optimize", direction: profile?.features.includes("sessions") ? "sessions" : profile?.hasTests ? "tests" : "structure" },
    { category: "add", direction: profile?.features.includes("mcp") ? "mcp" : profile?.technologies.includes("electron") ? "desktop" : "workflow" },
    { category: "explore", direction: profile?.features.includes("history") ? "history" : "opportunities" },
  ] as const;
  const technologies = profile?.technologies.join(" · ") ?? "";
  return <section className="welcome project-welcome">
    <div className="welcome-icon"><Sparkles size={21} aria-hidden="true" /></div>
    <h1>{t("conversation.welcomeTitle")}</h1>
    <p>{t("conversation.welcomeBody", { project: projectName })}</p>
    {technologies && <p className="project-welcome-stack">{technologies}</p>}
    <div className="project-suggestions">
      {suggestions.map(({ category, direction }) => <button type="button" key={category} disabled={disabled || !onChoose}
        onClick={() => onChoose?.(t("suggestion.prompt", {
          project: projectName, task: t(`suggestion.${direction}.body`),
          context: [profile?.description, technologies].filter(Boolean).join(" · "),
        }))}>
        <small>{t(`suggestion.${category}`)}</small>
        <strong>{t(`suggestion.${direction}.title`)}</strong>
        <span>{t(`suggestion.${direction}.body`)}</span>
      </button>)}
    </div>
  </section>;
}
