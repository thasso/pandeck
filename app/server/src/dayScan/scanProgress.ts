/**
 * Live day-scan progress (Task 162). The deterministic scan is server-side and
 * sessionless in its compute, but the user wants to watch the workflow while it
 * runs. This module holds the current per-date step state and broadcasts a
 * `calendarDayScanProgress` message to all clients as phases advance — mirroring
 * the `memoryEvents` broadcaster seam (the hub installs the live
 * broadcaster; unit/one-shot callers no-op).
 *
 * It owns only transient progress; it never persists. The durable run state is
 * the committed manifest read through `/api/calendar/day`.
 */
import type {
  CalendarDayScanProgress,
  CalendarScanStep,
  CalendarScanStepStatus,
  ServerMessage,
} from "@assistant/shared";

export interface CalendarScanBroadcaster {
  /** Deliver to the connections currently showing the calendar (topic `calendar`). */
  broadcast(message: ServerMessage): void;
}

let broadcaster: CalendarScanBroadcaster = { broadcast: () => {} };

export function setCalendarScanBroadcaster(
  next: CalendarScanBroadcaster,
): void {
  broadcaster = next;
}

/** The ordered phases of a scan. Kept coarse so the widget reads cleanly. */
const STEP_ORDER: Array<{ key: string; label: string }> = [
  { key: "collect", label: "Collecting signals" },
  { key: "minutes", label: "Curating meeting minutes" },
  { key: "synthesize", label: "Writing the day report" },
];

interface ScanState {
  date: string;
  startedAt: number;
  sessionId: string | null;
  steps: Map<string, CalendarScanStep>;
  active: boolean;
  error?: string;
}

const runs = new Map<string, ScanState>();

function project(state: ScanState): CalendarDayScanProgress {
  return {
    date: state.date,
    active: state.active,
    startedAt: state.startedAt,
    sessionId: state.sessionId,
    steps: STEP_ORDER.map(
      ({ key, label }) =>
        state.steps.get(key) ?? { key, label, status: "pending" },
    ),
    ...(state.error ? { error: state.error } : {}),
  };
}

function emit(state: ScanState): void {
  broadcaster.broadcast({
    type: "calendarDayScanProgress",
    progress: project(state),
  });
}

/** Begin (or restart) a scan's progress for a date, resetting all steps to pending. */
export function beginDayScanProgress(
  date: string,
  sessionId: string | null,
): void {
  const state: ScanState = {
    date,
    startedAt: Date.now(),
    sessionId,
    steps: new Map(),
    active: true,
  };
  runs.set(date, state);
  emit(state);
}

/** Update one step's status/detail and broadcast. */
export function reportDayScanStep(
  date: string,
  key: string,
  status: CalendarScanStepStatus,
  detail?: string,
): void {
  const state = runs.get(date);
  if (!state) return;
  const label = STEP_ORDER.find((s) => s.key === key)?.label ?? key;
  state.steps.set(key, { key, label, status, ...(detail ? { detail } : {}) });
  emit(state);
}

/** Settle the scan: mark it inactive; any still-running step is left as-is. */
export function endDayScanProgress(
  date: string,
  opts: { error?: string } = {},
): void {
  const state = runs.get(date);
  if (!state) return;
  state.active = false;
  if (opts.error) state.error = opts.error;
  emit(state);
  // Keep the terminal snapshot briefly so a late refetch/tab can still read it,
  // then drop it to avoid unbounded growth.
  setTimeout(() => {
    if (runs.get(date) === state && !state.active) runs.delete(date);
  }, 60_000).unref?.();
}
