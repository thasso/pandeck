import { useEffect, useState } from "react";

/** How often ages and deadlines re-label while something is still running. */
const ACTIVE_TICK_MS = 1_000;
/** Everything visible is terminal: only the "x ago" labels drift. */
const IDLE_TICK_MS = 60_000;

/**
 * The ticker every elapsed label outside the Sessions inbox re-labels on: the
 * background surfaces and the composer's two ledges. It is here rather than in
 * the shell because those are all it serves, and every row memoizes on its
 * RENDERED label (`backgroundWorkRowKey`, `sessionCardKey`), so a tick that
 * changes no character costs one comparison and no re-render.
 */
export function useElapsedNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    setNow(Date.now());
    const id = window.setInterval(
      () => setNow(Date.now()),
      active ? ACTIVE_TICK_MS : IDLE_TICK_MS,
    );
    return () => window.clearInterval(id);
  }, [active]);
  return now;
}
