// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CalendarDayState, CalendarEventDto } from "@assistant/shared";
import type { CalendarController } from "../../hooks/useCalendar.ts";
import type { Prefs } from "../../hooks/usePrefs.ts";
import {
  failed,
  idle,
  loading,
  ready,
  refreshing,
} from "../../lib/loadState.ts";
import { CalendarDetailPanel } from "./CalendarDetailPanel.tsx";
import { CalendarPage } from "./CalendarPage.tsx";
import { groupEventsByDay } from "./calendarDates.ts";

/**
 * How the calendar surfaces DRAW the five states (`app/web/docs/loading-states.md`).
 * The controller's own states are covered by `hooks/useCalendar.test.tsx`; this
 * is about what the user is left looking at when a fetch is slow or fails.
 */

let root: Root | null = null;
let container: HTMLDivElement | null = null;

beforeEach(() => window.localStorage.clear());
afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
});

const DATE = "2026-08-11";

function event(title: string): CalendarEventDto {
  return {
    id: title,
    title,
    start: `${DATE}T09:00:00+02:00`,
    end: `${DATE}T09:30:00+02:00`,
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

function dayState(): CalendarDayState {
  return {
    date: DATE,
    googleConfigured: true,
    daySessionId: null,
    sources: [],
    tasks: [],
    summary: null,
    run: null,
    tempo: [],
  };
}

/** A settled controller; each test moves only the state it is about. */
function controller(
  overrides: Partial<CalendarController> = {},
): CalendarController {
  const events = overrides.events ?? ready<CalendarEventDto[]>([]);
  const shown =
    events.status === "idle" || events.status === "loading"
      ? []
      : (events.data ?? []);
  return {
    view: "day",
    selectedDate: DATE,
    events,
    eventsByDay: groupEventsByDay(shown, "Europe/Berlin"),
    worklogs: idle(),
    worklogsByDay: new Map(),
    day: ready(dayState()),
    dayState: dayState(),
    selectedEvent: null,
    setView: () => {},
    goPrev: () => {},
    goNext: () => {},
    goToday: () => {},
    selectDay: () => {},
    openDay: () => {},
    selectEvent: () => {},
    refreshEvents: () => {},
    refreshWorklogs: () => {},
    refreshDay: () => {},
    ...overrides,
  };
}

function page(calendar: CalendarController): string {
  return renderToStaticMarkup(
    <CalendarPage
      calendar={calendar}
      prefs={
        {
          calendarShowWeekends: true,
          calendarShowTempo: true,
          calendarHourPx: 44,
        } as Prefs
      }
      onUpdatePrefs={() => {}}
      onFocusDay={() => {}}
    />,
  );
}

function panel(calendar: CalendarController): string {
  return renderToStaticMarkup(
    <CalendarDetailPanel
      calendar={calendar}
      hasDaySession={false}
      onOpenDaySession={() => {}}
      onNewSession={() => {}}
      onLogTime={() => {}}
      onOpenReport={() => {}}
      scanProgress={null}
      onScan={() => {}}
      onOpenTask={() => {}}
    />,
  );
}

describe("CalendarPage", () => {
  it("keeps the entries under the error note when the fetch fails", () => {
    const html = page(
      controller({ events: failed("network down", [event("Standup")]) }),
    );
    expect(html).toContain('role="alert"');
    expect(html).toContain("Could not load calendar events: network down");
    // R2: the failure is a note OVER the calendar, not instead of it.
    expect(html).toContain("Standup");
  });

  it("marks a refresh without hiding what is on screen", () => {
    const html = page(controller({ events: refreshing([event("Standup")]) }));
    expect(html).toContain("Refreshing events");
    expect(html).toContain("Standup");
  });

  it("says the Tempo overlay failed instead of showing no overlay", () => {
    const html = page(
      controller({
        events: ready([event("Standup")]),
        worklogs: failed("tempo unauthorized"),
      }),
    );
    expect(html).toContain(
      "Could not load logged Tempo time: tempo unauthorized",
    );
  });
});

describe("CalendarDetailPanel", () => {
  it("keeps an attendee row mounted when the attendee has no identity fields", () => {
    const selectedEvent = (): CalendarEventDto => ({
      ...event("Planning"),
      attendees: [
        {
          name: null,
          email: null,
          self: false,
          optional: false,
          organizer: false,
          response: null,
        },
      ],
      attendeeCount: 1,
    });
    const renderPanel = () => {
      if (!container) {
        container = document.createElement("div");
        document.body.appendChild(container);
        root = createRoot(container);
      }
      act(() =>
        root!.render(
          <CalendarDetailPanel
            calendar={controller({ selectedEvent: selectedEvent() })}
            hasDaySession={false}
            onOpenDaySession={() => {}}
            onNewSession={() => {}}
            onLogTime={() => {}}
            onOpenReport={() => {}}
            scanProgress={null}
            onScan={() => {}}
            onOpenTask={() => {}}
          />,
        ),
      );
      return container;
    };

    const host = renderPanel();
    const attendeeRow = host
      .querySelector('[title="no response"]')
      ?.closest("div");
    expect(attendeeRow).not.toBeNull();
    renderPanel();
    expect(host.querySelector('[title="no response"]')?.closest("div")).toBe(
      attendeeRow,
    );
  });

  it("reserves the report while the day loads instead of hinting at a scan", () => {
    const html = panel(controller({ day: loading(), dayState: null }));
    expect(html).toContain('aria-label="Loading the day report"');
    expect(html).toContain("animate-pulse");
    expect(html).not.toContain("Scan this day to build");
  });

  it("reports a day that failed to load", () => {
    const html = panel(
      controller({ day: failed("day read-model unavailable"), dayState: null }),
    );
    expect(html).toContain(
      "Could not load this day: day read-model unavailable",
    );
    // A failure never reads as a day with nothing on it.
    expect(html).not.toContain("Scan this day to build");
  });

  it("keeps the day on screen while it refreshes", () => {
    const html = panel(controller({ day: refreshing(dayState()) }));
    expect(html).toContain("Refreshing the day");
    expect(html).toContain("Scan this day to build");
  });
});
