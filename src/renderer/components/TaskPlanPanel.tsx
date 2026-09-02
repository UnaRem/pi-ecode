import { Check, ChevronDown, Circle, LoaderCircle } from "lucide-react";
import { useState } from "react";
import type { TaskPlan } from "@shared/contracts";

export function TaskPlanPanel({ plan }: { plan: TaskPlan }) {
  const [expanded, setExpanded] = useState(false);
  const completed = plan.items.filter((item) => item.status === "completed").length;
  const current = plan.items.find((item) => item.status === "in_progress");

  return (
    <section className={`task-plan-panel ${expanded ? "expanded" : ""}`} aria-label="Task plan">
      <button className="task-plan-summary" onClick={() => setExpanded((value) => !value)} aria-expanded={expanded}>
        <span className="task-plan-progress">{completed}/{plan.items.length}</span>
        <span className="task-plan-copy">
          <strong>{plan.title}</strong>
          <small>{current?.text ?? (completed === plan.items.length ? "All steps complete" : "Waiting for the next step")}</small>
        </span>
        <ChevronDown size={15} aria-hidden="true" />
      </button>
      {expanded && (
        <ol className="task-plan-items">
          {plan.items.map((item) => (
            <li key={item.id} className={item.status}>
              <span aria-hidden="true">
                {item.status === "completed"
                  ? <Check size={14} />
                  : item.status === "in_progress"
                    ? <LoaderCircle className="spin" size={14} />
                    : <Circle size={12} />}
              </span>
              <span>{item.text}</span>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
