import { useEffect, useLayoutEffect, useRef, useState, type AnimationEvent } from "react";
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

export function centeredTaskScrollTop(
  itemTop: number,
  itemHeight: number,
  viewportHeight: number,
  scrollHeight: number,
): number {
  const centered = itemTop + itemHeight / 2 - viewportHeight / 2;
  return Math.max(0, Math.min(centered, scrollHeight - viewportHeight));
}

export function TaskPlanPanel({ plan, active }: { plan: TaskPlan; active: boolean }) {
  const { t } = useI18n();
  const taskListRef = useRef<HTMLOListElement>(null);
  const currentItemRef = useRef<HTMLLIElement>(null);
  const completedCount = plan.items.filter((item) => item.status === "completed").length;
  const activeIndex = plan.items.findIndex((item) => item.status === "in_progress");
  const nextIndex = plan.items.findIndex((item) => item.status === "pending");
  const currentIndex = activeIndex >= 0 ? activeIndex : nextIndex;
  const previousIndex = currentIndex - 1;
  const dropSourceIndex = active && previousIndex >= 0 && plan.items[previousIndex]?.status === "completed"
    ? previousIndex
    : -1;

  useLayoutEffect(() => {
    const taskList = taskListRef.current;
    const currentItem = currentItemRef.current;
    if (!taskList || !currentItem) return;
    taskList.scrollTop = centeredTaskScrollTop(
      currentItem.offsetTop,
      currentItem.offsetHeight,
      taskList.clientHeight,
      taskList.scrollHeight,
    );
  }, [plan.updatedAt, currentIndex]);

  return (
    <section className="sidebar-task-plan" aria-label={t("task.plan", { title: plan.title })}>
      <div
        className={`sidebar-task-timeline ${active ? "active" : "idle"}`}
        role="progressbar"
        aria-label={t("task.complete", { done: completedCount, total: plan.items.length })}
        aria-valuemin={0}
        aria-valuemax={plan.items.length}
        aria-valuenow={completedCount}
      >
        <ol ref={taskListRef} className="sidebar-task-items">
          {plan.items.map((item, index) => {
            const isCurrent = index === currentIndex;
            const isDropSource = index === dropSourceIndex;
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
                    isDropSource ? "drop-source" : null,
                  ].filter(Boolean).join(" ")}
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
