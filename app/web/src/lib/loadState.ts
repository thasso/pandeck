/**
 * The app's one async-region state (Task-361 / Task-383).
 *
 * Every surface that loads data renders exactly one of five states. Four of
 * them are statuses here; the fifth — `empty` — is not a status but a property
 * of READY data (authoritatively zero rows), which is the whole point: "no
 * items" may only be drawn once the source has actually answered.
 *
 * `refreshing` and an `error` that retained data are what make
 * stale-while-refresh the default: a second fetch of the SAME query never
 * blanks what is already on screen, and a failure adds a note beside the data
 * rather than replacing it. Dropping data is reserved for a switch to a
 * DIFFERENT object, which `hooks/useFetchState.ts` expresses as a key change.
 *
 * Framework-free by the `lib/` contract: no React, no DOM. The model is
 * `app/web/docs/loading-states.md`.
 */

export type LoadState<T> =
  /** Nothing has been asked for yet (no key, or the surface is inactive). */
  | { status: "idle" }
  /** A first fetch is running and there is nothing to show. */
  | { status: "loading" }
  /** Data is current. */
  | { status: "ready"; data: T }
  /** Data is on screen and a fetch for the same query is running. */
  | { status: "refreshing"; data: T }
  /** The fetch failed; `data` is the last good answer, when there was one. */
  | { status: "error"; error: string; data?: T };

export function idle<T>(): LoadState<T> {
  return { status: "idle" };
}

export function loading<T>(): LoadState<T> {
  return { status: "loading" };
}

export function ready<T>(data: T): LoadState<T> {
  return { status: "ready", data };
}

export function refreshing<T>(data: T): LoadState<T> {
  return { status: "refreshing", data };
}

export function failed<T>(error: string, data?: T): LoadState<T> {
  return data === undefined
    ? { status: "error", error }
    : { status: "error", error, data };
}

/** The data to render, if any — including while refreshing or after an error. */
export function dataOf<T>(state: LoadState<T>): T | undefined {
  return state.status === "ready" ||
    state.status === "refreshing" ||
    state.status === "error"
    ? state.data
    : undefined;
}

export function hasData<T>(state: LoadState<T>): boolean {
  return dataOf(state) !== undefined;
}

export function errorOf<T>(state: LoadState<T>): string | undefined {
  return state.status === "error" ? state.error : undefined;
}

/** A fetch is in flight (with or without data already shown). */
export function isPending<T>(state: LoadState<T>): boolean {
  return state.status === "loading" || state.status === "refreshing";
}

/**
 * The region has nothing to draw yet: show `PaneLoading`/skeletons, never an
 * empty state (R1).
 */
export function isInitialLoad<T>(state: LoadState<T>): boolean {
  return state.status === "loading";
}

/**
 * Authoritatively zero. False while the source is still silent, which is what
 * gates every empty state under R1 — a `?? []` fallback over an unanswered
 * source is the bug this kills.
 */
export function isEmpty<T>(
  state: LoadState<T>,
  empty: (data: T) => boolean,
): boolean {
  const data = dataOf(state);
  return data !== undefined && empty(data);
}

/**
 * Start (or restart) a fetch for the SAME query: keeps data and marks it
 * refreshing (R2), or stays a plain first load when there is nothing to keep.
 * Returns the input unchanged when nothing moves, so a caller may use identity
 * to skip a render.
 */
export function beginLoad<T>(state: LoadState<T>): LoadState<T> {
  const data = dataOf(state);
  if (data === undefined) return state.status === "loading" ? state : loading();
  return state.status === "refreshing" && state.data === data
    ? state
    : refreshing(data);
}

/**
 * Record a failure against the state it happened in: the last good data is
 * retained so the surface can keep showing it under an `ErrorNote` (R2).
 */
export function failFrom<T>(state: LoadState<T>, error: string): LoadState<T> {
  return failed(error, dataOf(state));
}

/**
 * The subscription-list bridge: `null`/`undefined` means NOT LOADED for
 * `state.taskList`, `state.projectList` and `state.worktrees`, and everything
 * else is an authoritative answer.
 */
export function fromNullable<T>(
  value: T | null | undefined,
): LoadState<NonNullable<T>> {
  return value === null || value === undefined
    ? loading()
    : ready(value as NonNullable<T>);
}

/** Project the data of a state, preserving its status and error. */
export function mapData<T, U>(
  state: LoadState<T>,
  project: (data: T) => U,
): LoadState<U> {
  switch (state.status) {
    case "idle":
      return idle();
    case "loading":
      return loading();
    case "ready":
      return ready(project(state.data));
    case "refreshing":
      return refreshing(project(state.data));
    case "error":
      return state.data === undefined
        ? failed(state.error)
        : failed(state.error, project(state.data));
  }
}

/** Normalize a thrown value into the message an `ErrorNote` can render. */
export function loadErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message || String(error);
  return String(error);
}
