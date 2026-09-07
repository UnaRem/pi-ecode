import { useEffect, useRef, useState, type AnimationEvent, type CSSProperties } from "react";
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
  const flowSegmentCount = flowTargetIndex + 1;
  const flowCycleMs = Math.max(1_900, flowSegmentCount * 360 + 700);
  const flowStepMs = flowSegmentCount > 0 ? (flowCycleMs * 0.72) / flowSegmentCount : 0;
  const flowStyle = {
    "--task-flow-cycle": `${flowCycleMs}ms`,
  } as CSSProperties;

  useEffect(() => {
    currentItemRef.current?.scrollIntoView({ block: "nearest" });
  }, [plan.updatedAt, currentIndex]);

  return (
    <section className="sidebar-task-plan" aria-label={t("task.plan", { title: plan.title })}>
      <div
        className={`sidebar-task-timeline ${active ? "active" : "idle"}`}
        style={flowStyle}
        role="progressbar"
        aria-label={t("task.complete", { done: completedCount, total: plan.items.length })}
        aria-valuemin={0}
        aria-valuemax={plan.items.length}
        aria-valuenow={completedCount}
      >
        <ol className="sidebar-task-items">
          {plan.items.map((item, index) => {
            const isCurrent = index === currentIndex;
            const isFlowPath = active && index <= flowTargetIndex;
            const markerStyle = isFlowPath
              ? { "--task-flow-delay": `${Math.round(index * flowStepMs)}ms` } as CSSProperties
              : undefined;
            return (
              <li
                key={item.id}
                ref={isCurrent ? currentItemRef : undefined}
                className={`${item.status} ${isCurrent ? "current" : ""}`}
              >
                <span
                  className={[
                    "sidebar-task-marker",
                    item.status,
                    isCurrent ? "current" : null,
                    isFlowPath ? "flow-path" : null,
                  ].filter(Boolean).join(" ")}
                  style={markerStyle}
                  aria-hidden="true"
                >
                  <span className="sidebar-task-node" />
                  {index < plan.items.length - 1 && <span className="sidebar-task-rail" />}
                </span>
                <span>{item.text}</span>
              </li>
            );
          })}
        </ol>
      </div>
    </section>
  );
}
