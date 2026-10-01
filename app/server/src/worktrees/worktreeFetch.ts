/**
 * Background `git fetch` for the repositories behind worktrees, so the `behind`
 * counts in `worktreeStatus.ts` mean something.
 *
 * Those counts are computed from LOCAL refs. Without a fetch they are only as
 * current as whenever you last pulled by hand, which makes the most useful
 * answer the surface can give — "main has 5 commits to pull" — the one it is
 * least able to give honestly. Every status therefore carries `fetchedAt`, and
 * a consumer that renders a `behind` number must degrade when it is old rather
 * than assert freshness.
 *
 * THREE deliberate scoping rules:
 *
 * 1. PER REPOSITORY, not per worktree. Linked worktrees share one object store
 *    and one set of remote-tracking refs, so a project with eight worktrees
 *    costs ONE fetch, keyed on the git common dir (`repoLockKey`).
 * 2. ONLY ON DEMAND, at the globally configured cadence. A repo is fetched
 *    while a surface has read its status recently or when worktree creation asks
 *    once before taking the repo lock; zero configured minutes disables both
 *    paths without discarding freshness state.
 * 3. PRODUCTION ONLY (`ASSISTANT_BACKGROUND_FETCH`, set in the prod service's
 *    own environment rather than the shared base env). Preview instances share
 *    production's `projectsRoot` and worktrees, so every live preview running
 *    this timer would mean N processes fetching the same repositories.
 *
 * It does NOT take `withRepoLock`, under the network-bound exception defined in
 * `../CLAUDE.md`. That lock is a mutex keyed on the git common dir, so holding
 * it for a call that can run for minutes would stall every commit, `worktree
 * add` and merge on the whole project behind a background refresh — the same
 * reason submodule setup and pushes run outside it.
 *
 * Our own overlap is prevented by the in-flight map here. Cross-process safety
 * rests on Git's OWN per-ref locking plus retry, NOT on exclusive ownership of
 * remote-tracking refs: `git push` updates those too, so nothing here owns
 * them. A loser fails the ref it was writing and the next sweep picks it up, so
 * the failure mode is a late number rather than a damaged repository.
 *
 * What the exception does NOT cover is `FETCH_HEAD`, which every fetch writes
 * unless told not to. It is per-working-tree, and this one runs in the MAIN
 * checkout — exactly where `worktreeSync.ts` reads it under the lock to decide
 * what to rebase onto ("pull main" is a `pull-rebase` on that checkout). A
 * background sweep landing between that locked fetch and its read would hand
 * the rebase whatever `--all` fetched last, so this fetch takes
 * `--no-write-fetch-head` and reads `FETCH_HEAD` never. See
 * {@link backgroundFetchArgs}.
 */
import { BACKGROUND_FETCH_ENABLED } from "../config.ts";
import { gitOptional, repoLockKey } from "../gitExec.ts";
import { getSettings } from "../settings.ts";

const MINUTE_MS = 60_000;
/**
 * Check due-ness independently of the configured cadence. Fifteen seconds keeps
 * even the shortest supported cadence (one minute) within one quarter-tick.
 */
const SWEEP_INTERVAL_MS = 15_000;
/** Minimum time a status read keeps a repo "interesting" after the fact. */
const MIN_INTEREST_TTL_MS = 15 * MINUTE_MS;
/** A fetch that has not finished by now is not worth waiting for. */
const FETCH_TIMEOUT_MS = 90_000;

function fetchIntervalMs(): number {
  return getSettings().worktrees.remoteFetchMinutes * MINUTE_MS;
}

function interestTtlMs(fetchInterval: number): number {
  return Math.max(MIN_INTEREST_TTL_MS, Math.ceil(fetchInterval * 1.5));
}

/**
 * Non-interactive: a credential or host-key prompt must fail fast rather than
 * hang a background timer forever with no tty to answer it.
 */
const FETCH_ENV = {
  GIT_TERMINAL_PROMPT: "0",
  GIT_SSH_COMMAND:
    "ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new -o ConnectTimeout=10",
};

interface RepoState {
  path: string;
  /** When a surface last read a status from this repo. */
  interestAt: number;
  /** When we last COMPLETED a fetch, successfully or not. */
  fetchedAt?: number;
}

const repos = new Map<string, RepoState>();
const inFlight = new Map<string, Promise<void>>();
let sweeper: ReturnType<typeof setInterval> | undefined;

/**
 * Repos a client is CURRENTLY watching, asked fresh on every sweep.
 *
 * A remembered "last read a status" timestamp is not enough on its own: a
 * browser can hold the inbox open for hours without anything local changing, so
 * no status is recomputed, the recorded interest ages out, and the repo is
 * quietly dropped — the open surface goes stale precisely because it is calm.
 * Asking who is watching cannot decay.
 */
let interestSource: (() => string[]) | undefined;

export function setFetchInterestSource(
  source: (() => string[]) | undefined,
): void {
  interestSource = source;
}

type FetchListener = (repoPath: string, fetchedAt: number) => void;
const completionListeners = new Set<FetchListener>();

/**
 * Notified after every SUCCESSFUL fetch, including one that changed nothing.
 *
 * A no-op fetch writes no refs, so the filesystem watcher sees nothing and
 * would never broadcast — leaving the card's "as of" marker frozen at the last
 * fetch that happened to move a ref. Freshness is a fact about the FETCH, not
 * about whether it found anything.
 */
export function onFetchCompleted(listener: FetchListener): () => void {
  completionListeners.add(listener);
  return () => completionListeners.delete(listener);
}

/**
 * Record that something is looking at this repository, and report when its
 * remote refs were last refreshed. Called from the status path, which is the
 * one place that knows a surface actually wants these numbers.
 */
export function noteRepoInterest(
  repoKey: string,
  repoPath: string,
): number | undefined {
  const existing = repos.get(repoKey);
  if (existing) {
    existing.interestAt = Date.now();
    return existing.fetchedAt;
  }
  repos.set(repoKey, { path: repoPath, interestAt: Date.now() });
  return undefined;
}

/** When this repo's remote-tracking refs were last refreshed, if ever. */
export function repoFetchedAt(repoKey: string): number | undefined {
  return repos.get(repoKey)?.fetchedAt;
}

/**
 * The sweep's exact argv, so the isolation the lock exception claims is a
 * TESTABLE fact rather than a comment. `--no-write-fetch-head` is the part that
 * earns the exception: without it this lock-free fetch writes the main
 * checkout's `FETCH_HEAD`, which locked operations read as a rebase target.
 */
export function backgroundFetchArgs(): string[] {
  return ["fetch", "--prune", "--quiet", "--no-write-fetch-head", "--all"];
}

/**
 * Fetch one repository's remotes. Coalesced per repo, never awaited by a
 * request path, and failure-tolerant: an unreachable remote or a missing
 * credential leaves the previous `fetchedAt` in place, so the surface keeps
 * saying "as of then" instead of claiming currency it does not have.
 */
export function fetchRepoRemotes(
  repoKey: string,
  repoPath: string,
): Promise<void> {
  const running = inFlight.get(repoKey);
  if (running) return running;

  const promise = (async () => {
    const res = await gitOptional(
      backgroundFetchArgs(),
      repoPath,
      AbortSignal.timeout(FETCH_TIMEOUT_MS),
      FETCH_ENV,
    );
    const state = repos.get(repoKey) ?? {
      path: repoPath,
      interestAt: Date.now(),
    };
    // Only a SUCCESSFUL fetch may move the stamp: stamping a failure would
    // present stale counts as fresh, which is the one thing this must not do.
    if (res.code === 0) {
      state.fetchedAt = Date.now();
      repos.set(repoKey, state);
      // Announce it even when nothing moved — see `onFetchCompleted`.
      for (const listener of completionListeners) {
        try {
          listener(repoPath, state.fetchedAt);
        } catch {
          // A listener must never be able to break the fetch loop.
        }
      }
      return;
    }
    repos.set(repoKey, state);
  })()
    .catch(() => undefined)
    .finally(() => inFlight.delete(repoKey));

  inFlight.set(repoKey, promise);
  return promise;
}

/** Fetch now if due, without making a status or creation caller wait for it. */
export function fetchRepoIfDue(repoKey: string, repoPath: string): void {
  if (!BACKGROUND_FETCH_ENABLED) return;
  const fetchInterval = fetchIntervalMs();
  if (fetchInterval === 0) return;
  const state = repos.get(repoKey);
  if (state?.fetchedAt && Date.now() - state.fetchedAt < fetchInterval) return;
  void fetchRepoRemotes(repoKey, repoPath);
}

/** Resolve a checkout path to its repo key and record interest in one step. */
export async function noteWorktreeInterest(
  repoPath: string,
): Promise<string | undefined> {
  try {
    return await repoLockKey(repoPath);
  } catch {
    return undefined;
  }
}

function sweep(): void {
  if (!BACKGROUND_FETCH_ENABLED) return;
  const fetchInterval = fetchIntervalMs();
  if (fetchInterval === 0) return;
  const interestTtl = interestTtlMs(fetchInterval);
  const now = Date.now();
  // Anything a client is watching RIGHT NOW is interesting, whatever the
  // recorded timestamps say. This is the half that cannot decay under an idle
  // but open surface.
  const watched = new Set(interestSource?.() ?? []);
  for (const path of watched) {
    const existing = [...repos.entries()].find(
      ([, state]) => state.path === path,
    );
    if (existing) existing[1].interestAt = now;
  }
  for (const [key, state] of repos) {
    if (!watched.has(state.path) && now - state.interestAt > interestTtl) {
      // Nobody is watching and nobody has looked in a while: stop fetching, and
      // forget the repo so a long-lived process does not accumulate every repo
      // it has ever seen.
      repos.delete(key);
      continue;
    }
    if (state.fetchedAt && now - state.fetchedAt < fetchInterval) continue;
    void fetchRepoRemotes(key, state.path);
  }
}

/** Start the sweeper. A no-op unless this instance is the one that fetches. */
export function startBackgroundFetch(): void {
  if (!BACKGROUND_FETCH_ENABLED || sweeper) return;
  sweeper = setInterval(sweep, SWEEP_INTERVAL_MS);
  sweeper.unref?.();
}

export function stopBackgroundFetch(): void {
  if (sweeper) clearInterval(sweeper);
  sweeper = undefined;
}

/** Test seam: forget every repo and stop the timer. */
export function resetBackgroundFetchForTests(): void {
  stopBackgroundFetch();
  repos.clear();
  inFlight.clear();
  completionListeners.clear();
  interestSource = undefined;
}

/** Test seam: run one sweep without waiting for the interval. */
export function sweepBackgroundFetchForTests(): void {
  sweep();
}
