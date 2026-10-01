import type { CalendarEventsResponse } from "@assistant/shared";
import { listCalendarEventsForUi } from "./tools/google/googleCalendarTools.ts";

/**
 * Read-only listing of the primary Google Calendar over a bounded RFC3339
 * range, shaped for the web calendar grid. v1 reads only the primary calendar
 * (see the calendar-view scope decision); multi-calendar selection is a future
 * extension that would parameterize `calendarId`.
 */
export async function getCalendarEvents(params: {
  from: string;
  to: string;
}): Promise<CalendarEventsResponse> {
  const result = await listCalendarEventsForUi({
    from: params.from,
    to: params.to,
    calendarId: "primary",
  });
  return {
    from: params.from,
    to: params.to,
    calendarId: result.calendarId,
    calendarSummary: result.calendarSummary,
    timeZone: result.timeZone,
    events: result.events,
  };
}
