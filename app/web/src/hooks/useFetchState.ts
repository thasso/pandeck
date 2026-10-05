import { useCallback, useEffect, useRef, useState } from "react";
import {
  beginLoad,
  dataOf,
  failed,
  idle,
  loadErrorMessage,
  loading,
  ready,
  type LoadState,
} from "../lib/loadState.ts";

/**
 * The one request/response fetch effect (Task-361 / Task-383), replacing the
 * ~10 hand-rolled `let cancelled = false` copies.
 *
 * It is KEY-DRIVEN, and the key is what makes R2 and R3 fall out instead of
 * being remembered per surface:
 *
 *  - a NEW key is a different object, so the state drops to `loading` with no
 *    data — a day switch or entry→entry navigation can never leave the previous
 *    object's content under the new id (R3). The drop happens during render,
 *    not in the effect, so there is no frame that paints the old answer;
 *  - `reload()` on the SAME key is a refresh, so the data stays and the state
 *    is `refreshing`; a failure keeps it too and only adds the error (R2).
 *
 * A `null` key means there is nothing to fetch (inactive surface, no selection)
 * and parks the state at `idle`. Late answers are dropped by the effect's
 * cleanup AND by re-checking the key on arrival, so an in-flight request for
 * the old object cannot resolve into the new one.
 */

export interface UseFetchStateOptions<T> {
  /**
   * Fetch only while true. False parks the state at `idle` and drops any data,
   * which is what a surface behind a closed pane wants.
   */
  enabled?: boolean;
  /**
   * Browser-cached data for the first keyed paint. Mount still revalidates it,
   * entering `refreshing` without blanking the cached surface (R2).
   */
  initialData?: T;
}

export interface FetchStateResult<T> {
  state: LoadState<T>;
  /** Refetch the current key, keeping what is on screen (R2). */
  reload: () => void;
}

/** A keyed answer; the key it was fetched for travels with the state. */
interface KeyedState<T> {
  key: string | null;
  state: LoadState<T>;
}

export function useFetchState<T>(
  key: string | null,
  fetcher: (key: string, signal: AbortSignal) => Promise<T>,
  options: UseFetchStateOptions<T> = {},
): FetchStateResult<T> {
  const enabled = options.enabled ?? true;
  const target = enabled ? key : null;

  const [entry, setEntry] = useState<KeyedState<T>>(() => ({
    key: target,
    state:
      target === null
        ? idle<T>()
        : options.initialData === undefined
          ? loading<T>()
          : ready(options.initialData),
  }));
  const [nonce, setNonce] = useState(0);

  // The fetcher is read at call time so an inline closure does not restart the
  // request on every render; the key is what a caller changes to refetch.
  const fetcherRef = useRef(fetcher);
  useEffect(() => {
    fetcherRef.current = fetcher;
  });

  // R3: the key change is applied DURING render, so the first paint under the
  // new key already shows the placeholder rather than the old object.
  if (entry.key !== target) {
    setEntry({
      key: target,
      state: target === null ? idle<T>() : loading<T>(),
    });
  }

  useEffect(() => {
    if (target === null) return;
    let cancelled = false;
    const controller = new AbortController();

    setEntry((prev) => {
      if (prev.key !== target) return prev;
      const next = beginLoad(prev.state);
      return next === prev.state ? prev : { key: target, state: next };
    });

    fetcherRef.current(target, controller.signal).then(
      (data) => {
        if (cancelled) return;
        setEntry((prev) =>
          prev.key === target ? { key: target, state: ready(data) } : prev,
        );
      },
      (error: unknown) => {
        if (cancelled) return;
        setEntry((prev) =>
          prev.key === target
            ? {
                key: target,
                state: failed(loadErrorMessage(error), dataOf(prev.state)),
              }
            : prev,
        );
      },
    );

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [target, nonce]);

  const reload = useCallback(() => {
    setNonce((value) => value + 1);
  }, []);

  // `entry` is already the new key's placeholder after the render-time reset
  // above; the fallback only covers the pass React is about to discard.
  const state =
    entry.key === target
      ? entry.state
      : target === null
        ? idle<T>()
        : loading<T>();

  return { state, reload };
}

/**
 * Turn an external invalidation token into a REFRESH of the current key (R2).
 *
 * Surfaces are told their data went stale by a counter — a worktree status
 * `updatedAt` — and the naive wiring folds it into the fetch key, which blanks
 * the pane on every push. This reloads the SAME key instead, so the data stays
 * on screen while it refetches, and it
 * compares the previous key too: arriving at an object that already carries a
 * token is a first load, not an invalidation of it.
 */
export function useReloadOnToken(
  key: string | null,
  token: number,
  reload: () => void,
): void {
  const seen = useRef({ key, token });
  useEffect(() => {
    const previous = seen.current;
    seen.current = { key, token };
    if (previous.key === key && previous.token !== token) reload();
  }, [key, token, reload]);
}
