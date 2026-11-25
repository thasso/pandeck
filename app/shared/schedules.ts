/**
 * Schedules: a prompt sent at a wall-clock time, once or repeating
 * (`docs/schedules.md`). This module is the shared model and the ONE
 * recurrence implementation, {@link nextOccurrencesAfter}: the server's
 * schedule clock arms with it, and the web and the agent tools preview with it.
 */
import { clampInt } from "./memoryValidation.ts";
import {
  addDaysToDate,
  localDateOf,
  localWallTimeMs,
  wallClockMs,
} from "./zonedTime.ts";

const ISO_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME_OF_DAY_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

/** Weekdays in ISO order, Monday first. */
export const SCHEDULE_WEEKDAYS = [
  "mon",
  "tue",
  "wed",
  "thu",
  "fri",
  "sat",
  "sun",
] as const;
export type ScheduleWeekday = (typeof SCHEDULE_WEEKDAYS)[number];

/** A local wall-clock time (`HH:MM`) in an explicit IANA zone. */
interface ScheduleWallClock {
  time: string;
  timeZone: string;
}

/**
 * The inclusive local dates (`YYYY-MM-DD`) a repeating Schedule runs between:
 * `startsOn` is the first date that may occur, `endsOn` the last.
 */
interface ScheduleRepeatWindow {
  startsOn?: string;
  endsOn?: string;
}

/**
 * When a Schedule occurs. Every time is a local wall-clock time in the
 * Schedule's own zone, so 11:00 stays 11:00 across a daylight-saving change.
 */
export type ScheduleTiming =
  | ({ kind: "once"; date: string } & ScheduleWallClock)
  | ({ kind: "daily" } & ScheduleWallClock & ScheduleRepeatWindow)
  /** Monday to Friday. */
  | ({ kind: "weekdays" } & ScheduleWallClock & ScheduleRepeatWindow)
  | ({ kind: "weekly"; days: ScheduleWeekday[] } & ScheduleWallClock &
      ScheduleRepeatWindow)
  /** Day 29–31 occurs on the month's last day when the month is shorter. */
  | ({ kind: "monthly"; day: number } & ScheduleWallClock &
      ScheduleRepeatWindow);

/**
 * Where an occurrence goes. Phase 1 targets an existing session only; the
 * new-session target ([Task-1501](pa://task/1501)) joins this union.
 */
export type ScheduleTarget = { kind: "session"; sessionId: string };

/** Who created a Schedule, or who may change it without a card. */
export type ScheduleActor =
  { kind: "user" } | { kind: "session"; sessionId: string };

/** `claimed` is the one open state: the occurrence is owed. */
export const SCHEDULE_OCCURRENCE_STATES = [
  "claimed",
  "delivered",
  "started",
  "superseded",
  "withdrawn",
  "failed",
  "missed",
] as const;
export type ScheduleOccurrenceState =
  (typeof SCHEDULE_OCCURRENCE_STATES)[number];
export type ScheduleTerminalState = Exclude<ScheduleOccurrenceState, "claimed">;

/** One due time of a Schedule and what became of it. */
export interface ScheduleOccurrenceSummary {
  id: string;
  scheduleId: string;
  state: ScheduleOccurrenceState;
  /** The scheduled instant, never the delivery time. */
  dueAtMs: number;
  /** Absent for an occurrence recorded `missed` without being claimed. */
  claimedAtMs?: number;
  /** When it reached its terminal state. */
  endedAtMs?: number;
  /** The session it was delivered to or started, once known. */
  sessionId?: string;
  error?: string;
}

/** A Schedule as lists and the live projection show it. */
export interface ScheduleSummary {
  id: string;
  name: string;
  prompt: string;
  enabled: boolean;
  timing: ScheduleTiming;
  target: ScheduleTarget;
  createdBy: ScheduleActor;
  controlledBy: ScheduleActor;
  /** Created by an agent without a card; counts toward its cardless limit. */
  cardless: boolean;
  /** The next instant the clock claims; absent while disabled or when none is left. */
  nextDueAtMs?: number;
  /** When the Schedule became `done`: it can produce nothing more and its last occurrence is terminal. */
  doneAtMs?: number;
  createdAtMs: number;
  updatedAtMs: number;
  lastOccurrence?: ScheduleOccurrenceSummary;
}

/** The Schedules settings section ([Task-1499](pa://task/1499)). */
export interface ScheduleSettings {
  /** How late an occurrence found after downtime may still be claimed. */
  graceWindowMinutes: number;
  /** Active Schedules one session may control that it created without a card. */
  cardlessLimit: number;
  /**
   * Pause all: the clock claims nothing; due times pass as `missed`. Stored by
   * the schedule store; projected here.
   */
  paused: boolean;
}

export const DEFAULT_SCHEDULE_SETTINGS: ScheduleSettings = {
  graceWindowMinutes: 60,
  cardlessLimit: 10,
  paused: false,
};

/** The accepted range of each numeric field, shared with the registry. */
export const SCHEDULE_SETTINGS_RANGES = {
  graceWindowMinutes: { min: 0, max: 1440 },
  cardlessLimit: { min: 0, max: 100 },
} as const;

/**
 * A stored or client-supplied section made usable: an out-of-range number is
 * clamped, anything non-numeric or non-boolean falls back to the default.
 */
export function normalizeScheduleSettings(
  settings: Partial<ScheduleSettings> | undefined,
): ScheduleSettings {
  const range = SCHEDULE_SETTINGS_RANGES;
  return {
    graceWindowMinutes: clampInt(
      settings?.graceWindowMinutes,
      range.graceWindowMinutes.min,
      range.graceWindowMinutes.max,
      DEFAULT_SCHEDULE_SETTINGS.graceWindowMinutes,
    ),
    cardlessLimit: clampInt(
      settings?.cardlessLimit,
      range.cardlessLimit.min,
      range.cardlessLimit.max,
      DEFAULT_SCHEDULE_SETTINGS.cardlessLimit,
    ),
    paused:
      typeof settings?.paused === "boolean"
        ? settings.paused
        : DEFAULT_SCHEDULE_SETTINGS.paused,
  };
}

function isCalendarDate(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const match = ISO_DATE_RE.exec(value);
  if (!match) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return (
    !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value
  );
}

function isTimeZone(value: unknown): value is string {
  if (typeof value !== "string" || !value) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

/** Why `timing` is not a valid {@link ScheduleTiming}, or null. */
export function scheduleTimingError(timing: unknown): string | null {
  if (typeof timing !== "object" || timing === null)
    return "timing must be an object";
  const value = timing as Record<string, unknown>;
  if (typeof value.time !== "string" || !TIME_OF_DAY_RE.test(value.time))
    return "timing.time must be HH:MM (24-hour)";
  if (!isTimeZone(value.timeZone))
    return "timing.timeZone must be an IANA time zone";
  switch (value.kind) {
    case "once":
      return isCalendarDate(value.date)
        ? null
        : "timing.date must be a YYYY-MM-DD date";
    case "daily":
    case "weekdays":
      break;
    case "weekly": {
      const days = value.days;
      if (
        !Array.isArray(days) ||
        days.length === 0 ||
        !days.every((day) =>
          (SCHEDULE_WEEKDAYS as readonly unknown[]).includes(day),
        ) ||
        new Set(days).size !== days.length
      )
        return `timing.days must be distinct weekdays (${SCHEDULE_WEEKDAYS.join(", ")})`;
      break;
    }
    case "monthly":
      if (
        typeof value.day !== "number" ||
        !Number.isInteger(value.day) ||
        value.day < 1 ||
        value.day > 31
      )
        return "timing.day must be a whole number from 1 to 31";
      break;
    default:
      return "timing.kind must be once, daily, weekdays, weekly or monthly";
  }
  for (const key of ["startsOn", "endsOn"] as const)
    if (value[key] !== undefined && !isCalendarDate(value[key]))
      return `timing.${key} must be a YYYY-MM-DD date`;
  if (
    typeof value.startsOn === "string" &&
    typeof value.endsOn === "string" &&
    value.startsOn > value.endsOn
  )
    return "timing.endsOn must not be before timing.startsOn";
  return null;
}

/**
 * `timing` in its one stored form: only the keys of its kind, in a fixed
 * order, `days` in {@link SCHEDULE_WEEKDAYS} order, and an absent optional
 * date omitted. `timing` must be valid ({@link scheduleTimingError}).
 */
export function canonicalScheduleTiming(
  timing: ScheduleTiming,
): ScheduleTiming {
  const clock = { time: timing.time, timeZone: timing.timeZone };
  if (timing.kind === "once")
    return { kind: "once", date: timing.date, ...clock };
  const window = {
    ...(timing.startsOn !== undefined ? { startsOn: timing.startsOn } : {}),
    ...(timing.endsOn !== undefined ? { endsOn: timing.endsOn } : {}),
  };
  switch (timing.kind) {
    case "daily":
    case "weekdays":
      return { kind: timing.kind, ...clock, ...window };
    case "weekly":
      return {
        kind: "weekly",
        days: SCHEDULE_WEEKDAYS.filter((day) => timing.days.includes(day)),
        ...clock,
        ...window,
      };
    case "monthly":
      return { kind: "monthly", day: timing.day, ...clock, ...window };
  }
}

/** Whether two valid timings describe the same occurrences, key order aside. */
export function scheduleTimingsEqual(
  a: ScheduleTiming,
  b: ScheduleTiming,
): boolean {
  return (
    JSON.stringify(canonicalScheduleTiming(a)) ===
    JSON.stringify(canonicalScheduleTiming(b))
  );
}

/** ISO weekday of a calendar date; zone-free. */
function weekdayOf(date: string): ScheduleWeekday {
  // getUTCDay: 0 = Sunday.
  return SCHEDULE_WEEKDAYS[
    (new Date(`${date}T00:00:00Z`).getUTCDay() + 6) % 7
  ]!;
}

function lastDayOfMonth(date: string): number {
  const year = Number(date.slice(0, 4));
  const month = Number(date.slice(5, 7));
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** Whether `timing` repeats on local calendar `date` (window aside). */
function occursOn(timing: ScheduleTiming, date: string): boolean {
  switch (timing.kind) {
    case "once":
      return date === timing.date;
    case "daily":
      return true;
    case "weekdays": {
      const day = weekdayOf(date);
      return day !== "sat" && day !== "sun";
    }
    case "weekly":
      return timing.days.includes(weekdayOf(date));
    case "monthly":
      return (
        Number(date.slice(8, 10)) === Math.min(timing.day, lastDayOfMonth(date))
      );
  }
}

/**
 * A pattern that matches no date at all would scan forever; every valid one
 * matches within a month, so a scan this long without a match has none left.
 */
const MAX_DAYS_WITHOUT_MATCH = 400;

/**
 * The next `n` due instants of `timing` strictly after `afterMs`, ascending.
 *
 * Each due instant is the local wall-clock `time` on a matching local date in
 * `timing.timeZone`: a time the date skips (spring forward) occurs when the gap
 * ends, a time it repeats (fall back) once, at the first pass. `startsOn` and
 * `endsOn` are inclusive local dates. Fewer than `n` come back when the timing
 * runs out, none for a `once` already past.
 */
export function nextOccurrencesAfter(
  timing: ScheduleTiming,
  afterMs: number,
  n: number,
): number[] {
  const out: number[] = [];
  if (n <= 0) return out;
  const { time, timeZone } = timing;
  const window: ScheduleRepeatWindow = timing.kind === "once" ? {} : timing;
  // A gap at the end of a local day moves that day's time onto the next one,
  // so the day before afterMs's local date may still hold a later instant.
  let date = addDaysToDate(localDateOf(afterMs, timeZone), -1);
  if (timing.kind === "once" && date < timing.date) date = timing.date;
  if (window.startsOn && date < window.startsOn) date = window.startsOn;
  let sinceMatch = 0;
  while (out.length < n && sinceMatch <= MAX_DAYS_WITHOUT_MATCH) {
    if (window.endsOn && date > window.endsOn) break;
    if (timing.kind === "once" && date > timing.date) break;
    if (occursOn(timing, date)) {
      sinceMatch = 0;
      const dueAtMs = localWallTimeMs(date, time, timeZone);
      if (dueAtMs > afterMs && dueAtMs > (out.at(-1) ?? -Infinity))
        out.push(dueAtMs);
    } else sinceMatch += 1;
    date = addDaysToDate(date, 1);
  }
  return out;
}

const FORMAT_WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const FORMAT_MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

const pad2 = (value: number) => String(value).padStart(2, "0");

/**
 * The local wall clock of `atMs` in `timeZone`, field by field. Fixed English
 * names, so the text never depends on the host's locale data.
 */
function scheduleWallClock(atMs: number, timeZone: string) {
  const wall = new Date(wallClockMs(atMs, timeZone));
  return {
    weekday: FORMAT_WEEKDAYS[wall.getUTCDay()]!,
    day: wall.getUTCDate(),
    month: FORMAT_MONTHS[wall.getUTCMonth()]!,
    year: wall.getUTCFullYear(),
    time: `${pad2(wall.getUTCHours())}:${pad2(wall.getUTCMinutes())}`,
    offsetMinutes: Math.round((wall.getTime() - atMs) / 60_000),
  };
}

/**
 * A due time as the scheduled-prompt header shows it, in the occurrence's
 * frozen zone, without the year: `Wed 25 Nov 15:45`.
 */
export function formatScheduleDue(dueAtMs: number, timeZone: string): string {
  const wall = scheduleWallClock(dueAtMs, timeZone);
  return `${wall.weekday} ${wall.day} ${wall.month} ${wall.time}`;
}

/**
 * An absolute instant with its zone and UTC offset, so a repeated wall time
 * of a fall-back night stays unambiguous:
 * `Wed 25 Nov 2026 15:45 Europe/Berlin (UTC+01:00)`.
 */
export function formatScheduleInstant(atMs: number, timeZone: string): string {
  const wall = scheduleWallClock(atMs, timeZone);
  const offset = Math.abs(wall.offsetMinutes);
  const sign = wall.offsetMinutes < 0 ? "-" : "+";
  return `${wall.weekday} ${wall.day} ${wall.month} ${wall.year} ${wall.time} ${timeZone} (UTC${sign}${pad2(Math.floor(offset / 60))}:${pad2(offset % 60)})`;
}
