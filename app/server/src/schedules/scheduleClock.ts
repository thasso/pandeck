/**
 * The schedule clock (`docs/schedules.md`, Claiming): ONE timer that claims
 * due occurrences and runs the retention sweep.
 *
 * The timer is armed at the earlier of the earliest enabled `next_due_at_ms`
 * and the maintenance deadline, never more than 24 hours out. The maintenance
 * deadline is the boot time at start and, after each COMPLETED sweep, that
 * sweep's time plus 24 hours. Re-arming for a store write or a settings change
 * never moves it later, so a stream of writes cannot starve the sweep.
 *
 * A tick settles every due Schedule through `scheduleStore.claimDue` (one
 * transaction each: claim the latest within the grace window, record the
 * others `missed`, advance `next_due_at_ms`), runs the sweep when its deadline
 * has come, and then tells the `claimed` hook about each occurrence it claimed,
 * after that claim committed, with the target read from the frozen occurrence.
 * A tick that fails anywhere logs it and does not re-arm sooner than
 * {@link SCHEDULE_CLOCK_RETRY_MS}, so a persistent failure never spins.
 *
 * Pause all is judged by when a due time fell, not by when a tick gets to it.
 * A tick can come late (a failed one waits out its back-off, a timer can run
 * late), and Pause all may be lifted in between. So the clock remembers the
 * instant it saw the pause lifted, and until a tick has settled every Schedule
 * through it, due times at or before it are recorded `missed` and never
 * claimed: they cannot catch up on resume or supersede an occurrence claimed
 * before the pause. A resume also ticks at once, outside a back-off, so those
 * due times are recorded while the cutoff is still known.
 */
import { onSettingsChanged } from "../settingsService.ts";
import { getSettings } from "../settings.ts";
import {
  scheduleStore,
  type ScheduleClaimPolicy,
  type ScheduleOccurrenceRecord,
} from "../db/scheduleStore.ts";
import { errorText } from "../errors.ts";
import type { ScheduleSettings } from "@assistant/shared/schedules";

const MINUTE_MS = 60_000;
/** The longest the timer waits before it reads the wall clock again. */
export const SCHEDULE_CLOCK_MAX_DELAY_MS = 24 * 60 * MINUTE_MS;
/** The soonest a tick runs again after one that failed. */
export const SCHEDULE_CLOCK_RETRY_MS = MINUTE_MS;

/** What the clock needs from the store; the real one in production. */
type ScheduleClockStore = Pick<
  typeof scheduleStore,
  "earliestDueAtMs" | "dueIds" | "claimDue" | "runMaintenance" | "onWrite"
>;

/** The `schedules` settings, and a way to hear that they changed. */
interface ScheduleClockSettings {
  read(): ScheduleSettings;
  onChange(listener: () => void): () => void;
}

interface ScheduleClockTimers {
  set(fire: () => void, delayMs: number): unknown;
  clear(handle: unknown): void;
}

interface ScheduleClockOptions {
  store?: ScheduleClockStore;
  settings?: ScheduleClockSettings;
  now?: () => number;
  timers?: ScheduleClockTimers;
  /**
   * Runs once per claimed occurrence, after its claim committed, with the
   * target from the frozen occurrence row. PR-A wires nothing to it; the
   * scheduled prompts lane wakes the target's delivery here.
   */
  claimed?: (
    targetSessionId: string,
    occurrence: ScheduleOccurrenceRecord,
  ) => void;
}

export interface ScheduleClock {
  /** Arm the clock and run the boot tick (maintenance is due at once). */
  start(): void;
  /** Disarm the timer and stop listening; a later start begins afresh. */
  stop(): void;
  /** When the next maintenance sweep is due, while started. */
  maintenanceDueAtMs(): number | undefined;
}

const productionSettings: ScheduleClockSettings = {
  read: () => getSettings().schedules,
  onChange: (listener) =>
    onSettingsChanged(({ sections }) => {
      if (sections.includes("schedules")) listener();
    }),
};

const productionTimers: ScheduleClockTimers = {
  set: (fire, delayMs) => {
    const handle = setTimeout(fire, delayMs);
    handle.unref?.();
    return handle;
  },
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

function warn(what: string, err: unknown): void {
  console.warn(`[schedules] ${what}:`, errorText(err));
}

export function createScheduleClock(
  options: ScheduleClockOptions = {},
): ScheduleClock {
  const store = options.store ?? scheduleStore;
  const settings = options.settings ?? productionSettings;
  const now = options.now ?? Date.now;
  const timers = options.timers ?? productionTimers;
  const claimed = options.claimed ?? (() => {});

  let running = false;
  let ticking = false;
  let handle: unknown;
  let maintenanceDueAtMs = 0;
  /** Set by a failed tick: no timer fires before it. */
  let retryNotBeforeMs: number | undefined;
  /** Pause all as last read. */
  let paused = false;
  /**
   * The latest instant Pause all was seen lifted, until a tick settled every
   * due Schedule through it: due times at or before it are missed.
   */
  let missThroughMs: number | undefined;
  let unsubscribe: Array<() => void> = [];

  /** Record a pause read at `at`; a pause seen lifted moves the cutoff. */
  function observePause(next: boolean, at: number): boolean {
    const resumed = paused && !next;
    if (resumed) missThroughMs = Math.max(missThroughMs ?? at, at);
    paused = next;
    return resumed;
  }

  /** A settings change: note a pause or resume now, then tick or re-arm. */
  function settingsChanged(): void {
    if (!running) return;
    let resumed = false;
    try {
      resumed = observePause(settings.read().paused, now());
    } catch (err) {
      // The next tick reads the settings again and treats a resume it only
      // sees then as lifted at that tick: never later than it was.
      warn("reading the schedule settings failed", err);
    }
    const inBackOff =
      retryNotBeforeMs !== undefined && now() < retryNotBeforeMs;
    if (resumed && !inBackOff && !ticking) tick();
    else arm();
  }

  function disarm(): void {
    if (handle !== undefined) timers.clear(handle);
    handle = undefined;
  }

  function arm(): void {
    if (!running || ticking) return;
    disarm();
    const at = now();
    let fireAt = Math.min(maintenanceDueAtMs, at + SCHEDULE_CLOCK_MAX_DELAY_MS);
    try {
      const due = store.earliestDueAtMs();
      if (due !== undefined) fireAt = Math.min(fireAt, due);
    } catch (err) {
      warn("reading the next due time failed", err);
      fireAt = at + SCHEDULE_CLOCK_RETRY_MS;
    }
    if (retryNotBeforeMs !== undefined)
      fireAt = Math.max(fireAt, retryNotBeforeMs);
    handle = timers.set(
      () => {
        handle = undefined;
        tick();
      },
      Math.max(0, fireAt - at),
    );
  }

  /** Claim what is due, sweep when the deadline came, then re-arm. */
  function tick(): void {
    if (!running || ticking) return;
    disarm();
    ticking = true;
    const at = now();
    let failed = false;
    let claimsFailed = false;
    let policy: ScheduleClaimPolicy | undefined;
    try {
      try {
        const current = settings.read();
        observePause(current.paused, at);
        policy = {
          graceMs: current.graceWindowMinutes * MINUTE_MS,
          paused: current.paused,
          ...(missThroughMs !== undefined ? { missThroughMs } : {}),
        };
      } catch (err) {
        failed = true;
        warn("reading the schedule settings failed", err);
      }
      if (policy)
        for (const id of store.dueIds(at)) {
          let occurrence: ScheduleOccurrenceRecord | undefined;
          try {
            occurrence = store.claimDue(id, at, policy).claimed;
          } catch (err) {
            failed = true;
            claimsFailed = true;
            warn(`claiming ${id} failed`, err);
          }
          if (occurrence)
            try {
              claimed(occurrence.target.sessionId, occurrence);
            } catch (err) {
              warn(`the claimed hook for ${occurrence.id} failed`, err);
            }
        }
      if (at >= maintenanceDueAtMs) {
        try {
          store.runMaintenance(at);
          maintenanceDueAtMs = at + SCHEDULE_CLOCK_MAX_DELAY_MS;
        } catch (err) {
          failed = true;
          warn("the maintenance sweep failed", err);
        }
      }
      // A due time the tick did not move past would fire again at once.
      const due = store.earliestDueAtMs();
      if (!failed && policy && due !== undefined && due <= at) {
        failed = true;
        console.warn(
          `[schedules] a due time at ${due} did not advance past ${at}`,
        );
      }
    } catch (err) {
      failed = true;
      claimsFailed = true;
      warn("the schedule clock tick failed", err);
    } finally {
      ticking = false;
    }
    // Every due Schedule was settled through the cutoff this tick applied, so
    // nothing at or before it is left to claim. A newer resume keeps its own.
    if (policy && !claimsFailed && missThroughMs === policy.missThroughMs)
      missThroughMs = undefined;
    retryNotBeforeMs = failed ? at + SCHEDULE_CLOCK_RETRY_MS : undefined;
    arm();
  }

  return {
    start() {
      if (running) return;
      running = true;
      maintenanceDueAtMs = now();
      retryNotBeforeMs = undefined;
      unsubscribe = [store.onWrite(arm), settings.onChange(settingsChanged)];
      tick();
    },
    stop() {
      running = false;
      disarm();
      for (const off of unsubscribe) off();
      unsubscribe = [];
    },
    maintenanceDueAtMs: () => (running ? maintenanceDueAtMs : undefined),
  };
}

let production: ScheduleClock | undefined;

/** Boot: start the one production clock, after delivery recovery. */
export function startScheduleClock(): void {
  production ??= createScheduleClock();
  production.start();
}

/** Shutdown: the clock claims nothing more in this process. */
export function stopScheduleClock(): void {
  production?.stop();
}
