import { Check, Circle, LoaderCircle } from "lucide-react";
import { useEffect, useRef, useState, type AnimationEvent } from "react";
import type { TaskPlan } from "@shared/contracts";
import { useI18n } from "../i18n/i18n";

export function TaskPlanPresence({ plan, active }: { plan: TaskPlan | null; active: boolean }) {
  const { t } = useI18n();
  const [visiblePlan, setVisiblePlan] = useState(plan);
  const [isLeaving, setIsLeaving] = useState(false);

  useEffect(() => {
    if (plan) {
      setVisiblePlan(plan);
      setIsLeaving(false);
    } else {
      setIsLeaving(true);
    }
  }, [plan]);

  const finishLeaving = (event: AnimationEvent<HTMLElement>): void => {
    if (!isLeaving || event.animationName !== "task-plan-leave") return;
    setVisiblePlan(null);
    setIsLeaving(false);
  };
  if (!visiblePlan) return null;

  return (
    <section className={isLeaving ? "sidebar-task-section leaving" : "sidebar-task-section"} onAnimationEnd={finishLeaving}>
      <div className="sidebar-label">{t("task.section")}</div>
      <TaskPlanPanel plan={visiblePlan} active={active} />
    </section>
  );
}

export function TaskPlanPanel({ plan, active }: { plan: TaskPlan; active: boolean }) {
  const { t } = useI18n();
  const currentItemRef = useRef<HTMLLIElement>(null);
  const completedCount = plan.items.filter((item) => item.status === "completed").length;
  const activeIndex = plan.items.findIndex((item) => item.status === "in_progress");
  const nextIndex = plan.items.findIndex((item) => item.status === "pending");
  const currentIndex = activeIndex >= 0 ? activeIndex : nextIndex;
  const flowTargetIndex = currentIndex >= 0 ? currentIndex : plan.items.length - 1;
  const flowWidth = plan.items.length > 0 ? `${(((flowTargetIndex + 1) / plan.items.length) * 100).toFixed(2)}%` : "0%";

  useEffect(() => {
    currentItemRef.current?.scrollIntoView({ block: "nearest" });
  }, [plan.updatedAt, currentIndex]);

  return (
    <section className="sidebar-task-plan" aria-label={t("task.plan", { title: plan.title })}>
      <ol className="sidebar-task-items">
        {plan.items.map((item, index) => {
          const isCurrent = index === currentIndex;
          return (
            <li
              key={item.id}
              ref={isCurrent ? currentItemRef : undefined}
              className={`${item.status} ${isCurrent ? "current" : ""}`}
            >
              <span className="sidebar-task-icon" aria-hidden="true">
                {item.status === "completed"
                  ? <Check size={13} />
                  : item.status === "in_progress"
                    ? <LoaderCircle className="spin" size={14} />
                    : <Circle size={13} />}
              </span>
              <span>{item.text}</span>
            </li>
          );
        })}
      </ol>
      <div
        className={`sidebar-task-progress ${active ? "active" : "idle"}`}
        role="progressbar"
        aria-label={t("task.complete", { done: completedCount, total: plan.items.length })}
        aria-valuemin={0}
        aria-valuemax={plan.items.length}
        aria-valuenow={completedCount}
      >
        {plan.items.map((item, index) => (
          <span
            key={item.id}
            className={`sidebar-task-segment ${item.status} ${index === flowTargetIndex ? "current" : ""}`}
            aria-hidden="true"
          />
        ))}
        {active && flowTargetIndex >= 0 && <span className="sidebar-task-flow" style={{ width: flowWidth }} aria-hidden="true" />}
      </div>
    </section>
  );
}
