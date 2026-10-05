import { useCallback, useMemo, useRef, useState } from "react";
import type { CalendarEventDto, CalendarWorklogDto } from "@assistant/shared";
import {
  fetchCalendarEvents,
  fetchCalendarWorklogs,
} from "../lib/calendarApi.ts";
import {
  dataOf,
  failed,
  refreshing,
  type LoadState,
} from "../lib/loadState.ts";
import { useFetchState } from "./useFetchState.ts";
import {
  type CalendarView,
  addDays,
  addMonths,
  dayKey,
  groupEventsByDay,
  rangeForView,
  todayIso,
} from "../components/calendar/calendarDates.ts";

interface UseCalendarArgs {
  /** Whether the calendar surface is currently shown (gates network fetches). */
  active: boolean;
  /** View from the route (source of truth). */
  view: CalendarView;
  /** Selected user-local day from the route (source of truth). */
  selectedDate: string;
  /** The user's effective timezone: day buckets and range bounds resolve in it. */
  timeZone: string;
  /** Overlay my logged Tempo time alongside events (gates the worklog fetch). */
  showTempo: boolean;
  /** Push a new calendar address (App maps to navigate(calendarPath(view, date))). */
  onNavigate: (view: CalendarView, date: string) => void;
}

export interface CalendarController {
  view: CalendarView;
  selectedDate: string;
  /**
   * Events for the visible range. A failure KEEPS the last answer (R2), so the
   * grid stays populated under the page's `ErrorNote`.
   */
  events: LoadState<CalendarEventDto[]>;
  /** The events to draw, grouped by user-local day (retained while refetching). */
  eventsByDay: Map<string, CalendarEventDto[]>;
  /** My logged Tempo worklogs for the visible range; `idle` while the overlay is off. */
  worklogs: LoadState<CalendarWorklogDto[]>;
  worklogsByDay: Map<string, CalendarWorklogDto[]>;
  selectedEvent: CalendarEventDto | null;
  setView: (view: CalendarView) => void;
  goPrev: () => void;
  goNext: () => void;
  goToday: () => void;
  selectDay: (date: string) => void;
  /** Open a specific day in day view (one navigation). */
  openDay: (date: string) => void;
  selectEvent: (id: string | null) => void;
  /** Refetch the visible range's events, keeping what is drawn (R2). */
  refreshEvents: () => void;
  /** Refetch the Tempo overlay for the visible range. */
  refreshWorklogs: () => void;
}

const NO_EVENTS: CalendarEventDto[] = [];
const NO_WORKLOGS: CalendarWorklogDto[] = [];

/**
 * Keep the visible entries across a RANGE change (R2). Moving month or week is
 * a new fetch key, so the fetch state drops the previous answer — but calendar
 * entries are addressed BY DAY, so re-attaching that answer can only paint days
 * the new range also covers (a week's overlap, a month grid's leading and
 * trailing days) and never puts one object's content under another's id. The
 * result is the honest state for it: `refreshing` while the new range loads,
 * and an `error` that still carries what is on screen when it fails.
 */
function withRetainedEvents(
  state: LoadState<CalendarEventDto[]>,
  retained: CalendarEventDto[],
): LoadState<CalendarEventDto[]> {
  if (dataOf(state) !== undefined || retained.length === 0) return state;
  if (state.status === "loading") return refreshing(retained);
  if (state.status === "error") return failed(state.error, retained);
  return state;
}

export function useCalendar({
  active,
  view,
  selectedDate,
  timeZone,
  showTempo,
  onNavigate,
}: UseCalendarArgs): CalendarController {
  const [selectedEventId, setSelectedEventId] = useState<string | null>(null);

  const range = useMemo(
    () => rangeForView(view, selectedDate, timeZone),
    [view, selectedDate, timeZone],
  );

  // Events for the visible range. The range IS the key, so an answer for the
  // month you just left can never land as the month you are looking at.
  const { state: eventsFetch, reload: refreshEvents } = useFetchState(
    `${range.from}|${range.to}`,
    useCallback(
      async () => (await fetchCalendarEvents(range.from, range.to)).events,
      [range.from, range.to],
    ),
    { enabled: active },
  );

  // My logged Tempo worklogs for the visible range (own worklogs). The overlay
  // toggle gates the fetch: off means `idle`, so nothing renders.
  const { state: worklogs, reload: refreshWorklogs } = useFetchState(
    `${range.from}|${range.to}`,
    useCallback(
      async () =>
        (
          await fetchCalendarWorklogs(
            range.from.slice(0, 10),
            range.to.slice(0, 10),
          )
        ).worklogs,
      [range.from, range.to],
    ),
    { enabled: active && showTempo },
  );

  // Remember the last answer across a range change (see `withRetainedEvents`).
  // Dropped when the surface parks at `idle`, so a reopened calendar starts
  // from a real first load rather than from whatever was on screen last week.
  const retainedEvents = useRef<CalendarEventDto[]>(NO_EVENTS);
  const answeredEvents = dataOf(eventsFetch);
  if (answeredEvents) retainedEvents.current = answeredEvents;
  else if (eventsFetch.status === "idle") retainedEvents.current = NO_EVENTS;
  const events = withRetainedEvents(eventsFetch, retainedEvents.current);
  const shownEvents = dataOf(events) ?? NO_EVENTS;

  const eventsByDay = useMemo(
    () => groupEventsByDay(shownEvents, timeZone),
    [shownEvents, timeZone],
  );
  const shownWorklogs = dataOf(worklogs) ?? NO_WORKLOGS;
  const worklogsByDay = useMemo(() => {
    const map = new Map<string, CalendarWorklogDto[]>();
    for (const worklog of shownWorklogs) {
      const list = map.get(worklog.startDate) ?? [];
      list.push(worklog);
      map.set(worklog.startDate, list);
    }
    return map;
  }, [shownWorklogs]);
  const selectedEvent = useMemo(
    () =>
      selectedEventId
        ? (shownEvents.find((event) => event.id === selectedEventId) ?? null)
        : null,
    [shownEvents, selectedEventId],
  );

  // Navigating the period (prev/next/today/view) or picking a day clears the
  // selected event; selecting an event keeps it (and jumps to its day).
  const navigateTo = useCallback(
    (nextView: CalendarView, date: string) => {
      setSelectedEventId(null);
      onNavigate(nextView, date);
    },
    [onNavigate],
  );

  const setView = useCallback(
    (next: CalendarView) => navigateTo(next, selectedDate),
    [navigateTo, selectedDate],
  );
  const goToday = useCallback(
    () => navigateTo(view, todayIso(timeZone)),
    [navigateTo, view, timeZone],
  );
  const goPrev = useCallback(() => {
    const delta =
      view === "month"
        ? addMonths(selectedDate, -1)
        : addDays(selectedDate, view === "week" ? -7 : -1);
    navigateTo(view, delta);
  }, [navigateTo, view, selectedDate]);
  const goNext = useCallback(() => {
    const delta =
      view === "month"
        ? addMonths(selectedDate, 1)
        : addDays(selectedDate, view === "week" ? 7 : 1);
    navigateTo(view, delta);
  }, [navigateTo, view, selectedDate]);
  const selectDay = useCallback(
    (date: string) => navigateTo(view, date),
    [navigateTo, view],
  );
  const openDay = useCallback(
    (date: string) => navigateTo("day", date),
    [navigateTo],
  );
  // Selecting a calendar entry also selects its day (intuitive: clicking an
  // event focuses that day's detail), keeping the event highlighted.
  const selectEvent = useCallback(
    (id: string | null) => {
      setSelectedEventId(id);
      if (!id) return;
      const event = shownEvents.find((item) => item.id === id);
      const eventDay = event?.start ? dayKey(event.start, timeZone) : null;
      if (eventDay && eventDay !== selectedDate) onNavigate(view, eventDay);
    },
    [shownEvents, onNavigate, view, selectedDate, timeZone],
  );

  return {
    view,
    selectedDate,
    events,
    eventsByDay,
    worklogs,
    worklogsByDay,
    selectedEvent,
    setView,
    goPrev,
    goNext,
    goToday,
    selectDay,
    openDay,
    selectEvent,
    refreshEvents,
    refreshWorklogs,
  };
}
