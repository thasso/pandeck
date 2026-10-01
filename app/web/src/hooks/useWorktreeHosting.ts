import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { WorktreeGitStatus, WorktreeRecord } from "@assistant/shared";
import { fetchWorktreeHostingAll } from "../lib/worktrees.ts";
import {
  EMPTY_WORKTREE_HOSTING,
  worktreeHostingKey,
  worktreeHostingMap,
  type WorktreeHostingMap,
} from "../lib/worktreeHosting.ts";

/** While a check is actually running; matches the Delivery panel. */
const HOSTING_POLL_MS = 60_000;
/**
 * Otherwise. A review request, a changes-requested verdict, a new PR and a
 * merge all happen on SOMEONE ELSE'S machine — no local HEAD moves, no watcher
 * event fires — so a surface that refetched only on local change could sit
 * open for hours and never learn that it was needed.
 */
const HOSTING_IDLE_POLL_MS = 5 * 60_000;

export interface WorktreeHostingInput {
  worktrees: WorktreeRecord[] | null;
  /** Live git status per worktree: a moved HEAD is what invalidates hosting. */
  statuses: Record<string, WorktreeGitStatus>;
  /**
   * A surface that READS the map is on screen. The projection is app state, but
   * the polling is not free — one request fans out to a provider per repo — so
   * it runs while something shows PR/CI and stops when nothing does. The last
   * map is KEPT while inactive: it is what the next surface renders on its
   * first frame, before the refetch this re-enables lands.
   */
  active: boolean;
}

export interface WorktreeHosting {
  hosting: WorktreeHostingMap;
  /** Refetch now — after an act (a push, a PR) whose result this must show. */
  refresh: () => void;
}

/**
 * The app's per-worktree PR/CI projection: one poller, one map, for every
 * surface that states delivery — today the Backlog's Task rows, on the sidebar
 * and on a Project page.
 *
 * Both tiers are timers, and the slow one is not optional (see
 * `HOSTING_IDLE_POLL_MS`). A FAILED request keeps the last known map rather
 * than clearing it: flapping every row to "unknown" on one bad response is
 * worse than briefly stale data, and the projection already omits what it could
 * not resolve.
 *
 * A response that says what the last one said is DROPPED rather than stored
 * (`worktreeHostingKey`): this state reaches the memoized sidebar and through it
 * every Task row, and on a quiet repo the poll would otherwise repaint the whole
 * Backlog every five minutes to say nothing.
 */
export function useWorktreeHosting({
  worktrees,
  statuses,
  active,
}: WorktreeHostingInput): WorktreeHosting {
  const [hosting, setHosting] = useState<WorktreeHostingMap>(
    EMPTY_WORKTREE_HOSTING,
  );
  // Bumped after a mutating action, so a surface reflects the push it just made.
  const [nonce, setNonce] = useState(0);
  const hostingKeyRef = useRef<string | null>(null);

  // What makes the projection stale locally: which worktrees exist, and where
  // each one's HEAD is. Everything ELSE that changes it happens on a server.
  const worktreeKey = useMemo(
    () =>
      (worktrees ?? [])
        .map(
          (worktree) => `${worktree.id}:${statuses[worktree.id]?.head ?? ""}`,
        )
        .join("|"),
    [worktrees, statuses],
  );
  const anyCiPending = Object.values(hosting).some(
    (status) => status.ci?.state === "pending",
  );

  useEffect(() => {
    if (!active || !worktreeKey) return;
    let cancelled = false;
    const load = () => {
      fetchWorktreeHostingAll()
        .then((res) => {
          if (cancelled) return;
          const key = worktreeHostingKey(res.statuses);
          if (key === hostingKeyRef.current) return;
          hostingKeyRef.current = key;
          setHosting(worktreeHostingMap(res.statuses));
        })
        .catch(() => undefined);
    };
    load();
    const timer = setInterval(
      load,
      anyCiPending ? HOSTING_POLL_MS : HOSTING_IDLE_POLL_MS,
    );
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [worktreeKey, active, anyCiPending, nonce]);

  const refresh = useCallback(() => setNonce((n) => n + 1), []);
  return { hosting, refresh };
}
