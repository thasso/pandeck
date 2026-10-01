/**
 * The transcript's render window: how many of the oldest rows stay unmounted.
 *
 * A long session runs to thousands of messages and every row is a real subtree,
 * so mounting all of them costs the first paint, the DOM size and every layout
 * afterwards — memoization keeps them from RE-rendering, not from existing. The
 * window therefore renders the most recent `limit` rows and grows on demand.
 *
 * Two rules make it safe to slide:
 * - A row that is already on screen is never taken away, so arriving messages
 *   extend the window at the tail rather than yanking history out from under
 *   someone reading it.
 * - That floor is the row the window currently STARTS at (`topKey`), not its
 *   index: a reconnect preview resolving into the full transcript renumbers
 *   every row, and an index floor would then mean "render the whole session".
 *   An unknown key (a different session, a dropped prefix) simply falls back to
 *   the plain last-`limit` window.
 */
export function transcriptWindowStart<T extends { key: string }>(
  rows: readonly T[],
  limit: number,
  topKey: string | null,
): number {
  const desired = Math.max(0, rows.length - limit);
  if (topKey === null) return desired;
  const topIndex = rows.findIndex((row) => row.key === topKey);
  return topIndex < 0 ? desired : Math.min(desired, topIndex);
}
