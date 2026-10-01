import { useCallback, useEffect, useMemo } from "react";
import type {
  PullRequestInventoryItem,
  PullRequestInventoryResponse,
} from "@assistant/shared";
import { useFetchState } from "./useFetchState.ts";
import { fetchPullRequestInventory } from "../lib/pullRequestsApi.ts";
import { failed, loading, mapData, type LoadState } from "../lib/loadState.ts";

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
  return { state: items, fetchedAt, reload };
}
