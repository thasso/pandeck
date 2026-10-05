import type {
  CalendarEventsResponse,
  CalendarWorklogsResponse,
} from "@assistant/shared";
import { authHeaders, serverHttpOrigin } from "./serverOrigin.ts";

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(`${serverHttpOrigin()}${path}`, {
    headers: { ...authHeaders() },
  });
  const text = await res.text();
  const body = text ? JSON.parse(text) : {};
  if (!res.ok)
    throw new Error(
      (body as { error?: string }).error ??
        `Request failed (HTTP ${res.status}).`,
    );
  return body as T;
}

/** Read-only primary-calendar events over an RFC3339 range. */
export function fetchCalendarEvents(
  from: string,
  to: string,
): Promise<CalendarEventsResponse> {
  const params = new URLSearchParams({ from, to });
  return getJson<CalendarEventsResponse>(`/api/calendar/events?${params}`);
}

/** Own logged Tempo worklogs over a user-local date range, for the calendar overlay. */
export function fetchCalendarWorklogs(
  from: string,
  to: string,
): Promise<CalendarWorklogsResponse> {
  const params = new URLSearchParams({ from, to });
  return getJson<CalendarWorklogsResponse>(`/api/calendar/worklogs?${params}`);
}
