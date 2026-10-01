import {
  localDateOf as sharedLocalDateOf,
  localDayBoundsMs,
} from "@assistant/shared/zonedTime";
import { userTimeZone } from "./userProfile.ts";

/** RFC3339 [from, to) bounds of a local calendar day in `timeZone`. */
export function localDayRange(
  date: string,
  timeZone = userTimeZone(),
): { from: string; to: string } {
  const { startMs, endMs } = localDayBoundsMs(date, timeZone);
  return {
    from: new Date(startMs).toISOString(),
    to: new Date(endMs).toISOString(),
  };
}

/** The local calendar date (YYYY-MM-DD) an instant falls on in `timeZone`. */
export function localDateOf(value: string, timeZone = userTimeZone()): string {
  return sharedLocalDateOf(Date.parse(value), timeZone);
}

/** An instant as a local "DD.MM.YYYY, HH:MM" wall-clock string in `timeZone`. */
export function formatLocalDateTime(
  value: string | null | undefined,
  timeZone = userTimeZone(),
): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("de-DE", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);
}

export function normalizeRfc3339(value: string, field: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime()))
    throw new Error(`${field} must be an RFC3339 date/time.`);
  return date.toISOString();
}
