import { useEffect, useState } from "react";
import { SESSION_READ_DWELL_MS } from "@assistant/shared";

/**
 * The viewed session once it has stayed open long enough to count as read in
 * the Sessions inbox. This hook lives with the app route rather than inside the
 * inbox because the sidebar browser can unmount while the viewed session stays
 * open, especially on mobile and when switching sidebar sections.
 */
export function useSessionReadDwell(
  currentId: string | undefined,
): string | undefined {
  const [readId, setReadId] = useState<string | undefined>(undefined);

  useEffect(() => {
    setReadId(undefined);
    if (currentId === undefined) return;
    const timer = window.setTimeout(
      () => setReadId(currentId),
      SESSION_READ_DWELL_MS,
    );
    return () => clearTimeout(timer);
  }, [currentId]);

  // A route switch renders before its effect clears the previous id. Never let
  // that stale value make the session just left look read in the meantime.
  return readId === currentId ? readId : undefined;
}
