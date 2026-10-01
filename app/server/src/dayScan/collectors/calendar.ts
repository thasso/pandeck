import { isGoogleConfigured } from "../../googleSettings.ts";
import { getCalendarEvents } from "../../calendarService.ts";
import type {
  CollectorOutput,
  DayCollectContext,
  DaySourceCollector,
  DaySourceFact,
} from "../types.ts";

/**
 * Calendar source facts. Semantics (plan contract): presence ≠ attendance.
 * Facts keep the DISTINCT response state (accepted/tentative/needsAction/
 * declined) and no attendee list (count only — privacy filter). Temporal state
 * (past/ongoing/future) is derived at read time, never stored (volatile).
 * A cancelled event status is positive deletion evidence.
 *
 * ATTENDANCE is NOT derived here (Task 173): actual Meet attendance — including
 * ad-hoc calls with no calendar event — lives in the dedicated `meet-attendance`
 * source (`collectors/meetAttendance.ts`), which lists the day's Meet conference
 * records directly. This collector stays a faithful listing of scheduled events.
 */
export const calendarCollector: DaySourceCollector = {
  key: "calendar",
  label: "Calendar",
  readiness() {
    return isGoogleConfigured()
      ? { ready: true }
      : {
          ready: false,
          reason: "unconfigured",
          detail: "Google Workspace is not connected",
        };
  },
  async collect(ctx: DayCollectContext): Promise<CollectorOutput> {
    const response = await getCalendarEvents({
      from: ctx.window.startIso,
      to: ctx.window.endIso,
    });
    ctx.cache.writeJson(ctx.date, "calendar-raw", response);
    const observedAt = new Date().toISOString();
    const confirmedDeletedIds: string[] = [];
    const facts: DaySourceFact[] = [];
    for (const event of response.events) {
      if (event.status === "cancelled") {
        confirmedDeletedIds.push(`cal:${event.id}`);
        continue;
      }
      facts.push({
        id: `cal:${event.id}`,
        kind: "event",
        occurredAt: event.start,
        observedAt,
        actor: event.organizer,
        title: event.title,
        links: event.htmlLink ? [event.htmlLink] : [],
        data: {
          start: event.start,
          end: event.end,
          allDay: event.allDay,
          selfResponse: event.selfResponse,
          attendeeCount: event.attendeeCount,
          hasMinutesAttachment: event.hasMinutesAttachment,
          meetingUrl: event.meetingUrl,
          transparency: event.transparency,
        },
        tags: [
          "event",
          ...(event.selfResponse ? [`response:${event.selfResponse}`] : []),
        ],
      });
    }
    return {
      // The Google events list for a bounded window is complete by contract.
      result: "complete",
      facts,
      confirmedDeletedIds,
      completeness: {
        window: `${ctx.window.startIso}..${ctx.window.endIso}`,
        calendar: response.calendarId,
      },
    };
  },
};
