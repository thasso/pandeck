import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  PullRequestInventoryItem,
  PullRequestInventoryResponse,
} from "@assistant/shared";
import { useFetchState } from "./useFetchState.ts";
import {
  fetchPullRequestInventory,
  refreshPullRequestInventory,
} from "../lib/pullRequestsApi.ts";
import { failed, loading, mapData, type LoadState } from "../lib/loadState.ts";
import { showToast, TOAST_DWELL_MS } from "../lib/toast.ts";

/**
 * While a Pull Requests surface is on screen. This polls the server's local
 * persisted snapshot; provider refresh runs independently in the server. Keeping
 * the browser poll scoped to a visible surface still avoids useless HTTP work.
 */
const INVENTORY_POLL_MS = 60_000;

/** One inventory, fetched once for the whole app. */
const INVENTORY_KEY = "pull-requests";

export interface PullRequestInventory {
  /** The listed pull requests, in the five-state model. */
  state: LoadState<PullRequestInventoryItem[]>;
  /** Oldest project refresh represented. Absent until a snapshot lands. */
  fetchedAt: number | undefined;
  /** Refetch now, keeping what is on screen (R2) — the retry behind an `ErrorNote`. */
  reload: () => void;
  /**
   * Have the server read the PROVIDERS now, past its caches, then refetch.
   * `reload` only re-reads the server's snapshot, which it rebuilds every five
   * minutes; this is the user's Refresh. A press while one runs is ignored.
   */
  refresh: () => void;
  /** A `refresh` is running; rows stay on screen under the indicator (R2). */
  refreshing: boolean;
  /**
   * Counts `refresh` presses, bumped when one STARTS: a surface with reads of
   * its own (the detail page's conversation) re-reads them on a change.
   */
  refreshCount: number;
}

/**
 * The app's pull-request projection: ONE poller for the section's browser and
 * the detail page alike.
 *
 * The detail page deliberately has no fetch of its own. It addresses a pull
 * request the inventory already carries, and a second read could let the two
 * surfaces disagree about the same pull request.
 *
 * `active` is "a Pull Requests surface is visible", and it is the whole gate: a
 * window parked on a conversation asks for nothing. Going inactive parks the
 * fetch state at `idle` and drops the data, so the next visit performs a real
 * first load rather than painting an answer of unknown age as current — moving
 * between the index and a detail route keeps ONE key, so that navigation never
 * blanks.
 */
export function usePullRequestInventory(active: boolean): PullRequestInventory {
  const { state, reload } = useFetchState<PullRequestInventoryResponse>(
    INVENTORY_KEY,
    useCallback(
      (_key: string, signal: AbortSignal) => fetchPullRequestInventory(signal),
      [],
    ),
    { enabled: active },
  );

  // Polling is a REFRESH of the same key, never a new one: the rows stay on
  // screen under a `RefreshIndicator` instead of flashing back to skeletons
  // every minute (R2).
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(reload, INVENTORY_POLL_MS);
    return () => clearInterval(timer);
  }, [active, reload]);

  // Projected once per state change rather than per render: this travels into
  // memoized rows and into `useMemo` dependency lists, and a fresh array every
  // render would defeat both.
  const items = useMemo(() => {
    if (
      (state.status === "ready" || state.status === "refreshing") &&
      state.data.status === "cold"
    )
      return loading<PullRequestInventoryItem[]>();
    if (state.status === "error" && state.data?.status === "cold")
      return failed<PullRequestInventoryItem[]>(state.error);
    return mapData(state, (response) => response.items);
  }, [state]);
  const fetchedAt =
    (state.status === "ready" || state.status === "refreshing") &&
    state.data.status === "ready"
      ? state.data.fetchedAt
      : undefined;

  const [refreshing, setRefreshing] = useState(false);
  const [refreshCount, setRefreshCount] = useState(0);
  // The guard is a ref: two presses inside one render would both read a
  // stale `refreshing`.
  const refreshingRef = useRef(false);
  const refresh = useCallback(() => {
    if (refreshingRef.current) return;
    refreshingRef.current = true;
    setRefreshing(true);
    setRefreshCount((count) => count + 1);
    void refreshPullRequestInventory()
      .then(
        // The answer IS the new snapshot, but it reaches the screen through
        // the one keyed read, so the poll and this cannot disagree.
        () => reload(),
        (err: unknown) => {
          showToast(
            `Pull requests could not be refreshed: ${
              err instanceof Error ? err.message : String(err)
            }`,
            { tone: "error", durationMs: TOAST_DWELL_MS },
          );
        },
      )
      .finally(() => {
        refreshingRef.current = false;
        setRefreshing(false);
      });
  }, [reload]);
  return {
    state: items,
    fetchedAt,
    reload,
    refresh,
    refreshing,
    refreshCount,
  };
}
