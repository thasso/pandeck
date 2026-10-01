/**
 * Keep the screen awake for the duration of one dictation.
 *
 * Dictation is the app's only state where the user is deliberately NOT touching
 * the screen — they are talking at it. A phone's display timeout does not know
 * that, so it dims and then locks mid-sentence, which suspends the page and takes
 * the utterance with it (`useDictation` cancels on a hidden document, because a
 * backgrounded `AudioContext` records silence).
 *
 * The lock is held only while recording and released the moment it stops, so the
 * app never keeps a display awake for something the user cannot see happening.
 * Everything here degrades silently: the API is absent on desktop Firefox and the
 * request is rejected outright when the page is not visible. Failing to hold a
 * wake lock must never fail the recording — the worst case is the behaviour we
 * already had.
 */

/** Minimal shape of what we use; older TS DOM libs do not declare `wakeLock`. */
interface WakeLockLike {
  release(): Promise<void>;
  released: boolean;
}

interface WakeLockCapableNavigator {
  wakeLock?: { request(type: "screen"): Promise<WakeLockLike> };
}

export interface ScreenWakeLock {
  /** Give the display back to the OS. Safe to call more than once. */
  release(): void;
}

/**
 * Hold the screen awake until the returned handle is released. Resolves to null
 * when the browser cannot do it — the caller has nothing to handle either way.
 *
 * The browser drops the lock by itself whenever the page stops being visible, and
 * it is not reacquired here: a recording does not survive that either.
 */
export async function requestScreenWakeLock(): Promise<ScreenWakeLock | null> {
  const api = (navigator as unknown as WakeLockCapableNavigator).wakeLock;
  if (!api) return null;
  try {
    const sentinel = await api.request("screen");
    return {
      release: () => {
        if (sentinel.released) return;
        void sentinel.release().catch(() => {});
      },
    };
  } catch {
    return null;
  }
}
