import { CalendarDays, ChevronLeft, ChevronRight } from "lucide-react";
import { Button } from "../ui/button.tsx";
import { ToggleGroup, ToggleGroupItem } from "../ui/toggle-group.tsx";
import { IconButton } from "../common/IconButton.tsx";
import type { CalendarController } from "../../hooks/useCalendar.ts";
import type { Prefs } from "../../hooks/usePrefs.ts";
import { errorOf, isInitialLoad, isPending } from "../../lib/loadState.ts";
import { ErrorNote, RefreshIndicator } from "../common/load.tsx";
import { MonthView } from "./MonthView.tsx";
import { TimeGrid } from "./TimeGrid.tsx";
import { PageHeaderBackButton, type PageHeaderBack } from "../PageHeader.tsx";
import {
  type CalendarView,
  formatFullDate,
  monthLabel,
  weekDays,
} from "./calendarDates.ts";

interface CalendarPageProps {
  /**
   * Mobile screen back control (ui-shell.md, Small Screens). The calendar's own
   * toolbar is its page header, so it renders the control itself.
   */
  back?: PageHeaderBack | undefined;
  calendar: CalendarController;
  prefs: Prefs;
  onUpdatePrefs: (patch: Partial<Prefs>) => void;
  /** Reveal the day-detail panel (opens the right inspector, e.g. on mobile). */
  onFocusDay: () => void;
}

const VIEWS: CalendarView[] = ["month", "week", "day"];

export function CalendarPage({
  back,
  calendar,
  prefs,
  onUpdatePrefs,
  onFocusDay,
}: CalendarPageProps) {
  const {
    view,
    selectedDate,
    events,
    eventsByDay,
    worklogs,
    worklogsByDay,
    selectedEvent,
  } = calendar;
  const eventsError = errorOf(events);
  // The Tempo overlay is an addition to the grid, so its failure is a note over
  // the calendar, never a silently missing overlay.
  const worklogsError = errorOf(worklogs);
  const showWeekends = prefs.calendarShowWeekends;
  const showTempo = prefs.calendarShowTempo;
  // Selecting a day focuses it in the right detail panel (and reveals the panel).
  const selectDay = (date: string) => {
    calendar.selectDay(date);
    onFocusDay();
  };

  const title =
    view === "month"
      ? monthLabel(selectedDate)
      : view === "week"
        ? `Week of ${formatFullDate(weekDays(selectedDate)[0]!).replace(/^\w+,\s/, "")}`
        : formatFullDate(selectedDate);

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-background">
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border px-4 py-2.5">
        {back ? (
          <PageHeaderBackButton {...back} />
        ) : (
          <CalendarDays size={17} className="text-primary" />
        )}
        <h1 className="mr-2 min-w-0 truncate text-base font-semibold text-foreground">
          {title}
        </h1>
        <div className="flex items-center gap-0.5">
          <IconButton label="Previous" onClick={calendar.goPrev}>
            <ChevronLeft />
          </IconButton>
          <Button variant="ghost" size="sm" onClick={calendar.goToday}>
            Today
          </Button>
          <IconButton label="Next" onClick={calendar.goNext}>
            <ChevronRight />
          </IconButton>
        </div>
        {isPending(events) && (
          <RefreshIndicator
            label={
              isInitialLoad(events) ? "Loading events" : "Refreshing events"
            }
          />
        )}
        <div className="ml-auto flex items-center gap-1.5">
          <Button
            variant={showTempo ? "secondary" : "outline"}
            size="sm"
            onClick={() => onUpdatePrefs({ calendarShowTempo: !showTempo })}
            title={
              showTempo ? "Hide logged Tempo time" : "Show logged Tempo time"
            }
            aria-pressed={showTempo}
          >
            Tempo
          </Button>
          {view !== "day" && (
            <Button
              variant={showWeekends ? "secondary" : "outline"}
              size="sm"
              onClick={() =>
                onUpdatePrefs({ calendarShowWeekends: !showWeekends })
              }
              title={showWeekends ? "Hide weekends" : "Show weekends"}
              aria-pressed={showWeekends}
            >
              Weekends
            </Button>
          )}
          <ToggleGroup
            value={[view]}
            onValueChange={(values) => {
              const selected = values[0] as CalendarView | undefined;
              if (selected) calendar.setView(selected);
            }}
            variant="outline"
            size="sm"
            aria-label="Calendar view"
          >
            {VIEWS.map((v) => (
              <ToggleGroupItem
                key={v}
                value={v}
                aria-label={`${v} view`}
                className="capitalize"
              >
                {v}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
        </div>
      </div>

      {/* Non-blocking (R2): the grid below keeps the entries it already has. */}
      {(eventsError || worklogsError) && (
        <div className="flex shrink-0 flex-col gap-1.5 border-b border-border px-4 py-2">
          {eventsError && (
            <ErrorNote
              message={`Could not load calendar events: ${eventsError}`}
              onRetry={calendar.refreshEvents}
            />
          )}
          {worklogsError && (
            <ErrorNote
              message={`Could not load logged Tempo time: ${worklogsError}`}
              onRetry={calendar.refreshWorklogs}
            />
          )}
        </div>
      )}

      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        {view === "month" ? (
          <MonthView
            anchor={selectedDate}
            eventsByDay={eventsByDay}
            worklogsByDay={showTempo ? worklogsByDay : undefined}
            selectedDate={selectedDate}
            selectedEventId={selectedEvent?.id ?? null}
            showWeekends={showWeekends}
            onSelectDate={selectDay}
            onOpenDay={calendar.openDay}
            onSelectEvent={calendar.selectEvent}
          />
        ) : (
          <TimeGrid
            days={
              view === "week"
                ? weekDays(selectedDate, showWeekends)
                : [selectedDate]
            }
            eventsByDay={eventsByDay}
            worklogsByDay={showTempo ? worklogsByDay : undefined}
            selectedDate={selectedDate}
            selectedEventId={selectedEvent?.id ?? null}
            onSelectDay={selectDay}
            onOpenDay={calendar.openDay}
            onSelectEvent={calendar.selectEvent}
            showHeaders={view === "week"}
            hourPx={prefs.calendarHourPx}
            onHourPxChange={(hourPx) =>
              onUpdatePrefs({ calendarHourPx: hourPx })
            }
          />
        )}
      </div>
    </div>
  );
}
