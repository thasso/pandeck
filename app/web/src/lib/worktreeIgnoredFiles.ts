import { useCallback, useSyncExternalStore } from "react";

/**
 * Whether a worktree's file trees list ignored and hidden files: ONE answer per
 * worktree, so the page's listing and the sidebar's Files tree always agree.
 * Held for the tab, not stored: it is a look under the hood, not a preference.
 */
const shown = new Set<string>();
const listeners = new Set<() => void>();

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useIgnoredFilesShown(
  worktreeId: string,
): [boolean, (next: boolean) => void] {
  const value = useSyncExternalStore(subscribe, () => shown.has(worktreeId));
  const set = useCallback(
    (next: boolean) => {
      if (next === shown.has(worktreeId)) return;
      if (next) shown.add(worktreeId);
      else shown.delete(worktreeId);
      for (const listener of listeners) listener();
    },
    [worktreeId],
  );
  return [value, set];
}
