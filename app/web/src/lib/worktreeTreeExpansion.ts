import { persistentStore } from "./persistentStore.ts";

/**
 * Which folders of each worktree's file tree are open, remembered across
 * reloads in the IndexedDB-backed `persistentStore` (never `localStorage`: see
 * its header on WebKit's growing WAL).
 *
 * One entry for every worktree, BOUNDED so it cannot grow with use: the
 * {@link MAX_WORKTREES} most recently changed worktrees are kept, each with at
 * most {@link MAX_DIRS} folders. A tree folded shut is forgotten outright.
 */
const KEY = "assistant.worktreeFileTree.expanded.v1";
const MAX_WORKTREES = 30;
const MAX_DIRS = 300;

type Stored = Record<string, { dirs: string[]; at: number }>;

function read(): Stored {
  try {
    const raw = persistentStore().getItem(KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : {};
    if (!parsed || typeof parsed !== "object") return {};
    const out: Stored = {};
    for (const [id, value] of Object.entries(parsed)) {
      const entry = value as { dirs?: unknown; at?: unknown };
      if (!Array.isArray(entry.dirs) || typeof entry.at !== "number") continue;
      out[id] = {
        dirs: entry.dirs.filter(
          (dir): dir is string => typeof dir === "string",
        ),
        at: entry.at,
      };
    }
    return out;
  } catch {
    return {};
  }
}

export function loadExpandedTreeDirs(worktreeId: string): string[] {
  return read()[worktreeId]?.dirs ?? [];
}

export function saveExpandedTreeDirs(worktreeId: string, dirs: string[]) {
  const store = persistentStore();
  // Before the backend answered, this window's copy is empty: writing the
  // whole map now would replace every other worktree's state with nothing.
  if (!store.isLoaded()) return;
  const stored = read();
  if (dirs.length === 0) delete stored[worktreeId];
  else stored[worktreeId] = { dirs: dirs.slice(0, MAX_DIRS), at: Date.now() };
  const kept = Object.entries(stored)
    .sort(([, a], [, b]) => b.at - a.at)
    .slice(0, MAX_WORKTREES);
  try {
    store.setItem(KEY, JSON.stringify(Object.fromEntries(kept)));
  } catch {
    // Remembering folders is a convenience; a failed write changes nothing.
  }
}
