/**
 * One refcount per watched worktree, for the whole browser.
 *
 * `watchWorktree` is NOT refcounted on the wire. The server keeps a plain Set of
 * ids per connection, so a second `watchWorktree` for an id already in it does
 * nothing — and the first `unwatchWorktree` takes the watch away from everyone.
 * Two surfaces that legitimately want the same worktree is the ordinary case,
 * not an edge one: a project page states its Tasks' worktrees while the
 * Projects browser lists that project's own, and switching the sidebar's
 * section then silently froze the page's markers at whatever they last said.
 *
 * So the demands are counted HERE and the socket sees the union: a watch on the
 * first holder, an unwatch on the last release, and nothing in between. Every
 * `watchWorktree` in the app goes through this (`hooks/useWorktreeWatches.ts`);
 * sending one directly re-opens the same hole.
 *
 * The other half is the CONNECTION. A watch dies with the socket it was made
 * on and nothing replays it, so this tracks what the current connection was
 * told separately from what the app wants: a drop forgets the former without
 * sending anything (there is nothing to release, and an unwatch would be
 * delivered on the replacement connection instead), and the next connection is
 * brought up to the full desired set.
 */

/** The two sends this needs — `AssistantActions`, narrowed to them. */
export interface WorktreeWatchTransport {
  watchWorktree(worktreeId: string): void;
  unwatchWorktree(worktreeId: string): void;
}

/** One consumer's standing demand. Held for as long as its surface is up. */
interface WorktreeWatchLease {
  /** The ids this consumer wants from now on; replaces its previous list. */
  set(ids: readonly string[]): void;
  /** Give them all up — the same as setting an empty list. */
  release(): void;
}

export interface WorktreeWatchRegistry {
  lease(): WorktreeWatchLease;
  /**
   * Which socket to talk through, and whether it is up. Called by every
   * consumer with the same values; only a CHANGE does anything.
   */
  setConnection(connected: boolean, transport: WorktreeWatchTransport): void;
  /** What this connection has been asked to watch, sorted. For tests. */
  watching(): string[];
}

export function createWorktreeWatchRegistry(): WorktreeWatchRegistry {
  /** What the app wants: id → how many consumers want it. */
  const wanted = new Map<string, number>();
  /** What THIS connection has been told. Emptied when it drops. */
  const told = new Set<string>();
  let transport: WorktreeWatchTransport | null = null;
  let connected = false;

  const sync = () => {
    if (!connected || !transport) return;
    // Watches first: an id that survives a lease's change of mind is never
    // released and re-taken, so the server never rescans it for nothing.
    for (const id of wanted.keys()) {
      if (told.has(id)) continue;
      told.add(id);
      transport.watchWorktree(id);
    }
    for (const id of [...told]) {
      if (wanted.has(id)) continue;
      told.delete(id);
      transport.unwatchWorktree(id);
    }
  };

  return {
    lease() {
      let held: readonly string[] = [];
      const set = (ids: readonly string[]) => {
        const next = [...ids];
        // Acquire BEFORE releasing, so an id held by both lists never touches
        // zero — the count is the only thing standing between two surfaces.
        for (const id of next) wanted.set(id, (wanted.get(id) ?? 0) + 1);
        for (const id of held) {
          const rest = (wanted.get(id) ?? 0) - 1;
          if (rest > 0) wanted.set(id, rest);
          else wanted.delete(id);
        }
        held = next;
        sync();
      };
      return { set, release: () => set([]) };
    },

    setConnection(nextConnected, nextTransport) {
      transport = nextTransport;
      if (nextConnected === connected) return;
      connected = nextConnected;
      if (!connected) {
        told.clear();
        return;
      }
      sync();
    },

    watching: () => [...told].sort(),
  };
}

/** The app's registry: one browser, one socket, one set of watches. */
export const worktreeWatchRegistry = createWorktreeWatchRegistry();
