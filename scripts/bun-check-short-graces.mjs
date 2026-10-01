/**
 * Preloaded into the packaged server by the Bun install check only
 * (`bun --preload`), so the check can watch a session be released from memory
 * in seconds rather than minutes: the two release graces,
 * `VIEW_RELEASE_GRACE_MS` (60 s) and `HARNESS_IDLE_EVICT_MS` (5 min), become
 * 200 ms. Every other delay is kept. A grace that changes stops matching here,
 * and the check then fails waiting for the release it expects.
 */
const GRACES = new Set([60_000, 5 * 60_000]);
const scheduleTimeout = globalThis.setTimeout;

globalThis.setTimeout = Object.assign(
  (callback, delay, ...args) =>
    scheduleTimeout(callback, GRACES.has(delay) ? 200 : delay, ...args),
  scheduleTimeout,
);
