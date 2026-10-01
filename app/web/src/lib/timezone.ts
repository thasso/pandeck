/**
 * Pure IANA-timezone wall-clock helpers over `@assistant/shared/zonedTime`
 * (the same conversion calendar day bounds use). Used so a `datetime-local`
 * input — which is inherently a naive/browser-local control — can be
 * interpreted as a wall-clock time in a DIFFERENT configured timezone (e.g. the
 * profile timezone) rather than the browser's own timezone.
 */
import type { MemoryTemporalMode } from "@assistant/shared";
import { localWallTimeMs } from "@assistant/shared/zonedTime";

/**
 * Whether a memory temporal mode's meaning depends on a timezone at all
 * (`window`/`recurring`). A timezone input/validity error for `persistent`/
 * `until-changed` is irrelevant and must never block saving those modes.
 */
export function temporalModeUsesTimezone(mode: MemoryTemporalMode): boolean {
  return mode === "window" || mode === "recurring";
}

/**
 * Convert a `datetime-local` value ("YYYY-MM-DDTHH:mm"), interpreted as a
 * wall-clock time IN `timeZone`, to a UTC epoch ms — the shared, verified
 * conversion (an ambiguous time is its first occurrence, a skipped one the end
 * of the gap). NaN for a malformed value.
 */
export function zonedWallTimeToUtcMs(
  localDateTimeValue: string,
  timeZone: string,
): number {
  const [datePart, timePart] = localDateTimeValue.split("T");
  try {
    return localWallTimeMs(datePart ?? "", timePart ?? "00:00", timeZone);
  } catch {
    return Number.NaN;
  }
}

/** Format a UTC epoch ms as a `datetime-local` value showing the wall-clock time IN `timeZone` (not the browser's timezone). */
export function utcMsToZonedWallTimeValue(
  ms: number,
  timeZone: string,
): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  })
    .formatToParts(new Date(ms))
    .reduce(
      (acc, p) => (p.type === "literal" ? acc : { ...acc, [p.type]: p.value }),
      {} as Record<string, string>,
    );
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;
}

/** Whether `tz` is a timezone `Intl.DateTimeFormat` accepts. `new Intl.DateTimeFormat` throws synchronously for an invalid IANA zone. */
export function isValidTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/**
 * The timezone to actually use for a conversion: `candidate` if it is a
 * non-empty valid IANA zone, otherwise `fallback`. Callers MUST route a
 * user-typed/free-text timezone through this before passing it to
 * `zonedWallTimeToUtcMs`/`utcMsToZonedWallTimeValue` — those call
 * `Intl.DateTimeFormat` directly, which throws synchronously (e.g. crashing a
 * React render) for an invalid zone string.
 */
export function resolveTimezone(
  candidate: string | undefined,
  fallback: string,
): string {
  const trimmed = candidate?.trim();
  return trimmed && isValidTimezone(trimmed) ? trimmed : fallback;
}
