import { useState, type ReactNode } from "react";
import {
  CalendarCheck,
  CalendarClock,
  Flag,
} from "lucide-react";
import type { TaskPriority, TaskSummary } from "@assistant/shared";
import { InspectorSection } from "./shell/Inspector.tsx";
import { TaskPriorityValue } from "./TaskPriorityValue.tsx";
import { Popover, PopoverContent, PopoverTrigger } from "./ui/popover.tsx";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
} from "./ui/select.tsx";
import { Calendar } from "./ui/calendar.tsx";
import { Button } from "./ui/button.tsx";
import {
  PROPERTY_TRIGGER,
  PropertyLabel,
  PropertyList,
} from "./common/PropertyList.tsx";
import { focusDateLabel } from "../lib/backlogFocus.ts";
import { addDays, todayIso } from "../lib/taskDates.ts";
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
  leading,
}: {
  task: TaskSummary;
  onPatch: (patch: TaskPlanningPatch) => void;
  /** Property rows (label, value) drawn above priority — the Project. */
  leading?: ReactNode;
}) {
  const today = todayIso(useUserTimeZone());
  const priority = task.priority ?? "normal";

  return (
    <InspectorSection
      id="planning"
      storageScope={`task:${task.id}`}
      title="Details"
      icon={<CalendarClock size={13} />}
    >
      {/* A property list: one line per field, the label on the left and the
          value on the right as its own quiet control — a picker opens from
          it rather than every option standing on the panel. */}
      <PropertyList>
        {leading}
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
            <TaskPriorityValue priority={priority} />
          </SelectTrigger>
          <SelectContent align="start">
            {PRIORITIES.map((value) => (
              <SelectItem key={value} value={value}>
                <TaskPriorityValue priority={value} />
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
      </PropertyList>
    </InspectorSection>
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
      <PopoverContent align="start" className="w-auto">
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
        {/* The theme's own month grid (shadcn Calendar), not the browser's
            date control: its font, icon and popup could not be themed. */}
        <Calendar
          mode="single"
          aria-label={label}
          selected={value ? fromIso(value) : undefined}
          defaultMonth={fromIso(value || today)}
          today={fromIso(today)}
          onSelect={(date) => pick(date ? toIso(date) : "")}
        />
        <p className="max-w-56 text-xs text-muted-foreground">{hint}</p>
      </PopoverContent>
    </Popover>
  );
}

/** `YYYY-MM-DD` as a local calendar day (never UTC midnight). */
function fromIso(iso: string): Date {
  const [year, month, day] = iso.split("-").map(Number);
  return new Date(year ?? 1970, (month ?? 1) - 1, day ?? 1);
}

function toIso(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}
