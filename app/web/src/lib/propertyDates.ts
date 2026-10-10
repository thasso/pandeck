/**
 * Dates as a property list states them: recognised from the ISO strings that
 * frontmatter and stored records carry, then shown as a readable local date
 * (with its time when the value has one) beside how long ago that was.
 */

/** A point in time read from a value, and whether it named a day only. */
export interface PropertyDateValue {
  ms: number;
  dateOnly: boolean;
}

const ISO_DATE_RE =
  /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/;

/** The date an ISO-8601 string (or epoch-ms number) names, else null. */
export function parsePropertyDate(
  value: string | number,
): PropertyDateValue | null {
  if (typeof value === "number") {
    // Only plausible epoch milliseconds (2001–2100), never a count or a year.
    return value > 978_307_200_000 && value < 4_102_444_800_000
      ? { ms: value, dateOnly: false }
      : null;
  }
  const match = ISO_DATE_RE.exec(value.trim());
  if (!match) return null;
  const [, year, month, day, hour] = match;
  if (hour === undefined) {
    // A bare day is a LOCAL calendar day: `new Date("2026-10-09")` would read
    // it as UTC midnight and show the day before west of Greenwich.
    const ms = new Date(Number(year), Number(month) - 1, Number(day)).getTime();
    return Number.isNaN(ms) ? null : { ms, dateOnly: true };
  }
  const ms = Date.parse(value.trim().replace(" ", "T"));
  return Number.isNaN(ms) ? null : { ms, dateOnly: false };
}

const RELATIVE_UNITS: Array<[Intl.RelativeTimeFormatUnit, number]> = [
  ["year", 365 * 24 * 3_600_000],
  ["month", 30 * 24 * 3_600_000],
  ["week", 7 * 24 * 3_600_000],
  ["day", 24 * 3_600_000],
  ["hour", 3_600_000],
  ["minute", 60_000],
];

/** "3 days ago", "in 2 hours", "yesterday" — or "just now". */
export function relativeDateLabel(
  date: PropertyDateValue,
  now: number,
): string {
  const delta = date.ms - now;
  const format = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
  if (date.dateOnly) {
    const today = new Date(now);
    const startOfToday = new Date(
      today.getFullYear(),
      today.getMonth(),
      today.getDate(),
    ).getTime();
    const days = Math.round((date.ms - startOfToday) / (24 * 3_600_000));
    if (Math.abs(days) < 7) return format.format(days, "day");
  }
  for (const [unit, size] of RELATIVE_UNITS) {
    if (Math.abs(delta) >= size)
      return format.format(Math.round(delta / size), unit);
  }
  return "just now";
}

/**
 * How a property list shows a date: `label` is the local date (and time),
 * `relative` how long ago, `full` the complete local timestamp for a title.
 */
export function formatPropertyDate(
  date: PropertyDateValue,
  now: number,
): { label: string; relative: string; full: string } {
  const value = new Date(date.ms);
  const sameYear = value.getFullYear() === new Date(now).getFullYear();
  const day: Intl.DateTimeFormatOptions = {
    month: "short",
    day: "numeric",
    ...(sameYear ? {} : { year: "numeric" }),
  };
  return {
    label: date.dateOnly
      ? value.toLocaleDateString(undefined, day)
      : value.toLocaleString(undefined, {
          ...day,
          hour: "numeric",
          minute: "2-digit",
        }),
    relative: relativeDateLabel(date, now),
    full: date.dateOnly
      ? value.toLocaleDateString(undefined, { dateStyle: "full" })
      : value.toLocaleString(undefined, {
          dateStyle: "full",
          timeStyle: "long",
        }),
  };
}

/**
 * A date field's key read as a label: `createdAt` → "Created",
 * `last_reviewed_at` → "Last reviewed", `date` → "Date".
 */
export function dateFieldLabel(key: string): string {
  const words = key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .trim()
    .toLowerCase()
    .replace(/\s+at$/, "");
  return words ? words[0]!.toUpperCase() + words.slice(1) : key;
}
