/**
 * @module schedules
 * @purpose The pure reads behind the Schedules surfaces (`docs/schedules.md`,
 *   Web): the needs-attention count, the Active/Done filter, the timing
 *   summaries, the editor's changed-fields patch, the history read's
 *   request predicate, the session's Schedules and header chip, and the
 *   per-surface control claims.
 * @intent Framework-free, so the rules the page, the nav count and the history
 *   effect share are decided once and tested without a DOM.
 */
import {
  SCHEDULE_WEEKDAYS,
  formatScheduleDue,
  scheduleTimingError,
  scheduleTimingFutureError,
  scheduleTimingsEqual,
  type ScheduleOccurrenceSummary,
  type ScheduleSummary,
  type ScheduleTiming,
  type ScheduleTimingInput,
  type ScheduleUserPatch,
  type ScheduleWeekday,
} from "@assistant/shared/schedules";
import type { LoadState } from "./loadState.ts";

/** The page's two exclusive filters (U5). */
export type ScheduleFilter = "active" | "done";

/**
 * The nav count (R3): every live Schedule whose last occurrence failed, done
 * and disabled ones included. Nothing acknowledges it; a later occurrence or
 * deleting the Schedule clears it.
 */
export function needsAttentionCount(
  schedules: readonly ScheduleSummary[],
): number {
  let count = 0;
  for (const schedule of schedules)
    if (schedule.lastOccurrence?.state === "failed") count += 1;
  return count;
}

/**
 * The rows of one filter (U5): Done is exactly the done Schedules, Active
 * every other one, a disabled Schedule that is not done included.
 */
export function visibleSchedules(
  schedules: readonly ScheduleSummary[],
  filter: ScheduleFilter,
): ScheduleSummary[] {
  return schedules.filter((schedule) =>
    filter === "done"
      ? schedule.doneAtMs !== undefined
      : schedule.doneAtMs === undefined,
  );
}

/**
 * The Schedules targeting one session, in list order: the inspector's section
 * (AC11). Read from the subscribed topic, so `SessionListItem` carries nothing.
 */
export function schedulesForSession(
  schedules: readonly ScheduleSummary[],
  sessionId: string,
): ScheduleSummary[] {
  return schedules.filter(
    (schedule) =>
      schedule.target.kind === "session" &&
      schedule.target.sessionId === sessionId,
  );
}

/**
 * The header chip's Schedule (AC12, U3): among this session's enabled,
 * repeating Schedules with a next occurrence, the earliest one. A Schedule
 * that runs once never shows; ties keep list order.
 */
export function nextRepeatingForSession(
  schedules: readonly ScheduleSummary[],
  sessionId: string,
): (ScheduleSummary & { nextDueAtMs: number }) | undefined {
  let next: (ScheduleSummary & { nextDueAtMs: number }) | undefined;
  for (const schedule of schedulesForSession(schedules, sessionId)) {
    if (
      !schedule.enabled ||
      schedule.timing.kind === "once" ||
      schedule.doneAtMs !== undefined ||
      !hasNextDue(schedule)
    )
      continue;
    // The replica's own row, never a copy: the chip memoizes on it.
    if (next === undefined || schedule.nextDueAtMs < next.nextDueAtMs)
      next = schedule;
  }
  return next;
}

function hasNextDue(
  schedule: ScheduleSummary,
): schedule is ScheduleSummary & { nextDueAtMs: number } {
  return schedule.nextDueAtMs !== undefined;
}

/**
 * The mounted surfaces that render Schedule write outcomes, each reporting its
 * own claimed control keys (`docs/schedules.md`, Web): the phone's page screen,
 * the main page, the detail and the session inspector. Claims are kept per
 * surface so one surface's report never overwrites another's.
 */
export type ScheduleClaimSurface = "phone" | "page" | "detail" | "inspector";

export const NO_SCHEDULE_CLAIMS: Readonly<
  Record<ScheduleClaimSurface, string>
> = { phone: "", page: "", detail: "", inspector: "" };

/** One surface's report, as a joined key; the same object when unchanged. */
export function withScheduleClaim(
  claims: Readonly<Record<ScheduleClaimSurface, string>>,
  surface: ScheduleClaimSurface,
  keys: readonly string[],
): Readonly<Record<ScheduleClaimSurface, string>> {
  const joined = keys.join("\n");
  return claims[surface] === joined ? claims : { ...claims, [surface]: joined };
}

/** Every surface's claimed keys together, each once. */
export function scheduleClaimedKeys(
  claims: Readonly<Record<ScheduleClaimSurface, string>>,
): string[] {
  const keys = new Set<string>();
  for (const joined of Object.values(claims))
    if (joined) for (const key of joined.split("\n")) keys.add(key);
  return [...keys];
}

/** The Next column (U8): Off, Done, a due time, or none. */
export function scheduleNextLabel(schedule: ScheduleSummary): string {
  if (schedule.doneAtMs !== undefined) return "Done";
  if (!schedule.enabled) return "Off";
  return schedule.nextDueAtMs !== undefined
    ? formatScheduleDue(schedule.nextDueAtMs, schedule.timing.timeZone)
    : "—";
}

const DAY_LABEL: Record<ScheduleWeekday, string> = {
  mon: "Mon",
  tue: "Tue",
  wed: "Wed",
  thu: "Thu",
  fri: "Fri",
  sat: "Sat",
  sun: "Sun",
};
const WEEKDAY_BY_UTC_DAY = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = [
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

/** A calendar date (`YYYY-MM-DD`) as the summaries show it: `Wed 25 Nov 2026`. */
export function formatScheduleDate(date: string): string {
  const [year, month, day] = date.split("-").map(Number);
  if (!year || !month || !day) return date;
  const at = new Date(Date.UTC(year, month - 1, day));
  return `${WEEKDAY_BY_UTC_DAY[at.getUTCDay()]} ${day} ${MONTHS[month - 1]} ${year}`;
}

/** The approved one-line summary of a timing (U8), in its own wall time. */
export function describeScheduleTiming(
  timing: ScheduleTiming | ScheduleTimingInput,
): string {
  if (timing.kind === "once")
    return `Once on ${formatScheduleDate(timing.date)} at ${timing.time}`;
  const base =
    timing.kind === "daily"
      ? `Daily at ${timing.time}`
      : timing.kind === "weekdays"
        ? `Weekdays at ${timing.time}`
        : timing.kind === "weekly"
          ? `Weekly on ${SCHEDULE_WEEKDAYS.filter((day) =>
              timing.days.includes(day),
            )
              .map((day) => DAY_LABEL[day])
              .join(", ")} at ${timing.time}`
          : `Monthly on day ${timing.day} at ${timing.time}`;
  return [
    base,
    timing.startsOn ? `from ${formatScheduleDate(timing.startsOn)}` : null,
    timing.endsOn ? `until ${formatScheduleDate(timing.endsOn)}` : null,
  ]
    .filter(Boolean)
    .join(" ");
}

/** A supplied timing in the Schedule's stored zone, which no edit changes (R2). */
export function inStoredZone(
  input: ScheduleTimingInput,
  stored: ScheduleSummary,
): ScheduleTiming {
  return { ...input, timeZone: stored.timing.timeZone } as ScheduleTiming;
}

/**
 * The fields of `draft` that differ from the Schedule as the server holds it
 * now (R4): only those travel, and a field the user left alone follows the
 * server. An empty patch means there is nothing to save.
 */
export function scheduleDraftPatch(
  stored: ScheduleSummary,
  draft: ScheduleUserPatch,
): ScheduleUserPatch {
  const patch: ScheduleUserPatch = {};
  if (draft.prompt !== undefined && draft.prompt !== stored.prompt)
    patch.prompt = draft.prompt;
  if (draft.timing !== undefined) {
    const timing = inStoredZone(draft.timing, stored);
    if (
      scheduleTimingError(timing) !== null ||
      !scheduleTimingsEqual(timing, stored.timing)
    )
      patch.timing = draft.timing;
  }
  if (
    draft.targetSessionId !== undefined &&
    draft.targetSessionId !== stored.target.sessionId
  )
    patch.targetSessionId = draft.targetSessionId;
  return patch;
}

/**
 * Why the changed timing in `patch` cannot be saved at `nowMs`, or null. An
 * untouched timing is never judged, so a done Schedule's expired timing does
 * not block a prompt-only edit (AC8).
 */
export function scheduleDraftTimingError(
  stored: ScheduleSummary,
  patch: ScheduleUserPatch,
  nowMs: number,
): string | null {
  if (!patch.timing) return null;
  const timing = inStoredZone(patch.timing, stored);
  return (
    scheduleTimingError(timing) ?? scheduleTimingFutureError(timing, nowMs)
  );
}

/**
 * One open detail's history read (`docs/schedules.md`, Sync): what is shown,
 * the Schedule revision it was read at, and the current attempt, kept apart
 * from `load` so a failed refresh keeps the items it had.
 */
export interface ScheduleHistoryEntry {
  /** `ready(null)`: the Schedule is gone, which nothing reads again. */
  load: LoadState<ScheduleOccurrenceSummary[] | null>;
  revision?: number;
  attempt?: {
    requestId: string;
    /** The held summary revision the attempt was meant to reach. */
    generation: number;
    status: "inflight" | "failed";
  };
}

/**
 * Whether the open detail should ask for its history now (F006). A failed
 * attempt at generation G blocks every automatic request for `want <= G`: only
 * an explicit Retry, a newer generation or a reconnect lifts it, so renders and
 * unrelated state never loop on one invalidation.
 */
export function historyRequestNeeded(
  entry: ScheduleHistoryEntry,
  want: number,
  connected: boolean,
): boolean {
  if (!connected) return false;
  if (entry.attempt?.status === "inflight") return false;
  if (entry.load.status === "ready" && entry.load.data === null) return false;
  if (entry.revision !== undefined && entry.revision >= want) return false;
  if (entry.attempt?.status === "failed" && entry.attempt.generation >= want)
    return false;
  return true;
}

const SCHEDULE_FAILURE_PREFIX =
  /^Failed to (?:update|switch|delete) Schedule: |^Failed to save Schedules settings: /;

/**
 * The `{reason}` of a refused Schedule write, for the approved "Couldn't …:
 * {reason}" notes: the server's stamped sentence without its own "Failed to
 * … :" lead, which would say the same thing twice. Anything else (a timeout's
 * text) is already a reason.
 */
export function scheduleFailureReason(message: string): string {
  return message.replace(SCHEDULE_FAILURE_PREFIX, "");
}
