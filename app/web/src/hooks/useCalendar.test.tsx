// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import type {
  CalendarEventDto,
  CalendarEventsResponse,
  CalendarWorklogsResponse,
} from "@assistant/shared";
import { useCalendar, type CalendarController } from "./useCalendar.ts";

/**
 * Controller-level loading behaviour for the calendar (Task-361 phase 3a).
 *
 * The two fetches this hook owns each had their own bug: the events fetch
 * cleared the grid on failure, and the Tempo overlay dropped its error
 * silently. These tests are about the states the
 * controller reports, not about pixels.
 */

const deferrals = {
  events: [] as Array<Deferred<CalendarEventsResponse>>,
  worklogs: [] as Array<Deferred<CalendarWorklogsResponse>>,
};

interface Deferred<T> {
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
}

function defer<T>(into: Array<Deferred<T>>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    into.push({ resolve, reject });
  });
}

vi.mock("../lib/calendarApi.ts", () => ({
  fetchCalendarEvents: () => defer(deferrals.events),
  fetchCalendarWorklogs: () => defer(deferrals.worklogs),
}));

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLDivElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
  controller = null;
  deferrals.events.length = 0;
  deferrals.worklogs.length = 0;
});

function event(id: string, start: string): CalendarEventDto {
  return {
    id,
    title: id,
    start,
    end: start,
    allDay: false,
    status: null,
    htmlLink: null,
    location: null,
    description: null,
    meetingUrl: null,
    conferenceLinks: [],
    organizer: null,
    selfResponse: null,
    attendees: [],
    attendeeCount: 0,
    hasMinutesAttachment: false,
    transparency: null,
  };
}

function eventsResponse(events: CalendarEventDto[]): CalendarEventsResponse {
  return {
    from: "",
    to: "",
    calendarId: "primary",
    calendarSummary: null,
    timeZone: null,
    events,
  };
}

interface HostProps {
  date: string;
  showTempo?: boolean;
}

let controller: CalendarController | null = null;

/** Day view, so moving the date moves the events range. */
function Host({ date, showTempo = false }: HostProps) {
  controller = useCalendar({
    active: true,
    view: "day",
    selectedDate: date,
    timeZone: "Europe/Berlin",
    showTempo,
    onNavigate: () => {},
  });
  return null;
}

function latest(): CalendarController {
  return controller!;
}

function mount(props: HostProps): void {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() => {
    root!.render(<Host {...props} />);
  });
}

it("keeps the events on screen when a refetch fails", async () => {
  mount({ date: "2026-08-11" });
  expect(latest().events.status).toBe("loading");

  await act(async () => {
    deferrals.events[0]!.resolve(
      eventsResponse([event("standup", "2026-08-11T09:00:00+02:00")]),
    );
  });
  expect(latest().events.status).toBe("ready");
  expect(latest().eventsByDay.get("2026-08-11")).toHaveLength(1);

  await act(async () => {
    latest().refreshEvents();
  });
  expect(latest().events.status).toBe("refreshing");

  await act(async () => {
    deferrals.events[1]!.reject(new Error("network down"));
  });
  // R2: the failure is reported AND the grid keeps what it had — the old hook
  // set the list to [] here, which read as "no meetings today".
  expect(latest().events).toEqual({
    status: "error",
    error: "network down",
    data: [expect.objectContaining({ id: "standup" })],
  });
  expect(latest().eventsByDay.get("2026-08-11")).toHaveLength(1);
});

it("keeps the visible entries while a new range loads", async () => {
  mount({ date: "2026-08-11" });
  await act(async () => {
    deferrals.events[0]!.resolve(
      eventsResponse([event("standup", "2026-08-11T09:00:00+02:00")]),
    );
  });

  // Moving the range is a same-surface refresh: entries are addressed by day,
  // so what still applies stays drawn under a `RefreshIndicator`.
  await act(async () => {
    root!.render(<Host date="2026-08-12" />);
  });
  expect(latest().events.status).toBe("refreshing");
  expect(latest().eventsByDay.get("2026-08-11")).toHaveLength(1);

  await act(async () => {
    deferrals.events[1]!.resolve(
      eventsResponse([event("review", "2026-08-12T09:00:00+02:00")]),
    );
  });
  expect(latest().events.status).toBe("ready");
  expect(latest().eventsByDay.get("2026-08-11")).toBeUndefined();
  expect(latest().eventsByDay.get("2026-08-12")).toHaveLength(1);
});

it("surfaces a failed Tempo overlay rather than showing no overlay", async () => {
  mount({ date: "2026-08-11", showTempo: true });
  await act(async () => {
    deferrals.worklogs[0]!.reject(new Error("tempo unauthorized"));
  });
  expect(latest().worklogs).toEqual({
    status: "error",
    error: "tempo unauthorized",
  });
  expect(latest().worklogsByDay.size).toBe(0);
});
