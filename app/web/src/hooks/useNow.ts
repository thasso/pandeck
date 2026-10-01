import { useEffect, useState } from "react";

/**
 * Wall-clock time that re-renders its caller every `intervalMs`. Render reads
 * this instead of `Date.now()`/`new Date()`: a render-time clock makes the same
 * props produce a different tree (`react/purity`) and only moves when something
 * else happens to re-render.
 */
export function useNow(intervalMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}
