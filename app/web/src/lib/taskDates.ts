import { localDateOf } from "@assistant/shared/zonedTime";
export { addDaysToDate as addDays } from "@assistant/shared/zonedTime";

/** Today's user-local date as YYYY-MM-DD, independent of the browser's zone. */
export function todayIso(timeZone: string): string {
  return localDateOf(Date.now(), timeZone);
}

/** ISO weekday 1 (Mon) through 7 (Sun) for a date string. */
export function isoWeekday(dateIso: string): number {
  const day = new Date(`${dateIso}T00:00:00Z`).getUTCDay();
  return day === 0 ? 7 : day;
}
