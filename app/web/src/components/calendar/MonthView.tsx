import type { CalendarEventDto, CalendarWorklogDto } from "@assistant/shared";
import { Button } from "../ui/button.tsx";
import { Badge } from "../ui/badge.tsx";
import { Item } from "../ui/item.tsx";
import { useUserTimeZone } from "../../hooks/useUserTimeZone.ts";
import { EventChip } from "./EventChip.tsx";
import {
  dayOfMonth,
  monthMatrix,
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
          const isToday = date === today;
          const isSelected = date === selectedDate;
          return (
            <Item
              key={date}
              size="xs"
              variant={isSelected ? "muted" : "outline"}
              className="relative min-h-0 flex-col items-stretch justify-start gap-0.5 rounded-none border-0 border-b border-r p-1"
            >
              <Button
                variant="ghost"
                className="absolute inset-0 z-0 h-full w-full rounded-none"
                aria-label={`${date}, select day`}
                onClick={() => onSelectDate(date)}
                onDoubleClick={() => onOpenDay(date)}
              />
              <div className="z-10 flex items-center justify-between px-0.5">
                <Button
                  variant={isToday ? "default" : "ghost"}
                  size="icon-xs"
                  title="Open day view"
                  aria-label={`Open ${date} day view`}
                  onClick={() => onOpenDay(date)}
                >
                  {dayOfMonth(date)}
                </Button>
                {worklogs.length > 0 ? (
                  <Badge
                    variant="success"
                    title={`${loggedHoursLabel(worklogs)} logged to Tempo`}
                  >
                    {loggedHoursLabel(worklogs)}
                  </Badge>
                ) : null}
              </div>
              <div className="z-10 flex min-h-0 flex-col gap-px overflow-hidden">
                {events.slice(0, MAX_CHIPS).map((event) => (
                  <EventChip
                    key={event.id}
                    event={event}
                    selected={event.id === selectedEventId}
                    onSelect={onSelectEvent}
                  />
                ))}
                {events.length > MAX_CHIPS ? (
                  <Button
                    variant="link"
                    size="xs"
                    className="justify-start"
                    onClick={() => onOpenDay(date)}
                  >
                    +{events.length - MAX_CHIPS} more
                  </Button>
                ) : null}
              </div>
            </Item>
          );
        })}
      </div>
    </div>
  );
}
