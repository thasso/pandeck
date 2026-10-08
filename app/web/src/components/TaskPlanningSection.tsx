import { useState, type ReactNode } from "react";
import {
  CalendarCheck,
  CalendarClock,
  Flag,
  SignalHigh,
  SignalLow,
  SignalMedium,
  TriangleAlert,
} from "lucide-react";
import type { TaskPriority, TaskSummary } from "@assistant/shared";
import { InspectorSection } from "./shell/Inspector.tsx";
import { Popover, PopoverContent, PopoverTrigger } from "./ui/popover.tsx";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
} from "./ui/select.tsx";
import { Input } from "./ui/input.tsx";
import { Button } from "./ui/button.tsx";
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
      {/* A property list: one line per field, the label on the left and the
          value on the right as its own quiet control — a picker opens from
          it rather than every option standing on the panel. */}
      <div className="grid grid-cols-[5.5rem_minmax(0,1fr)] items-center gap-y-0.5 px-1">
        <PropertyLabel>Priority</PropertyLabel>
        <Select
          value={priority}
          onValueChange={(value) => {
            if (value) onPatch({ priority: value as TaskPriority });
          }}
        >
          <SelectTrigger
            size="sm"
            aria-label="Task priority"
            className={PROPERTY_TRIGGER}
          >
            <PriorityValue priority={priority} />
          </SelectTrigger>
          <SelectContent align="start">
            {PRIORITIES.map((value) => (
              <SelectItem key={value} value={value}>
                <PriorityValue priority={value} />
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <PropertyLabel>Planned</PropertyLabel>
        <DateProperty
          label="Planned for"
          hint="The day you mean to work on it."
          icon={<CalendarCheck />}
          value={task.scheduledFor ?? ""}
          today={today}
          quickPicks
          onChange={(value) => onPatch({ scheduledFor: value || null })}
        />

        <PropertyLabel>Due</PropertyLabel>
        <DateProperty
          label="Due"
          hint="A deadline someone else is waiting on."
          icon={<Flag />}
          value={task.dueDate ?? ""}
          today={today}
          overdueTone
          onChange={(value) => onPatch({ dueDate: value || null })}
        />
      </div>
    </InspectorSection>
  );
}

/** A value control in the property list: borderless, filled on hover, the
 *  width of its column so every value starts at the same x. */
const PROPERTY_TRIGGER =
  "h-7 w-full justify-between border-transparent bg-transparent px-2 font-normal shadow-none hover:bg-muted dark:bg-transparent dark:hover:bg-muted/50";

function PropertyLabel({ children }: { children: ReactNode }) {
  return <span className="text-sm text-muted-foreground">{children}</span>;
}

const PRIORITY_DISPLAY: Record<
  TaskPriority,
  { Icon: typeof SignalLow; tone: string }
> = {
  low: { Icon: SignalLow, tone: "text-muted-foreground" },
  normal: { Icon: SignalMedium, tone: "text-muted-foreground" },
  high: { Icon: SignalHigh, tone: "text-warning" },
  urgent: { Icon: TriangleAlert, tone: "text-destructive" },
};

function PriorityValue({ priority }: { priority: TaskPriority }) {
  const { Icon, tone } = PRIORITY_DISPLAY[priority];
  return (
    <span className="flex min-w-0 items-center gap-2">
      <Icon className={`size-4 shrink-0 ${tone}`} aria-hidden />
      <span className="capitalize">{priority}</span>
    </span>
  );
}

/**
 * One date as a property: its value on the line, and a picker under it with
 * the date field, Clear, and — for the plan only — Today and Tomorrow. Those
 * are the two answers you actually give when deciding what to work on, whereas
 * a deadline is a date someone hands you and shortcuts would just be guesses.
 */
function DateProperty({
  label,
  hint,
  icon,
  value,
  today,
  quickPicks = false,
  overdueTone = false,
  onChange,
}: {
  label: string;
  hint: string;
  icon: ReactNode;
  value: string;
  today: string;
  quickPicks?: boolean;
  /** Tone a past date as overdue (the deadline, not the plan). */
  overdueTone?: boolean;
  onChange: (value: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const pick = (next: string) => {
    onChange(next);
    setOpen(false);
  };
  const overdue = overdueTone && value !== "" && value < today;
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <Button
            variant="ghost"
            size="sm"
            aria-label={label}
            className={`${PROPERTY_TRIGGER} justify-start [&_svg]:text-muted-foreground`}
          />
        }
      >
        {icon}
        {value ? (
          <span className={overdue ? "text-destructive" : ""}>
            {focusDateLabel(value, today)}
          </span>
        ) : (
          <span className="text-muted-foreground">Not set</span>
        )}
      </PopoverTrigger>
      <PopoverContent align="start" className="w-64">
        {/* `max-w-full`: WebKit may size a date control from its native
            chrome past the width it was given (Task-349). */}
        <Input
          type="date"
          value={value}
          onChange={(event) => onChange(event.target.value)}
          aria-label={label}
          className="w-full max-w-full"
        />
        <div className="flex flex-wrap items-center gap-1">
          {quickPicks ? (
            <>
              <Button
                variant={value === today ? "secondary" : "outline"}
                size="xs"
                aria-pressed={value === today}
                onClick={() => pick(today)}
              >
                Today
              </Button>
              <Button
                variant={value === addDays(today, 1) ? "secondary" : "outline"}
                size="xs"
                aria-pressed={value === addDays(today, 1)}
                onClick={() => pick(addDays(today, 1))}
              >
                Tomorrow
              </Button>
            </>
          ) : null}
          {value ? (
            <Button
              variant="ghost"
              size="xs"
              className="ml-auto"
              onClick={() => pick("")}
            >
              Clear
            </Button>
          ) : null}
        </div>
        <p className="text-xs text-muted-foreground">{hint}</p>
      </PopoverContent>
    </Popover>
  );
}
