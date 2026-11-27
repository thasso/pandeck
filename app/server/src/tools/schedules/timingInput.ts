/**
 * The `at` of a `once` timing as `schedule_manage` accepts it
 * (`docs/schedules.md`, Agent tools), turned into the stored local date and
 * time in the Schedule's zone. Pure: no store, no clock, no profile; the
 * caller passes the zone and the instant it calls "now".
 *
 * - A local date-time (`2026-11-25 15:45`, optional `:SS`) is a wall-clock
 *   reading in the zone. Seconds round up to the next minute. A time the
 *   zone skips stays as given: the recurrence engine
 *   (`nextOccurrencesAfter`) moves it to the end of the gap, and the echo
 *   shows that instant.
 * - An ISO time with an offset or `Z`, and a relative `in 1h30m` (`d` is 24
 *   elapsed hours), are instants. Each rounds up to a whole minute and is read
 *   on the zone's wall clock. A Schedule occurs at the FIRST pass of a
 *   repeated wall time, so an instant on the second pass is refused.
 */
import { localWallTimeMs, wallClockMs } from "@assistant/shared/zonedTime";

const MINUTE_MS = 60_000;
const UNIT_MS = { m: MINUTE_MS, h: 60 * MINUTE_MS, d: 24 * 60 * MINUTE_MS };

const AT_ERROR =
  'timing.at must be a local date-time ("2026-11-25 15:45"), an ISO time with offset, or a relative time ("in 45m", "in 2h", "in 1d").';

const LOCAL_RE = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/;
const OFFSET_RE =
  /^(\d{4}-\d{2}-\d{2})[ T](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?(Z|[+-]\d{2}:?\d{2})$/i;
const RELATIVE_RE = /^in\s+((?:\d+\s*[mhd]\s*)+)$/i;
const RELATIVE_PART_RE = /(\d+)\s*([mhd])/gi;

/** A once timing's stored local reading. */
export interface OnceAt {
  /** `YYYY-MM-DD` */
  date: string;
  /** `HH:MM` */
  time: string;
}

/**
 * `at` as the local date and time a `once` Schedule stores in `timeZone`.
 * Throws the approved `timing.at` error for anything unreadable, and the
 * approved fold error for an instant on the second pass of a repeated time.
 */
export function parseOnceAt(
  at: unknown,
  timeZone: string,
  nowMs: number,
): OnceAt {
  if (typeof at !== "string") throw new Error(AT_ERROR);
  const text = at.trim();
  const local = LOCAL_RE.exec(text);
  if (local) return localReading(local);
  const offset = OFFSET_RE.exec(text);
  if (offset) return instantReading(at, offsetInstant(offset), timeZone);
  const relative = RELATIVE_RE.exec(text);
  if (relative)
    return instantReading(at, nowMs + elapsedMs(relative[1]!), timeZone);
  throw new Error(AT_ERROR);
}

/** Wall-clock fields as a zone-free epoch, or a throw when not a real reading. */
function wallEpoch(
  date: string,
  hour: string,
  minute: string,
  second: string | undefined,
): number {
  const [y, mo, d] = date.split("-").map(Number) as [number, number, number];
  const h = Number(hour);
  const mi = Number(minute);
  const s = second === undefined ? 0 : Number(second);
  if (h > 23 || mi > 59 || s > 59) throw new Error(AT_ERROR);
  const epoch = Date.UTC(y, mo - 1, d, h, mi, s);
  // Date.UTC rolls an impossible date (02-30) over; a real one survives.
  if (new Date(epoch).toISOString().slice(0, 10) !== date)
    throw new Error(AT_ERROR);
  return epoch;
}

function readingOf(wall: number): OnceAt {
  const iso = new Date(wall).toISOString();
  return { date: iso.slice(0, 10), time: iso.slice(11, 16) };
}

function ceilToMinute(ms: number): number {
  return Math.ceil(ms / MINUTE_MS) * MINUTE_MS;
}

function localReading(match: RegExpExecArray): OnceAt {
  const wall = wallEpoch(match[1]!, match[2]!, match[3]!, match[4]);
  return readingOf(ceilToMinute(wall));
}

function offsetInstant(match: RegExpExecArray): number {
  const wall = wallEpoch(match[1]!, match[2]!, match[3]!, match[4]);
  const fraction = match[5] ? Number(`0.${match[5]}`) * 1000 : 0;
  const zone = match[6]!.toUpperCase();
  if (zone === "Z") return wall + fraction;
  const digits = zone.replace(":", "");
  const hours = Number(digits.slice(1, 3));
  const minutes = Number(digits.slice(3, 5));
  if (hours > 23 || minutes > 59) throw new Error(AT_ERROR);
  const sign = digits.startsWith("-") ? -1 : 1;
  return wall + fraction - sign * (hours * 60 + minutes) * MINUTE_MS;
}

function elapsedMs(spec: string): number {
  let total = 0;
  for (const part of spec.matchAll(RELATIVE_PART_RE))
    total += Number(part[1]) * UNIT_MS[part[2]!.toLowerCase() as "m"];
  if (!Number.isSafeInteger(total)) throw new Error(AT_ERROR);
  return total;
}

/**
 * The local reading of an instant, rounded up to its minute. The reading's
 * first instant is the instant itself unless the zone repeats that minute and
 * the instant is its second pass.
 */
function instantReading(at: string, instantMs: number, timeZone: string) {
  const instant = ceilToMinute(instantMs);
  if (!Number.isFinite(instant) || Number.isNaN(new Date(instant).getTime()))
    throw new Error(AT_ERROR);
  const reading = readingOf(wallClockMs(instant, timeZone));
  if (localWallTimeMs(reading.date, reading.time, timeZone) !== instant)
    throw new Error(
      `"${at}" is the repeated ${reading.time} of a daylight-saving change in ${timeZone}; a Schedule occurs at the first one. Pick the earlier offset or another minute.`,
    );
  return reading;
}
