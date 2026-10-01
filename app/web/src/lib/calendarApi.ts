import type {
  CalendarDayState,
  CalendarDayTempoRow,
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

async function postJson<T>(path: string): Promise<T> {
  const res = await fetch(`${serverHttpOrigin()}${path}`, {
    method: "POST",
    headers: { ...authHeaders() },
  });
  const text = await res.text();
  const body = text ? JSON.parse(text) : {};
  if (!res.ok && res.status !== 409)
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

/** Read-model (processed sources + linked CL tasks + summary + tempo) for one day. */
export function fetchDayState(date: string): Promise<CalendarDayState> {
  return getJson<CalendarDayState>(
    `/api/calendar/day?date=${encodeURIComponent(date)}`,
  );
}

/** Own logged Tempo worklogs over a user-local date range, for the calendar overlay. */
export function fetchCalendarWorklogs(
  from: string,
  to: string,
): Promise<CalendarWorklogsResponse> {
  const params = new URLSearchParams({ from, to });
  return getJson<CalendarWorklogsResponse>(`/api/calendar/worklogs?${params}`);
}

export interface TempoActionResult {
  ok: boolean;
  row: CalendarDayTempoRow | null;
  error?: string;
}

/** Approve one Tempo proposal → drives the state machine + the real Tempo write. */
export function approveTempoRow(
  date: string,
  rowId: string,
): Promise<TempoActionResult> {
  return postJson<TempoActionResult>(
    `/api/calendar/day/tempo/approve?date=${encodeURIComponent(date)}&rowId=${encodeURIComponent(rowId)}`,
  );
}

/** Decline one Tempo proposal — the user's deliberate "don't log this" (Task 144). */
export function declineTempoRow(
  date: string,
  rowId: string,
): Promise<TempoActionResult> {
  return postJson<TempoActionResult>(
    `/api/calendar/day/tempo/decline?date=${encodeURIComponent(date)}&rowId=${encodeURIComponent(rowId)}`,
  );
}
