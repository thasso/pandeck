import type { CalendarEventDto } from "@assistant/shared";
import { localDayStartMs } from "@assistant/shared/zonedTime";

/**
 * Calendar date helpers. Day-bucketing and time formatting happen in the
 * user's timezone (`settings.profile.effectiveTimeZone`, the same zone the
 * server resolves days in) regardless of the browser's local zone, so every
 * zone-dependent helper takes it explicitly. "Date strings" are always
 * YYYY-MM-DD.
 */
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}/;

const formatterCache = new Map<string, Intl.DateTimeFormat>();

/** One formatter per (locale, options, zone): constructing them is not cheap. */
function formatter(
  locale: string,
  options: Intl.DateTimeFormatOptions,
  timeZone: string,
): Intl.DateTimeFormat {
  const key = `${locale}|${timeZone}|${JSON.stringify(options)}`;
  let fmt = formatterCache.get(key);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat(locale, { ...options, timeZone });
    formatterCache.set(key, fmt);
  }
  return fmt;
}

const DAY_KEY_OPTIONS: Intl.DateTimeFormatOptions = {
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
};
const HM_OPTIONS: Intl.DateTimeFormatOptions = {
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
};

/** Today's user-local date as YYYY-MM-DD. */
export function todayIso(timeZone: string): string {
  return formatter("en-CA", DAY_KEY_OPTIONS, timeZone).format(new Date());
}

/** User-local YYYY-MM-DD for an event start/end (handles all-day date strings). */
export function dayKey(value: string | null, timeZone: string): string {
  if (!value) return "";
  if (ISO_DATE_RE.test(value) && value.length === 10) return value;
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value.slice(0, 10)
    : formatter("en-CA", DAY_KEY_OPTIONS, timeZone).format(date);
}

/** User-local HH:MM for a timed event. */
export function hm(value: string | null, timeZone: string): string {
  if (!value) return "";
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? ""
    : formatter("de-DE", HM_OPTIONS, timeZone).format(date);
}

/** User-local minutes since midnight (0-1439) for a timed value. */
export function minutesOfDay(value: string | null, timeZone: string): number {
  if (!value) return 0;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 0;
  const parts = formatter("en-GB", HM_OPTIONS, timeZone).formatToParts(date);
  const h = Number(parts.find((p) => p.type === "hour")?.value ?? "0");
  const m = Number(parts.find((p) => p.type === "minute")?.value ?? "0");
  return (h % 24) * 60 + m;
}

/** Whether two ISO instants fall on the same user-local day. */
export function sameDay(
  a: string | null,
  b: string | null,
  timeZone: string,
): boolean {
  return Boolean(a && b && dayKey(a, timeZone) === dayKey(b, timeZone));
}

/** Add days to a YYYY-MM-DD string (TZ-stable via UTC arithmetic). */
export function addDays(dateIso: string, days: number): string {
  const date = new Date(`${dateIso}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

export function addMonths(dateIso: string, months: number): string {
  const [y, m, d] = dateIso.split("-").map(Number);
  const date = new Date(Date.UTC(y!, m! - 1 + months, 1));
  const lastDay = new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0),
  ).getUTCDate();
  date.setUTCDate(Math.min(d!, lastDay));
  return date.toISOString().slice(0, 10);
}

/** ISO weekday 1 (Mon) .. 7 (Sun) for a date string. */
export function isoWeekday(dateIso: string): number {
  const day = new Date(`${dateIso}T00:00:00Z`).getUTCDay();
  return day === 0 ? 7 : day;
}

/** Monday of the week containing the date. */
function startOfWeek(dateIso: string): string {
  return addDays(dateIso, -(isoWeekday(dateIso) - 1));
}

function isWeekend(dateIso: string): boolean {
  return isoWeekday(dateIso) >= 6;
}

/** The day strings for the week containing the date (Mon..Sun, or Mon..Fri). */
export function weekDays(dateIso: string, includeWeekends = true): string[] {
  const monday = startOfWeek(dateIso);
  const days = Array.from({ length: 7 }, (_, i) => addDays(monday, i));
  return includeWeekends ? days : days.filter((day) => !isWeekend(day));
}

/** 6 weeks covering the month containing the date (Mon-first grid; weekends optional). */
export function monthMatrix(
  dateIso: string,
  includeWeekends = true,
): string[][] {
  const [y, m] = dateIso.split("-").map(Number);
  const first = `${y}-${String(m).padStart(2, "0")}-01`;
  const gridStart = startOfWeek(first);
  const weeks: string[][] = [];
  for (let w = 0; w < 6; w++) {
    const row = Array.from({ length: 7 }, (_, i) =>
      addDays(gridStart, w * 7 + i),
    );
    weeks.push(includeWeekends ? row : row.filter((day) => !isWeekend(day)));
  }
  return weeks;
}

/** User-local midnight ISO instant for a date string (shared, DST-verified), for range bounds. */
function localMidnightIso(dateIso: string, timeZone: string): string {
  return new Date(localDayStartMs(dateIso, timeZone)).toISOString();
}

export type CalendarView = "month" | "week" | "day";

/** RFC3339 [from,to) bounds covering the visible range for a view + anchor. */
export function rangeForView(
  view: CalendarView,
  anchorIso: string,
  timeZone: string,
): { from: string; to: string } {
  if (view === "day")
    return {
      from: localMidnightIso(anchorIso, timeZone),
      to: localMidnightIso(addDays(anchorIso, 1), timeZone),
    };
  if (view === "week") {
    const days = weekDays(anchorIso);
    return {
      from: localMidnightIso(days[0]!, timeZone),
      to: localMidnightIso(addDays(days[6]!, 1), timeZone),
    };
  }
  const grid = monthMatrix(anchorIso);
  return {
    from: localMidnightIso(grid[0]![0]!, timeZone),
    to: localMidnightIso(addDays(grid[5]![6]!, 1), timeZone),
  };
}

// Labels format a DATE string (anchored at noon UTC), not an instant, so they
// render in UTC: no zone may shift the day they name.
const fullDateFmt = new Intl.DateTimeFormat("en-GB", {
  timeZone: "UTC",
  weekday: "long",
  day: "numeric",
  month: "long",
  year: "numeric",
});
const monthFmt = new Intl.DateTimeFormat("en-GB", {
  timeZone: "UTC",
  month: "long",
  year: "numeric",
});
const weekdayFmt = new Intl.DateTimeFormat("en-GB", {
  timeZone: "UTC",
  weekday: "short",
});

function noonUtc(dateIso: string): Date {
  return new Date(`${dateIso}T12:00:00Z`);
}

/** e.g. "Monday, 29 June 2026". */
export function formatFullDate(dateIso: string): string {
  return fullDateFmt.format(noonUtc(dateIso));
}

/** e.g. "June 2026". */
export function monthLabel(dateIso: string): string {
  return monthFmt.format(noonUtc(dateIso));
}

export function shortWeekday(dateIso: string): string {
  return weekdayFmt.format(noonUtc(dateIso));
}

export function dayOfMonth(dateIso: string): number {
  return Number(dateIso.split("-")[2]);
}

/** Group events into day buckets keyed by user-local YYYY-MM-DD, sorted by start. */
export function groupEventsByDay(
  events: CalendarEventDto[],
  timeZone: string,
): Map<string, CalendarEventDto[]> {
  const map = new Map<string, CalendarEventDto[]>();
  for (const event of events) {
    const key = dayKey(event.start, timeZone);
    if (!key) continue;
    const list = map.get(key) ?? [];
    list.push(event);
    map.set(key, list);
  }
  for (const list of map.values()) list.sort(compareEvents);
  return map;
}

function compareEvents(a: CalendarEventDto, b: CalendarEventDto): number {
  if (a.allDay !== b.allDay) return a.allDay ? -1 : 1;
  return String(a.start ?? "").localeCompare(String(b.start ?? ""));
}
