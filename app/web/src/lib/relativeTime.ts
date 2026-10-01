/**
 * The two compact time labels every inbox-style row shares: how long ago
 * something happened, and how long something has been running.
 *
 * They live in their own module because several list projections read them and
 * two of those projections read each OTHER (a session card carries both its
 * provider status and its separate background chip). Keeping the formatters
 * here is what keeps that from becoming an import cycle.
 *
 * Both are deterministic over their inputs and take an explicit `now`, so a list
 * can re-label on a shared ticker without recomputing itself, and a row can
 * memoize on the label it RENDERS rather than on a raw timestamp.
 */

/** Compact age for a point in the past ("now", "5m", "3h", "2d", "Jun 3"). */
export function relativeAge(ts: number, now: number): string {
  if (!Number.isFinite(ts) || ts <= 0) return "—";
  const minutes = Math.round((now - ts) / 60_000);
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.round(hours / 24);
  if (days < 7) return `${days}d`;
  return new Date(ts).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}

/** Compact elapsed duration for a running turn ("12s", "4m", "1h 5m"). */
export function elapsedLabel(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "0s";
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}
