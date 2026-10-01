/**
 * Per-file "viewed" review tracking for the worktree changeset view, persisted
 * browser-locally per worktree + diff scope (like GitHub's viewed checkboxes).
 * Working-tree scopes keep one shared key, so marks can go stale as edits
 * continue — acceptable for a personal review aid; clearing is one tap away.
 *
 * The marks live in a MODULE store rather than in each hook's state: one
 * worktree can be read by two mounted surfaces at once (its route page and the
 * right panel's Worktree tab), they share the one localStorage key, and
 * `storage` does not fire in the document that wrote it. Per-instance state
 * would let the two disagree, and the stale one's next toggle would write its
 * whole set back over the other's marks.
 */
import { useCallback, useSyncExternalStore } from "react";

const KEY_PREFIX = "assistant.worktreeViewed";

function storageKey(worktreeId: string, scopeKey: string): string {
  return `${KEY_PREFIX}:${worktreeId}:${scopeKey}`;
}

function load(key: string): ReadonlySet<string> {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return new Set();
    const parsed: unknown = JSON.parse(raw);
    return new Set(
      Array.isArray(parsed)
        ? parsed.filter((item): item is string => typeof item === "string")
        : [],
    );
  } catch {
    return new Set();
  }
}

/**
 * key → the one set every reader of that key sees. Cached because
 * `useSyncExternalStore` compares snapshots by identity: re-reading storage per
 * render would hand back a fresh Set every time and never settle.
 */
const sets = new Map<string, ReadonlySet<string>>();
const listeners = new Map<string, Set<() => void>>();

function snapshot(key: string): ReadonlySet<string> {
  const held = sets.get(key);
  if (held) return held;
  const loaded = load(key);
  sets.set(key, loaded);
  return loaded;
}

function subscribe(key: string, listener: () => void): () => void {
  const held = listeners.get(key) ?? new Set();
  held.add(listener);
  listeners.set(key, held);
  return () => {
    held.delete(listener);
    if (held.size === 0) listeners.delete(key);
  };
}

function toggle(key: string, path: string): void {
  const next = new Set(snapshot(key));
  if (next.has(path)) next.delete(path);
  else next.add(path);
  sets.set(key, next);
  try {
    localStorage.setItem(key, JSON.stringify([...next]));
  } catch {
    // Quota/serialization failures degrade to session-only tracking.
  }
  for (const listener of listeners.get(key) ?? []) listener();
}

export function useViewedFiles(
  worktreeId: string,
  scopeKey: string,
): {
  viewedPaths: ReadonlySet<string>;
  toggleViewed: (path: string) => void;
} {
  const key = storageKey(worktreeId, scopeKey);
  const viewedPaths = useSyncExternalStore(
    useCallback((listener: () => void) => subscribe(key, listener), [key]),
    useCallback(() => snapshot(key), [key]),
    useCallback(() => snapshot(key), [key]),
  );
  const toggleViewed = useCallback((path: string) => toggle(key, path), [key]);
  return { viewedPaths, toggleViewed };
}
