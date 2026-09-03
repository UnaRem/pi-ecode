import { Check, Circle, LoaderCircle } from "lucide-react";
import { useEffect, useRef } from "react";
import type { TaskPlan } from "@shared/contracts";
import { useI18n } from "../i18n/i18n";

export function TaskPlanPanel({ plan }: { plan: TaskPlan }) {
  const { t } = useI18n();
  const currentItemRef = useRef<HTMLLIElement>(null);
  const completedCount = plan.items.filter((item) => item.status === "completed").length;
  const activeIndex = plan.items.findIndex((item) => item.status === "in_progress");
  const nextIndex = plan.items.findIndex((item) => item.status === "pending");
  const currentIndex = activeIndex >= 0 ? activeIndex : nextIndex;

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
        className="sidebar-task-progress"
        role="progressbar"
        aria-label={t("task.complete", { done: completedCount, total: plan.items.length })}
        aria-valuemin={0}
        aria-valuemax={plan.items.length}
        aria-valuenow={completedCount}
      >
        {plan.items.map((item) => (
          <span key={item.id} className={`sidebar-task-segment ${item.status}`} aria-hidden="true" />
        ))}
      </div>
    </section>
  );
}
