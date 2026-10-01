/**
 * @module appStatus
 * @purpose The app's ONE global announcement, as a value: which app-wide
 *   lifecycle state is worth saying out loud right now, and in what words.
 * @useWhen Rendering the app status slot (`components/AppStatus.tsx`). Nothing
 *   else may announce itself globally — see `docs/messaging.md`.
 * @intent Pure so the ranking and the copy are testable without a DOM. The
 *   slot's two placements share one derivation: a phone and a desktop must not
 *   be able to disagree about whether the app is restarting.
 */

/**
 * The reload phases the server reports, structurally matching `useAssistant`'s
 * `DevReloadState`. Declared here rather than imported so this module stays
 * framework-free and DOM-free, per `lib/CLAUDE.md`.
 */
export interface AppReloadState {
  phase: "pending" | "reloading";
  runningCount?: number;
}

export interface AppStatusInput {
  connected: boolean;
  reloading: AppReloadState | null | undefined;
  /** Whether this shell has ever been live, which names the connection state. */
  hydrationSource: "empty" | "cache" | "live";
  /** Whether the connection's grace period has elapsed (see `AppStatus`). */
  graceElapsed: boolean;
}

/**
 * The connection's grace period, held in a MODULE store rather than in either
 * placement's state.
 *
 * The two placements do not live and die together: the header bar exists only
 * on wide layouts, so crossing the breakpoint unmounts one and mounts the
 * other. A grace timer owned by a component would restart there, and an
 * announcement that has been on screen for a minute would vanish for another
 * 1200 ms on a rotate. The wait belongs to the connection, not to whichever
 * shell is currently drawing it.
 *
 * Whichever placements happen to be mounted all report the same pending state,
 * so the transition is idempotent: the first call moves the machine and any
 * second is a no-op. Unmounting reports nothing — the timer outlives any one
 * placement on purpose.
 */
let gracePending = false;
let graceElapsed = false;
let graceTimer: number | undefined;
const graceListeners = new Set<() => void>();

export function subscribeAppStatusGrace(listener: () => void): () => void {
  graceListeners.add(listener);
  return () => graceListeners.delete(listener);
}

export function appStatusGraceElapsed(): boolean {
  return graceElapsed;
}

/**
 * Report whether the app is currently waiting on a connection. Idempotent, so
 * every mounted placement may call it on every render.
 */
export function noteAppStatusPending(pending: boolean, delayMs: number): void {
  if (pending === gracePending) return;
  gracePending = pending;
  if (graceTimer !== undefined) {
    clearTimeout(graceTimer);
    graceTimer = undefined;
  }
  const wasElapsed = graceElapsed;
  graceElapsed = false;
  if (pending)
    graceTimer = setTimeout(() => {
      graceTimer = undefined;
      graceElapsed = true;
      for (const listener of graceListeners) listener();
    }, delayMs) as unknown as number;
  if (wasElapsed) for (const listener of graceListeners) listener();
}

/** Test seam: the store outlives components, so a suite has to clear it. */
export function resetAppStatusGrace(): void {
  if (graceTimer !== undefined) clearTimeout(graceTimer);
  graceTimer = undefined;
  gracePending = false;
  graceElapsed = false;
  graceListeners.clear();
}

type AppStatusKind =
  "restart-queued" | "restarting" | "connecting" | "reconnecting";

export interface AppStatusState {
  kind: AppStatusKind;
  label: string;
  /**
   * Whether the glyph is a wait for an answer (a spinner) or a state the app is
   * sitting in (a static icon). Queued is a state; the rest are waits.
   */
  busy: boolean;
}

/**
 * Copy is deliberately short enough for a pill on a phone: this slot has one
 * geometry on narrow layouts and the user cannot act on any of it, so the state
 * and its one number are the whole message. The long sentences this replaced
 * ("Server changes detected — restart queued until 3 active sessions finish.")
 * could not fit the placement the model gives it.
 */
export function appStatus(input: AppStatusInput): AppStatusState | null {
  const { connected, reloading, hydrationSource, graceElapsed } = input;
  // A restart owns the disconnect it is about to cause, so it outranks the
  // connection state rather than the two both speaking.
  if (reloading) {
    if (reloading.phase === "pending") {
      const count = reloading.runningCount ?? 0;
      return {
        kind: "restart-queued",
        label:
          count > 0
            ? `Restart queued — waiting for ${count} session${count === 1 ? "" : "s"}`
            : "Restart queued",
        busy: false,
      };
    }
    return { kind: "restarting", label: "Restarting…", busy: true };
  }
  if (connected || !graceElapsed) return null;
  // A shell restored from cache has never been live: that is a first
  // connection, not a lost one, and calling it a reconnect would describe a
  // drop that never happened.
  return hydrationSource === "live"
    ? { kind: "reconnecting", label: "Reconnecting…", busy: true }
    : { kind: "connecting", label: "Connecting…", busy: true };
}
