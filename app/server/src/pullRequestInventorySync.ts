/**
 * Provider-backed Pull Requests inventory refresh.
 *
 * This is the only periodic caller of `buildPullRequestInventory`. It merges a
 * completed build into a versioned cache file; `GET /api/pull-requests` serves
 * that local snapshot without touching a provider. Refreshes coalesce so
 * startup, the timer, and a mutation hint cannot fan out duplicate reads.
 */
import type { PullRequestInventoryResponse } from "@assistant/shared";
import { BACKGROUND_PR_SYNC_ENABLED } from "./config.ts";
import { errorText } from "./errors.ts";
import { forgetOpenPullAnnotations } from "./gitHosting.ts";
import { GITHUB_WEB_BASE } from "./githubClient.ts";
import { normalizeForgejoBaseUrl } from "./forgejoClient.ts";
import {
  buildPullRequestInventory,
  invalidatePullRequestInventoryReads,
  type PullRequestInventoryBuild,
} from "./pullRequestInventory.ts";
import {
  pullRequestInventoryResponse,
  readPullRequestInventorySnapshot,
  writePullRequestInventorySnapshot,
  type PullRequestInventorySnapshot,
} from "./pullRequestInventorySnapshot.ts";
import { pullRequestIdentity } from "./pullRequestIdentity.ts";
import { invalidateProjectPullRequests } from "./worktrees/worktreeHosting.ts";
import { listWorktreeRows } from "./worktrees/worktrees.ts";

/**
 * Five minutes: GitHub's REST budget (5,000/hour) is shared with every agent
 * tool, and a one-minute loop over a normal set of worktrees spent most of it.
 * Actions that change a pull request refresh immediately anyway.
 */
const REFRESH_INTERVAL_MS = 5 * 60_000;
const BUILD_TIMEOUT_MS = 90_000;
/** Invalidations this close together (a batch of removals) share one build. */
const REQUEST_COALESCE_MS = 2_000;
const FAILURE_BACKOFF_MS = [5 * 60_000, 15 * 60_000, 30 * 60_000];

export interface PullRequestInventorySyncOperations {
  build(): Promise<PullRequestInventoryBuild>;
  read(): PullRequestInventorySnapshot | null;
  write(snapshot: PullRequestInventorySnapshot): void;
  now(): number;
  /** Test override; production builds have one bounded deadline. */
  timeoutMs?: number;
}

const defaultOperations: PullRequestInventorySyncOperations = {
  async build() {
    return buildPullRequestInventory(await listWorktreeRows());
  },
  read: readPullRequestInventorySnapshot,
  write: writePullRequestInventorySnapshot,
  now: Date.now,
};

let operations = defaultOperations;
let inFlight: Promise<PullRequestInventoryResponse> | undefined;
let timer: ReturnType<typeof setTimeout> | undefined;
let started = false;
let consecutiveFailures = 0;
/** A provider mutation invalidates every build that started before it. */
let epoch = 0;
let requestTimer: ReturnType<typeof setTimeout> | undefined;
/**
 * The last build started, settled or not. A build that missed its deadline is
 * abandoned, not stopped: it keeps running, and starting the next one beside
 * it doubled the provider and git load it was already too slow for.
 */
let runningBuild: Promise<void> | undefined;

/** Refresh now, sharing one provider-backed build with concurrent callers. */
export function refreshPullRequestInventorySnapshot(): Promise<PullRequestInventoryResponse> {
  if (inFlight) return inFlight;

  const refresh = refreshUntilCurrent()
    .then(
      (response) => {
        // Per-project failures already retain that project's previous rows. A
        // completed build must keep healthy projects on the normal cadence;
        // only rejection of the whole build drives the global backoff.
        consecutiveFailures = 0;
        return response;
      },
      (err) => {
        consecutiveFailures += 1;
        throw err;
      },
    )
    .finally(() => {
      if (inFlight === refresh) inFlight = undefined;
    });
  inFlight = refresh;
  return refresh;
}

async function refreshUntilCurrent(): Promise<PullRequestInventoryResponse> {
  const timeoutMs = operations.timeoutMs ?? BUILD_TIMEOUT_MS;
  for (;;) {
    if (runningBuild) await settledOrAfter(runningBuild, timeoutMs);
    // Taken after the wait: a mutation during it is already visible to the
    // build that starts now, which must not be discarded for it.
    const startedAtEpoch = epoch;
    const pending = operations.build();
    const tracked = pending.then(
      () => undefined,
      () => undefined,
    );
    runningBuild = tracked;
    void tracked.then(() => {
      if (runningBuild === tracked) runningBuild = undefined;
    });
    const build = await withDeadline(pending, timeoutMs);
    // A merge/checkout invalidated the world this build describes. Do not let
    // its late answer put an open PR or old local join back into the snapshot.
    if (startedAtEpoch !== epoch) continue;

    const snapshot = mergePullRequestInventoryBuild(
      operations.read(),
      build,
      operations.now(),
    );
    operations.write(snapshot);
    return pullRequestInventoryResponse(snapshot);
  }
}

/** Wait for `promise` to settle, but never longer than `ms`. */
async function settledOrAfter(
  promise: Promise<void>,
  ms: number,
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    promise,
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, ms);
      timer.unref?.();
    }),
  ]);
  if (timer) clearTimeout(timer);
}

async function withDeadline<T>(
  promise: Promise<T>,
  timeoutMs: number,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () =>
        reject(
          new Error(
            `Pull request inventory refresh timed out after ${timeoutMs} ms.`,
          ),
        ),
      timeoutMs,
    );
    timer.unref?.();
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Keep old rows for a project whose provider read failed. A successful build is
 * authoritative for that project, including an empty list. Projects no longer
 * represented by registered worktrees are swept.
 */
export function mergePullRequestInventoryBuild(
  previous: PullRequestInventorySnapshot | null,
  build: PullRequestInventoryBuild,
  builtAt: number,
): PullRequestInventorySnapshot {
  const failed = new Set(build.failedProjectIds);
  const projects: PullRequestInventorySnapshot["projects"] = {};
  for (const projectId of build.projectIds) {
    if (failed.has(projectId)) {
      const retained = previous?.projects[projectId];
      if (retained) projects[projectId] = retained;
      continue;
    }
    projects[projectId] = {
      fetchedAt: builtAt,
      items: build.items.filter((item) => item.projectId === projectId),
    };
  }

  // A cold cache where every project failed knows nothing. Keep it cold rather
  // than turning an outage into a confident empty inventory.
  if (
    build.projectIds.length > 0 &&
    Object.keys(projects).length === 0 &&
    failed.size === build.projectIds.length
  )
    throw new Error("No pull request provider answered the inventory refresh.");

  return { version: 1, builtAt, projects };
}

/**
 * Request a refresh without declaring an older in-flight build stale. Requests
 * are coalesced: a burst (every removal of a batch cleanup invalidates) costs
 * one build shortly after it ends, not one per request.
 */
export function requestPullRequestInventoryRefresh(): void {
  if (!BACKGROUND_PR_SYNC_ENABLED || requestTimer) return;
  requestTimer = setTimeout(() => {
    requestTimer = undefined;
    void loggedRefresh();
  }, REQUEST_COALESCE_MS);
  requestTimer.unref?.();
}

/** Mark any in-flight build obsolete without starting provider work itself. */
export function obsoletePullRequestInventoryBuild(): void {
  epoch += 1;
}

/** Invalidate an in-flight build and immediately schedule its replacement. */
export function invalidatePullRequestInventorySnapshot(): void {
  obsoletePullRequestInventoryBuild();
  requestPullRequestInventoryRefresh();
}

/**
 * A GitHub pull-request write that bypassed the provider seam (the generic PR
 * tools: create, review, reviewer/assignee changes). Forget what the open list,
 * its annotations and the per-pull-request reads hold for that repository and
 * rebuild now, rather than showing the old state for a whole sync period.
 */
export function invalidateGithubPullRequestWrite(
  owner: string,
  repo: string,
  number: number | undefined,
): void {
  forgetOpenPullAnnotations({ host: "github.com", owner, repo });
  invalidateProjectPullRequests();
  const identity =
    number === undefined
      ? undefined
      : pullRequestIdentity(
          "github",
          `${GITHUB_WEB_BASE}/${owner}/${repo}`,
          number,
        );
  if (identity) invalidatePullRequestInventoryReads(identity.key);
  invalidatePullRequestInventorySnapshot();
}

/** Forget cached Forgejo PR state after an approval-gated provider write. */
export function invalidateForgejoPullRequestWrite(
  baseUrl: string,
  owner: string,
  repo: string,
  number: number | undefined,
): void {
  const webBase = normalizeForgejoBaseUrl(baseUrl);
  forgetOpenPullAnnotations({ host: new URL(webBase).host, owner, repo });
  invalidateProjectPullRequests();
  const identity =
    number === undefined
      ? undefined
      : pullRequestIdentity("forgejo", `${webBase}/${owner}/${repo}`, number);
  if (identity) invalidatePullRequestInventoryReads(identity.key);
  invalidatePullRequestInventorySnapshot();
}

function loggedRefresh(): Promise<void> {
  return refreshPullRequestInventorySnapshot()
    .then(() => undefined)
    .catch((err) =>
      console.warn(
        "[pull-requests] background inventory refresh failed:",
        errorText(err),
      ),
    );
}

/**
 * Start the production-only refresh loop and seed a cold cache at boot.
 *
 * The delay starts after a build COMPLETES rather than at its start. The
 * per-pull-request read caches stand for the same period, so a fixed interval
 * measured start-to-start could arrive just before their expiry and refresh
 * only every other tick.
 */
export function startPullRequestInventorySync(
  options: { force?: boolean } = {},
): void {
  if ((!BACKGROUND_PR_SYNC_ENABLED && !options.force) || started) return;
  started = true;
  void loggedRefresh().finally(scheduleNext);
}

function scheduleNext(): void {
  if (!started) return;
  const delay =
    consecutiveFailures === 0
      ? REFRESH_INTERVAL_MS
      : FAILURE_BACKOFF_MS[
          Math.min(consecutiveFailures - 1, FAILURE_BACKOFF_MS.length - 1)
        ]!;
  timer = setTimeout(() => {
    timer = undefined;
    void loggedRefresh().finally(scheduleNext);
  }, delay);
  timer.unref?.();
}

export function stopPullRequestInventorySync(): void {
  started = false;
  if (timer) clearTimeout(timer);
  timer = undefined;
  if (requestTimer) clearTimeout(requestTimer);
  requestTimer = undefined;
}

/** Test seam. Set only while no refresh is in flight. */
export function setPullRequestInventorySyncOperationsForTests(
  next: PullRequestInventorySyncOperations | null,
): void {
  if (inFlight)
    throw new Error(
      "Cannot replace pull request inventory operations during a refresh.",
    );
  operations = next ?? defaultOperations;
}

/** Test seam. Call only after an awaited refresh has settled. */
export function resetPullRequestInventorySyncForTests(): void {
  stopPullRequestInventorySync();
  inFlight = undefined;
  runningBuild = undefined;
  epoch = 0;
  consecutiveFailures = 0;
  operations = defaultOperations;
}
