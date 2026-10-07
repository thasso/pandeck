import type { Meta, StoryObj } from "@storybook/react-vite";
import type { CalendarEventDto } from "@assistant/shared";
import type { CalendarController } from "../../../src/hooks/useCalendar.ts";
import type { Prefs } from "../../../src/hooks/usePrefs.ts";
import { ready } from "../../../src/lib/loadState.ts";
import { CalendarPage } from "../../../src/components/calendar/CalendarPage.tsx";

const events: CalendarEventDto[] = [
  {
    id: "planning",
    title: "Backlog planning",
    start: "2025-02-12T10:00:00-08:00",
    end: "2025-02-12T10:45:00-08:00",
    allDay: false,
    status: "confirmed",
    htmlLink: null,
    location: "Studio room",
    description: null,
    meetingUrl: null,
    conferenceLinks: [],
    organizer: "Alex",
    selfResponse: "accepted",
    attendees: [],
    attendeeCount: 3,
    hasMinutesAttachment: false,
    transparency: "opaque",
  },
  {
    id: "release",
    title: "Release review",
    start: "2025-02-14",
    end: "2025-02-15",
    allDay: true,
    status: "confirmed",
    htmlLink: null,
    location: null,
    description: null,
    meetingUrl: null,
    conferenceLinks: [],
    organizer: null,
    selfResponse: "accepted",
    attendees: [],
    attendeeCount: 0,
    hasMinutesAttachment: false,
    transparency: "opaque",
  },
];

function calendar(view: "month" | "week"): CalendarController {
  const eventsByDay = new Map<string, CalendarEventDto[]>([
    ["2025-02-12", [events[0]!]],
    ["2025-02-14", [events[1]!]],
  ]);
  return {
    view,
    selectedDate: "2025-02-12",
    events: ready(events),
    eventsByDay,
    worklogs: ready([]),
    worklogsByDay: new Map(),
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
  };
}

const meta = {
  title: "Tasks/Calendar",
  component: CalendarPage,
  args: {
    calendar: calendar("month"),
    prefs: {
      calendarShowWeekends: true,
      calendarShowTempo: true,
      calendarHourPx: 44,
    } as Prefs,
    onUpdatePrefs: () => {},
    onFocusDay: () => {},
  },
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof CalendarPage>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Month: Story = {};
export const Week: Story = { args: { calendar: calendar("week") } };
