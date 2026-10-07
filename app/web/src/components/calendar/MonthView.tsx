import type { CalendarEventDto, CalendarWorklogDto } from "@assistant/shared";
import { useUserTimeZone } from "../../hooks/useUserTimeZone.ts";
import { EventChip } from "./EventChip.tsx";
import {
  dayOfMonth,
  monthMatrix,
  monthOf,
  shortWeekday,
  todayIso,
} from "./calendarDates.ts";

interface MonthViewProps {
  anchor: string;
  eventsByDay: Map<string, CalendarEventDto[]>;
  /** Logged Tempo time per day (present only when the overlay is on). */
  worklogsByDay?: Map<string, CalendarWorklogDto[]> | undefined;
  selectedDate: string;
  selectedEventId: string | null;
  showWeekends: boolean;
  onSelectDate: (date: string) => void;
  onOpenDay: (date: string) => void;
  onSelectEvent: (id: string) => void;
}

const MAX_CHIPS = 3;

/** Compact logged-hours label, e.g. "3h" or "1.5h". */
function loggedHoursLabel(worklogs: CalendarWorklogDto[]): string {
  const h = worklogs.reduce((sum, w) => sum + w.seconds, 0) / 3600;
  return Number.isInteger(h) ? `${h}h` : `${h.toFixed(1)}h`;
}

export function MonthView({
  anchor,
  eventsByDay,
  worklogsByDay,
  selectedDate,
  selectedEventId,
  showWeekends,
  onSelectDate,
  onOpenDay,
  onSelectEvent,
}: MonthViewProps) {
  const weeks = monthMatrix(anchor, showWeekends);
  const today = todayIso(useUserTimeZone());
  const currentMonth = monthOf(anchor);
  const cols = weeks[0]!.length;
  const gridStyle = { gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="grid border-b border-border" style={gridStyle}>
        {weeks[0]!.map((date) => (
          <div
            key={date}
            className="px-2 py-1.5 text-sm font-medium uppercase tracking-wide text-muted-foreground"
          >
            {shortWeekday(date)}
          </div>
        ))}
      </div>
      <div className="grid min-h-0 flex-1 auto-rows-fr" style={gridStyle}>
        {weeks.flat().map((date) => {
          const events = eventsByDay.get(date) ?? [];
          const worklogs = worklogsByDay?.get(date) ?? [];
          const inMonth = monthOf(date) === currentMonth;
          const isToday = date === today;
          const isSelected = date === selectedDate;
          return (
            <button
              type="button"
              key={date}
              onClick={() => onSelectDate(date)}
              onDoubleClick={() => onOpenDay(date)}
              className={`flex min-h-0 flex-col gap-0.5 border-b border-r border-border p-1 text-left transition-colors hover:bg-muted/60 ${
                inMonth ? "bg-background" : "bg-card/40"
              } ${isSelected ? "ring-1 ring-inset ring-primary" : ""}`}
            >
              <div className="flex items-center justify-between px-0.5">
                <span
                  role="button"
                  tabIndex={-1}
                  title="Open day view"
                  onClick={(e) => {
                    e.stopPropagation();
                    onOpenDay(date);
                  }}
                  className={`flex size-5 items-center justify-center rounded-full text-sm hover:ring-1 hover:ring-primary ${
                    isToday
                      ? "bg-primary font-semibold text-primary-foreground"
                      : inMonth
                        ? "text-foreground"
                        : "text-muted-foreground"
                  }`}
                >
                  {dayOfMonth(date)}
                </span>
                {worklogs.length > 0 && (
                  <span
                    title={`${loggedHoursLabel(worklogs)} logged to Tempo`}
                    className="rounded bg-emerald-500/15 px-1 text-xs font-medium tabular-nums text-emerald-600 dark:text-emerald-400"
                  >
                    {loggedHoursLabel(worklogs)}
                  </span>
                )}
              </div>
              <div className="flex min-h-0 flex-col gap-px overflow-hidden">
                {events.slice(0, MAX_CHIPS).map((event) => (
                  <EventChip
                    key={event.id}
                    event={event}
                    selected={event.id === selectedEventId}
                    onSelect={onSelectEvent}
                  />
                ))}
                {events.length > MAX_CHIPS && (
                  <span
                    role="button"
                    tabIndex={-1}
                    onClick={(e) => {
                      e.stopPropagation();
                      onOpenDay(date);
                    }}
                    className="px-1 text-xs text-muted-foreground hover:text-foreground"
                  >
                    +{events.length - MAX_CHIPS} more
                  </span>
                )}
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}
