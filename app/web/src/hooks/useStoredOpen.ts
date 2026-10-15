import { useCallback, useEffect, useState } from "react";
import { localStore } from "../lib/localStore.ts";

function readStoredBoolean(key: string, fallback: boolean): boolean {
  try {
    const value = localStore.getItem(key);
    if (value === "open") return true;
    if (value === "closed") return false;
  } catch {
    // Ignore storage failures and use the default state.
  }
  return fallback;
}

/**
 * Whether a foldable section is open, remembered per browser under `key` (no
 * key: not remembered). Re-read when the key changes, so a section that
 * stands for a different thing starts from that thing's own choice.
 */
export function useStoredOpen(
  key: string | undefined,
  defaultOpen: boolean,
): [boolean, () => void] {
  const [open, setOpen] = useState(() =>
    key ? readStoredBoolean(key, defaultOpen) : defaultOpen,
  );
  useEffect(() => {
    setOpen(key ? readStoredBoolean(key, defaultOpen) : defaultOpen);
  }, [key, defaultOpen]);
  const toggle = useCallback(() => {
    setOpen((current) => {
      const next = !current;
      if (key) {
        try {
          localStore.setItem(key, next ? "open" : "closed");
        } catch {
          // Ignore storage failures; folding is still useful for this render.
        }
      }
      return next;
    });
  }, [key]);
  return [open, toggle];
}
