/**
 * Local calendar days and wall-clock times in an arbitrary IANA zone — the ONE
 * implementation server and web share, so both agree on where a user-local
 * day starts and ends.
 *
 * Zones may shift their offset AT midnight: Cuba springs forward at 00:00, so
 * 2026-03-08 00:00 never exists in America/Havana and the day begins at 01:00.
 * Brazil and Chile used to fall back at midnight, so 23:00 of the previous day
 * repeats first. A guess derived from one offset — however often it is
 * re-corrected — cannot tell those apart, so every conversion here is verified.
 */

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
const ISO_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME_OF_DAY_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

const partsFormatters = new Map<string, Intl.DateTimeFormat>();
const dateFormatters = new Map<string, Intl.DateTimeFormat>();

function partsFormatter(timeZone: string): Intl.DateTimeFormat {
  let fmt = partsFormatters.get(timeZone);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    partsFormatters.set(timeZone, fmt);
  }
  return fmt;
}

/** The local wall clock at `atMs` (to the ms), expressed as if it were a UTC instant. */
function wallClockMs(atMs: number, timeZone: string): number {
  const parts: Record<string, number> = {};
  for (const part of partsFormatter(timeZone).formatToParts(new Date(atMs)))
    if (part.type !== "literal") parts[part.type] = Number(part.value);
  return Date.UTC(
    parts.year!,
    parts.month! - 1,
    parts.day!,
    parts.hour! % 24,
    parts.minute!,
    parts.second!,
    // Offsets are whole seconds, so the sub-second part carries over as is.
    ((atMs % 1000) + 1000) % 1000,
  );
}

/** How far the zone's wall clock leads UTC at `atMs`. */
function offsetMs(atMs: number, timeZone: string): number {
  return wallClockMs(atMs, timeZone) - atMs;
}

/** The local calendar date (YYYY-MM-DD) an instant falls on in `timeZone`. */
export function localDateOf(atMs: number, timeZone: string): string {
  let fmt = dateFormatters.get(timeZone);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
    dateFormatters.set(timeZone, fmt);
  }
  return fmt.format(new Date(atMs));
}

/** `date` (YYYY-MM-DD) moved by whole calendar days; zone-free. */
export function addDaysToDate(date: string, days: number): string {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

/**
 * The FIRST instant at which the local wall clock in `timeZone` reads `wall`
 * (a wall-clock reading expressed as if it were UTC), or has passed it. An
 * ambiguous reading (fall-back fold) resolves to its first occurrence; a
 * skipped one (spring-forward gap) to the instant the gap ends.
 *
 * Real zones change offset at most once in any 30 hours, so the offsets in
 * force 15h either side of the naive instant are the only candidates. A
 * candidate counts only if its wall clock really reads the target; when
 * neither does, the target is in a gap and the clock is monotone across it,
 * so a binary search finds where it is first passed.
 */
function firstInstantAtWallClock(wall: number, timeZone: string): number {
  const candidates = [
    wall - offsetMs(wall - 15 * HOUR_MS, timeZone),
    wall - offsetMs(wall + 15 * HOUR_MS, timeZone),
  ].sort((a, b) => a - b);
  const exact = candidates.find(
    (candidate) => wallClockMs(candidate, timeZone) === wall,
  );
  if (exact !== undefined) return exact;
  // In a gap: the earlier candidate's clock is still before the target, the
  // later one's already past it.
  let lo = candidates[0]!;
  let hi = candidates[1]!;
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2);
    if (wallClockMs(mid, timeZone) >= wall) hi = mid;
    else lo = mid;
  }
  return hi;
}

/**
 * The first instant whose local wall clock in `timeZone` reads `date` `time`
 * (HH:MM) or later — see {@link firstInstantAtWallClock} for folds and gaps.
 */
export function localWallTimeMs(
  date: string,
  time: string,
  timeZone: string,
): number {
  const d = ISO_DATE_RE.exec(date);
  if (!d) throw new Error(`Invalid day: ${date}`);
  const t = TIME_OF_DAY_RE.exec(time.trim());
  if (!t) throw new Error(`Invalid time-of-day: ${time}`);
  return firstInstantAtWallClock(
    Date.UTC(
      Number(d[1]),
      Number(d[2]) - 1,
      Number(d[3]),
      Number(t[1]),
      Number(t[2]),
    ),
    timeZone,
  );
}

/**
 * `atMs` moved by whole CALENDAR days in `timeZone`: the same local wall-clock
 * time (to the ms) on the local date `days` away — never a fixed 24h step, so
 * a DST change in between keeps the time of day. A time the target day skips
 * resolves to the end of the gap; a repeated one to its first occurrence.
 */
export function addLocalDays(
  atMs: number,
  days: number,
  timeZone: string,
): number {
  return firstInstantAtWallClock(
    wallClockMs(atMs, timeZone) + days * DAY_MS,
    timeZone,
  );
}

/** The first instant of the local calendar day `date` in `timeZone`. */
export function localDayStartMs(date: string, timeZone: string): number {
  return localWallTimeMs(date, "00:00", timeZone);
}

/** The local calendar day `date` as a [start, end) UTC window; end = start of the next day. */
export function localDayBoundsMs(
  date: string,
  timeZone: string,
): { startMs: number; endMs: number } {
  return {
    startMs: localDayStartMs(date, timeZone),
    endMs: localDayStartMs(addDaysToDate(date, 1), timeZone),
  };
}
