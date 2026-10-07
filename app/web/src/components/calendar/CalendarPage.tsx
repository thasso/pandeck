import { CalendarDays, ChevronLeft, ChevronRight } from "lucide-react";
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
          <button
            type="button"
            onClick={calendar.goPrev}
            aria-label="Previous"
            className="flex size-7 items-center justify-center rounded-lg text-muted-foreground hover:bg-card hover:text-foreground"
          >
            <ChevronLeft size={16} />
          </button>
          <button
            type="button"
            onClick={calendar.goToday}
            className="rounded-lg px-2 py-1 text-sm font-medium text-muted-foreground hover:bg-card hover:text-foreground"
          >
            Today
          </button>
          <button
            type="button"
            onClick={calendar.goNext}
            aria-label="Next"
            className="flex size-7 items-center justify-center rounded-lg text-muted-foreground hover:bg-card hover:text-foreground"
          >
            <ChevronRight size={16} />
          </button>
        </div>
        {isPending(events) && (
          <RefreshIndicator
            label={
              isInitialLoad(events) ? "Loading events" : "Refreshing events"
            }
          />
        )}
        <div className="ml-auto flex items-center gap-1.5">
          <button
            type="button"
            onClick={() => onUpdatePrefs({ calendarShowTempo: !showTempo })}
            title={
              showTempo ? "Hide logged Tempo time" : "Show logged Tempo time"
            }
            aria-pressed={showTempo}
            className={`rounded-lg border px-2 py-1 text-sm font-medium transition-colors ${
              showTempo
                ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
                : "border-border text-muted-foreground hover:bg-card hover:text-foreground"
            }`}
          >
            Tempo
          </button>
          {view !== "day" && (
            <button
              type="button"
              onClick={() =>
                onUpdatePrefs({ calendarShowWeekends: !showWeekends })
              }
              title={showWeekends ? "Hide weekends" : "Show weekends"}
              aria-pressed={showWeekends}
              className={`rounded-lg border px-2 py-1 text-sm font-medium transition-colors ${
                showWeekends
                  ? "border-primary/40 bg-accent text-primary"
                  : "border-border text-muted-foreground hover:bg-card hover:text-foreground"
              }`}
            >
              Weekends
            </button>
          )}
          <div className="flex items-center gap-0.5 rounded-lg border border-border p-0.5">
            {VIEWS.map((v) => (
              <button
                key={v}
                type="button"
                onClick={() => calendar.setView(v)}
                className={`rounded-md px-2.5 py-1 text-sm font-medium capitalize transition-colors ${
                  view === v
                    ? "bg-primary text-primary-foreground"
                    : "text-muted-foreground hover:bg-card hover:text-foreground"
                }`}
              >
                {v}
              </button>
            ))}
          </div>
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
