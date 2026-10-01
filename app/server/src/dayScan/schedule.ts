import { getSettings } from "../settings.ts";
import { userTimeZone } from "../userProfile.ts";
import { runDayCollection } from "./collectionRun.ts";
import { runDaySynthesis } from "./synthesisRunner.ts";
import { localDateForInstant, localWallTimeMs, nextDate } from "./dayWindow.ts";

/**
 * Scheduled morning collection (plan phase 8). When enabled in day-scan
 * settings, the server automatically runs a collection each day at the
 * configured time in the user's timezone — and optionally synthesis — so the prep view is ready
 * before the day starts. This just adds a trigger: it reuses the same
 * `runDayCollection`/`runDaySynthesis` entry points as the manual scan, so the
 * per-day lock/coalescing and idempotent commit protect against overlap with a
 * user-triggered refresh. A single self-rescheduling timer re-reads settings on
 * every fire, so time/enabled/timezone changes take effect the next cycle;
 * `reconcileDayScanSchedule` applies a change immediately.
 */

let timer: NodeJS.Timeout | null = null;
let stopped = false;

/** The UTC instant of the next `time` occurrence in `timeZone`, strictly after `nowMs`. */
export function nextScheduledRunMs(
  nowMs: number,
  time: string,
  timeZone: string,
): number {
  const today = localDateForInstant(nowMs, timeZone);
  const todayFire = localWallTimeMs(today, time, timeZone);
  if (todayFire > nowMs) return todayFire;
  return localWallTimeMs(nextDate(today), time, timeZone);
}

function clearTimer(): void {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
}

function schedule(): void {
  clearTimer();
  if (stopped) return;
  const { schedule: sched } = getSettings().dayScan;
  if (!sched.enabled) return;
  const now = Date.now();
  let delay: number;
  try {
    delay = Math.max(
      0,
      nextScheduledRunMs(now, sched.time, userTimeZone()) - now,
    );
  } catch (err) {
    console.warn(
      "[day-scan] schedule: invalid time/timezone, disabling until settings change:",
      err instanceof Error ? err.message : String(err),
    );
    return;
  }
  timer = setTimeout(() => {
    void fire();
  }, delay);
  // Never hold the process open on shutdown / during drain.
  timer.unref?.();
}

async function fire(): Promise<void> {
  const { schedule: sched } = getSettings().dayScan;
  if (sched.enabled) {
    const date = localDateForInstant(Date.now(), userTimeZone());
    try {
      console.log(`[day-scan] scheduled morning run for ${date}`);
      await runDayCollection(date);
      if (sched.synthesize) {
        const result = await runDaySynthesis(date);
        if (!result.ok)
          console.warn(
            `[day-scan] scheduled synthesis for ${date} did not apply:`,
            result.errors.join("; ") || "unknown",
          );
      }
    } catch (err) {
      console.warn(
        `[day-scan] scheduled run failed for ${date}:`,
        err instanceof Error ? err.message : String(err),
      );
    }
  }
  // Reschedule for the next day regardless of this run's outcome.
  schedule();
}

/** Start the morning scheduler (no-op when disabled in settings). Idempotent. */
export function startDayScanSchedule(): void {
  stopped = false;
  schedule();
}

/** Re-read settings and reschedule (call after a day-scan settings change). */
export function reconcileDayScanSchedule(): void {
  if (stopped) return;
  schedule();
}

/** Graceful shutdown: cancel the pending timer and start no new ones. */
export function stopDayScanSchedule(): void {
  stopped = true;
  clearTimer();
}
