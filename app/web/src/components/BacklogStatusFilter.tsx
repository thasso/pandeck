import { CheckCircle2, Circle, CircleDot } from "lucide-react";
import type { TaskStatus } from "@assistant/shared";
import { ALL_STATUSES } from "../lib/backlogTreeModel.ts";

const META: Record<
  TaskStatus,
  { label: string; Icon: typeof Circle; on: string }
> = {
  todo: {
    label: "To do",
    Icon: Circle,
    on: "border-line-strong bg-raised text-fg",
  },
  doing: {
    label: "In progress",
    Icon: CircleDot,
    on: "border-primary/60 bg-accent text-fg",
  },
  done: {
    label: "Done",
    Icon: CheckCircle2,
    on: "border-emerald-500/50 bg-emerald-500/10 text-fg",
  },
};

/**
 * Multi-select status chips for the Backlog. A chip toggles whether that status
 * is shown; an empty or all-selected set means "no filter" (everything shows).
 * The set is the source of truth, persisted by the caller (prefs).
 *
 * `options` narrows which chips are OFFERED without touching the persisted set,
 * for a view that cannot honour one of them: Focus never shows done Tasks, and
 * a chip that changes nothing is worse than no chip. The pref keeps its value
 * for the views that do use it.
 */
export function BacklogStatusFilter({
  statuses,
  onChange,
  compact = false,
  options = ALL_STATUSES,
}: {
  statuses: Set<TaskStatus>;
  onChange: (next: TaskStatus[]) => void;
  compact?: boolean;
  options?: readonly TaskStatus[] | undefined;
}) {
  const toggle = (status: TaskStatus) => {
    const next = new Set(statuses);
    if (next.has(status)) next.delete(status);
    else next.add(status);
    onChange([...next]);
  };
  return (
    <div
      className="inline-flex items-center gap-1"
      role="group"
      aria-label="Filter by status"
    >
      {options.map((status) => {
        const meta = META[status];
        const active = statuses.has(status);
        const Icon = meta.Icon;
        return (
          <button
            key={status}
            type="button"
            onClick={() => toggle(status)}
            aria-pressed={active}
            title={`${active ? "Hide" : "Show"} ${meta.label}`}
            aria-label={`${active ? "Hide" : "Show"} ${meta.label}`}
            className={`inline-flex items-center gap-1.5 rounded-lg border transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 ${compact ? "px-1.5 py-0.5 text-xs" : "px-2 py-1 text-sm"} ${active ? meta.on : "border-line bg-panel text-faint hover:bg-raised hover:text-muted-foreground"}`}
          >
            <Icon
              size={compact ? 11 : 12}
              className={
                active && status === "done"
                  ? "text-emerald-500"
                  : active && status === "doing"
                    ? "text-primary"
                    : ""
              }
            />
            {compact ? null : meta.label}
          </button>
        );
      })}
    </div>
  );
}
