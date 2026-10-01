/**
 * DST-correct local-day windows. A "day" is the user's local calendar day
 * (the profile timezone by default), so a 23h/25h DST-transition day maps to
 * the correct UTC range instead of a naive +24h.
 */

import {
  addDaysToDate,
  localDateOf,
  localDayBoundsMs,
  localWallTimeMs as sharedLocalWallTimeMs,
} from "@assistant/shared/zonedTime";
import { userTimeZone } from "../userProfile.ts";

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export interface DayWindow {
  date: string;
  timeZone: string;
  startMs: number;
  endMs: number;
  startIso: string;
  endIso: string;
}

/** The calendar date that follows `date` (YYYY-MM-DD). */
export function nextDate(date: string): string {
  return addDaysToDate(date, 1);
}

/** The local calendar date (YYYY-MM-DD) an instant falls on in a zone. */
export function localDateForInstant(
  atMs: number,
  timeZone = userTimeZone(),
): string {
  return localDateOf(atMs, timeZone);
}

/**
 * The UTC instant a local wall-clock time (`HH:MM`) on a calendar date is
 * first reached in a zone (see `@assistant/shared/zonedTime`).
 */
export function localWallTimeMs(
  date: string,
  time: string,
  timeZone = userTimeZone(),
): number {
  return sharedLocalWallTimeMs(date, time, timeZone);
}

export function localDayWindow(
  date: string,
  timeZone = userTimeZone(),
): DayWindow {
  if (!ISO_DATE_RE.test(date)) throw new Error(`Invalid day: ${date}`);
  const { startMs, endMs } = localDayBoundsMs(date, timeZone);
  return {
    date,
    timeZone,
    startMs,
    endMs,
    startIso: new Date(startMs).toISOString(),
    endIso: new Date(endMs).toISOString(),
  };
}

/** True when an ISO timestamp (or ms) falls inside the window. */
export function inWindow(
  window: DayWindow,
  at: string | number | null | undefined,
): boolean {
  if (at === null || at === undefined) return false;
  const ms = typeof at === "number" ? at : Date.parse(at);
  if (!Number.isFinite(ms)) return false;
  return ms >= window.startMs && ms < window.endMs;
}
