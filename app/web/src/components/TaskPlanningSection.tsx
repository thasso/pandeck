import type { ReactNode } from "react";
import { CalendarCheck, CalendarClock, Flag } from "lucide-react";
import type { TaskPriority, TaskSummary } from "@assistant/shared";
import { InspectorSection } from "./shell/Inspector.tsx";
import { focusDateLabel } from "../lib/backlogFocus.ts";
import { addDays, todayIso } from "./calendar/calendarDates.ts";
import { useUserTimeZone } from "../hooks/useUserTimeZone.ts";

/** The planning fields a Task carries, as one patch. */
export interface TaskPlanningPatch {
  priority?: TaskPriority | null;
  scheduledFor?: string | null;
  dueDate?: string | null;
}

const PRIORITIES: TaskPriority[] = ["low", "normal", "high", "urgent"];

const PRIORITY_TONE: Record<TaskPriority, string> = {
  urgent: "border-destructive/50 bg-destructive/10 text-foreground",
  high: "border-amber-500/50 bg-amber-500/10 text-foreground",
  normal: "border-input bg-muted text-foreground",
  low: "border-border bg-card text-muted-foreground",
};

/**
 * @component TaskPlanningSection
 * @purpose The Task inspector's **Planning** section: priority, the day work is
 * planned for (`scheduledFor`), and the external deadline (`dueDate`).
 * @useWhen Rendered inside the Task inspector, above the context sections.
 * @avoidWhen Anywhere a Task is merely listed; this edits the Task.
 * @intent These three fields drive the Backlog's Focus view, and until now none
 * of them could be set by hand at all — they existed on the wire and only an
 * agent ever wrote them, which made "sort by priority" sort a column nobody
 * could fill in. The two dates are deliberately separate controls with separate
 * glyphs and separate one-line explanations, because the whole point of having
 * both is that a plan you chose is not a deadline imposed on you.
 * @related lib/backlogFocus.ts, TaskContextSections.tsx
 */
export function TaskPlanningSection({
  task,
  onPatch,
}: {
  task: TaskSummary;
  onPatch: (patch: TaskPlanningPatch) => void;
}) {
  const today = todayIso(useUserTimeZone());
  const priority = task.priority ?? "normal";
  // The section's collapsed summary states the plan, then the deadline, then a
  // non-default priority — the same order of importance the Focus row uses, so
  // the two surfaces cannot describe one Task differently.
  const summary =
    [
      task.scheduledFor ? focusDateLabel(task.scheduledFor, today) : null,
      task.dueDate
        ? `due ${focusDateLabel(task.dueDate, today).toLowerCase()}`
        : null,
      priority !== "normal" ? priority : null,
    ]
      .filter(Boolean)
      .join(" · ") || undefined;

  return (
    <InspectorSection
      id="planning"
      storageScope={`task:${task.id}`}
      title="Planning"
      icon={<CalendarClock size={13} />}
      summary={summary}
    >
      <div className="space-y-3 px-1">
        <div>
          <div className="mb-1 text-xs text-muted-foreground">Priority</div>
          <div
            className="flex flex-wrap items-center gap-1"
            role="group"
            aria-label="Task priority"
          >
            {PRIORITIES.map((value) => {
              const active = priority === value;
              return (
                <button
                  key={value}
                  type="button"
                  onClick={() => onPatch({ priority: value })}
                  aria-pressed={active}
                  // Same geometry as `QuickPick` below: two rows of chips in one
                  // section at different heights read as two kinds of control,
                  // and the shorter one was a ~24px target on a phone.
                  className={`cursor-pointer rounded-lg border px-2 py-1 text-sm capitalize transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 ${
                    active
                      ? PRIORITY_TONE[value]
                      : "border-border bg-card text-muted-foreground hover:bg-muted hover:text-muted-foreground"
                  }`}
                >
                  {value}
                </button>
              );
            })}
          </div>
        </div>

        <DateRow
          label="Planned for"
          hint="The day you mean to work on it."
          icon={<CalendarCheck size={12} />}
          value={task.scheduledFor ?? ""}
          today={today}
          quickPicks
          onChange={(value) => onPatch({ scheduledFor: value || null })}
        />

        <DateRow
          label="Due"
          hint="A deadline someone else is waiting on."
          icon={<Flag size={12} />}
          value={task.dueDate ?? ""}
          today={today}
          onChange={(value) => onPatch({ dueDate: value || null })}
        />
      </div>
    </InspectorSection>
  );
}

/**
 * One date field. `quickPicks` adds Today/Tomorrow buttons, offered ONLY for the
 * plan: those are the two answers you actually give when deciding what to work
 * on, whereas a deadline is a date someone hands you and shortcuts would just be
 * guesses. Clearing is part of the row rather than a separate control, because
 * un-planning is as ordinary as planning.
 */
function DateRow({
  label,
  hint,
  icon,
  value,
  today,
  quickPicks = false,
  onChange,
}: {
  label: string;
  hint: string;
  icon: ReactNode;
  value: string;
  today: string;
  quickPicks?: boolean;
  onChange: (value: string) => void;
}) {
  return (
    <div>
      <div className="mb-1 flex items-center gap-1.5 text-xs text-muted-foreground">
        {icon}
        <span>{label}</span>
      </div>
      {/* The field gets its OWN row. Sharing one with the quick picks squeezed a
          native date input to ~85px inside the ~320px panel, which clipped the
          year — and it got narrower still once Clear appeared. A date control
          that cannot show its own date is not a control. */}
      {/* And `w-full` is only a REQUEST where a date control is concerned. These
          two fields were the leading SUSPECT for the sideways scroll reported on
          iOS (Task-349) — never reproduced in Blink at any tested width, and
          WebKit could not be tested — so what follows is a hypothesis, not a
          measured cause: WebKit sizes the control from its shadow tree
          (localized date text plus native chrome) and may treat that as an
          intrinsic minimum, in which case the used width outgrows the specified
          one and the surplus lands in the inspector's scroller. `appearance-none`
          asks WebKit to lay the control out as an ordinary field honouring width
          and box-sizing; `max-w-full` is redundant beside `w-full` UNLESS that
          happens, which is the whole point of it. Verified in Blink: appearance
          `auto` vs `none` is pixel-identical here, same box and placeholder and
          picker indicator. If iOS regresses the display, drop `appearance-none`
          first. */}
      <input
        type="date"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        aria-label={label}
        className="w-full max-w-full appearance-none rounded-lg border border-border bg-background px-2 py-1 text-sm text-foreground outline-none focus:border-primary"
      />
      <div className="mt-1 flex flex-wrap items-center gap-1">
        {quickPicks ? (
          <>
            <QuickPick
              label="Today"
              onClick={() => onChange(today)}
              active={value === today}
            />
            <QuickPick
              label="Tomorrow"
              onClick={() => onChange(addDays(today, 1))}
              active={value === addDays(today, 1)}
            />
          </>
        ) : null}
        {value ? (
          <QuickPick
            label="Clear"
            onClick={() => onChange("")}
            active={false}
          />
        ) : null}
        <p className="ml-auto text-xs text-muted-foreground">{hint}</p>
      </div>
    </div>
  );
}

function QuickPick({
  label,
  onClick,
  active,
}: {
  label: string;
  onClick: () => void;
  active: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`shrink-0 cursor-pointer rounded-lg border px-2 py-1 text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 ${
        active
          ? "border-primary/60 bg-accent text-foreground"
          : "border-border bg-card text-muted-foreground hover:bg-muted hover:text-muted-foreground"
      }`}
    >
      {label}
    </button>
  );
}
