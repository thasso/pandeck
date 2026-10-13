import { useCallback, useEffect, useMemo } from "react";
import type { IdleWorktree, IdleWorktreesResponse } from "@assistant/shared";
import { useFetchState } from "./useFetchState.ts";
import { fetchIdleWorktrees } from "../lib/worktrees.ts";
import { mapData, type LoadState } from "../lib/loadState.ts";

/**
 * While the Pull Requests section is on screen, as its inventory polls. Each
 * read runs git status for the idle checkouts, so it never runs unseen.
 */
const IDLE_POLL_MS = 60_000;

const IDLE_KEY = "idle-worktrees";

export interface IdleWorktrees {
  state: LoadState<IdleWorktree[]>;
  /** When the server built the answer on screen: the rows' clock. */
  fetchedAt: number | undefined;
  /** Refetch now, keeping what is on screen (R2): a retry, or after a retire. */
  reload: () => void;
}

/**
 * The worktree half of the cleanup queue, beside the pull-request inventory
 * and gated the same way: `active` is "the Pull Requests section is visible".
 */
export function useIdleWorktrees(active: boolean): IdleWorktrees {
  const { state, reload } = useFetchState<IdleWorktreesResponse>(
    IDLE_KEY,
    useCallback(() => fetchIdleWorktrees(), []),
    { enabled: active },
  );
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(reload, IDLE_POLL_MS);
    return () => clearInterval(timer);
  }, [active, reload]);
  // Once per state change: it travels into a memoized sidebar.
  const worktrees = useMemo(
    () => mapData(state, (response) => response.worktrees),
    [state],
  );
  const fetchedAt =
    state.status === "ready" || state.status === "refreshing"
      ? state.data.fetchedAt
      : undefined;
  return { state: worktrees, fetchedAt, reload };
}
