/**
 * Worktree-facing bridge to the git hosting seam (`../gitHosting.ts`): PR/CI
 * status for the worktree's branch + HEAD, and user-initiated PR creation.
 * Served by worktreeHttp.ts as GET `hosting` / POST `create-pr`.
 *
 * Status is TTL-cached per worktree — the strip polls while visible and
 * multiple clients may look at the same worktree; the hosting API doesn't
 * need to be hit for each of them. `worktreeHostingStatuses` serves the
 * Worktrees inbox over that same cache.
 *
 * A failed PULL-REQUEST lookup propagates out of here rather than degrading to
 * an empty payload: an empty payload is indistinguishable from "no PR, no CI",
 * so swallowing that outage would render it as a list of clean-looking
 * branches. The bulk path omits such a row; the single-worktree endpoint
 * answers 500 and its one caller already degrades.
 *
 * A provider with a batched read (GitHub: one GraphQL query per repository)
 * answers every row of a repository together, all or nothing; the per-row path
 * below is for providers without one.
 *
 * The other reads are ISOLATED from it. CI belongs to the local HEAD and the
 * review to the pull request, and an ANSWERED pull request must not disappear
 * because one of them is down — the Pull Requests inventory reads this
 * projection to find the merged pull request a checkout is still waiting on, so
 * losing the row over an unrelated CI outage would hide work that exists. Their
 * absence already means unknown in this payload, which is the honest answer. No
 * failure is ever cached, partial or total: the next caller may get a real one.
 */
import type {
  ProjectPullRequests,
  WorktreeCreatePrRequest,
  WorktreeCreatePrResponse,
  WorktreeHostingStatusResponse,
} from "@assistant/shared";
import { gitOptional, resolveRepoRoot } from "../gitExec.ts";
import type { WorktreeRow } from "../db/worktreeStore.ts";
import {
  hostingProviderForRepo,
  repositoryCapabilitiesFor,
  type BranchStatus,
  type GitHostingProvider,
} from "../gitHosting.ts";
import { resolvePushTarget } from "../pushWorkflow.ts";
import { isMainWorktreeId } from "./worktreeResolve.ts";

const CACHE_MS = 15_000;

/** At most this many provider conversations at once, so a wide list of
 * worktrees does not open one connection per row against the same host. */
const BULK_CONCURRENCY = 4;

const cache = new Map<
  string,
  { at: number; payload: WorktreeHostingStatusResponse }
>();

export function invalidateWorktreeHosting(worktreeId: string): void {
  cache.delete(worktreeId);
}

async function hostingProviderForWorktree(row: WorktreeRow) {
  if (isMainWorktreeId(row.id)) return hostingProviderForRepo(row.path);
  // A spawned branch's upstream is its publication repository. This must match
  // checked managed PR creation; falling back to origin preserves the ordinary
  // pre-publication status path when no unambiguous target exists yet.
  const remote = await resolveRepoRoot(row.path)
    .then((repoRoot) => resolvePushTarget(repoRoot, row.branch))
    .then((target) => target.remote)
    .catch(() => undefined);
  return hostingProviderForRepo(row.path, remote);
}

interface ResolvedRow {
  row: WorktreeRow;
  provider: GitHostingProvider | null;
  /** The local HEAD, or "" when it could not be read. */
  head: string;
}

async function resolveRow(row: WorktreeRow): Promise<ResolvedRow> {
  const provider = await hostingProviderForWorktree(row);
  if (!provider) return { row, provider, head: "" };
  const headRes = await gitOptional(
    ["rev-parse", "--verify", "HEAD"],
    row.path,
  );
  return {
    row,
    provider,
    head: headRes.code === 0 ? headRes.stdout.trim() : "",
  };
}

export async function worktreeHostingStatus(
  row: WorktreeRow,
): Promise<WorktreeHostingStatusResponse> {
  const cached = cache.get(row.id);
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.payload;
  const [answer] = await readStatuses([await resolveRow(row)]);
  if (answer!.status === "rejected") throw answer!.reason;
  return answer!.value;
}

/**
 * Answer (and cache) resolved rows, in input order. Rows of one repository
 * whose provider has a batched read share ONE provider request — all answered
 * or all rejected — and every other row takes the per-row reads.
 */
async function readStatuses(
  rows: ResolvedRow[],
): Promise<PromiseSettledResult<WorktreeHostingStatusResponse>[]> {
  const results: PromiseSettledResult<WorktreeHostingStatusResponse>[] =
    new Array(rows.length);
  const batches = new Map<
    string,
    { provider: GitHostingProvider; indexes: number[] }
  >();
  const jobs: Array<() => Promise<void>> = [];
  rows.forEach((resolved, index) => {
    const { provider } = resolved;
    if (provider?.branchStatuses) {
      const key = `${provider.kind} ${provider.repoWebUrl}`;
      const batch = batches.get(key) ?? { provider, indexes: [] };
      batch.indexes.push(index);
      batches.set(key, batch);
      return;
    }
    jobs.push(async () => {
      results[index] = await settle(perRowStatus(resolved));
    });
  });
  for (const { provider, indexes } of batches.values())
    jobs.push(async () => {
      const members = indexes.map((index) => rows[index]!);
      try {
        const answers = await provider.branchStatuses!(
          members.map(({ row, head }) => ({
            // The main checkout IS the base branch; a PR for it is meaningless.
            branch: isMainWorktreeId(row.id) ? null : row.branch,
            headSha: head || null,
          })),
        );
        await Promise.all(
          indexes.map(async (index, position) => {
            results[index] = await settle(
              batchedStatus(members[position]!, answers[position]!),
            );
          }),
        );
      } catch (err) {
        for (const index of indexes)
          results[index] = { status: "rejected", reason: err };
      }
    });
  const workers = Array.from(
    { length: Math.min(BULK_CONCURRENCY, jobs.length) },
    async () => {
      for (let job = jobs.shift(); job; job = jobs.shift()) await job();
    },
  );
  await Promise.all(workers);
  return results;
}

function settle<T>(promise: Promise<T>): Promise<PromiseSettledResult<T>> {
  return promise.then(
    (value) => ({ status: "fulfilled", value }),
    (reason: unknown) => ({ status: "rejected", reason }),
  );
}

/**
 * Capabilities decide which merge methods the page may OFFER, so they are read
 * whenever there is an open pull request to merge. Their own cache coalesces
 * this across worktrees of the same repository, and an unknown answer travels
 * as unknown: the picker then offers nothing.
 */
async function hostingPayload(
  row: WorktreeRow,
  provider: GitHostingProvider,
  { pr, ci, review }: BranchStatus,
): Promise<WorktreeHostingStatusResponse> {
  const capabilities =
    pr && pr.state === "open"
      ? await repositoryCapabilitiesFor(provider)
      : undefined;
  return {
    worktreeId: row.id,
    provider: provider.kind,
    repoWebUrl: provider.repoWebUrl,
    ...(pr ? { pr } : {}),
    ...(ci ? { ci } : {}),
    ...(review ? { review } : {}),
    ...(capabilities ? { capabilities } : {}),
  };
}

/** A batched answer came in whole, so its payload is never degraded. */
async function batchedStatus(
  { row, provider }: ResolvedRow,
  answer: BranchStatus,
): Promise<WorktreeHostingStatusResponse> {
  const payload = await hostingPayload(row, provider!, answer);
  cache.set(row.id, { at: Date.now(), payload });
  return payload;
}

async function perRowStatus({
  row,
  provider,
  head,
}: ResolvedRow): Promise<WorktreeHostingStatusResponse> {
  let payload: WorktreeHostingStatusResponse = { worktreeId: row.id };
  // Set by any read that failed WITHOUT taking the payload down with it; such a
  // payload is answered but not cached, so the failure is retried next time.
  let degraded = false;
  if (provider) {
    const [prRead, ciRead] = await Promise.allSettled([
      // The main checkout IS the base branch; a PR for it is meaningless.
      isMainWorktreeId(row.id)
        ? Promise.resolve(null)
        : provider.findPullRequestForBranch(row.branch),
      head ? provider.ciStatus(head) : Promise.resolve(null),
    ]);
    // The pull-request lookup is the one read this payload cannot be honest
    // without: it propagates.
    if (prRead.status === "rejected") throw prRead.reason;
    const pr = prRead.value;
    if (ciRead.status === "rejected") degraded = true;
    const ci = ciRead.status === "fulfilled" ? ciRead.value : null;
    // The review is a SECOND round trip and only an OPEN pr has one, so it is
    // asked for after the PR is known rather than speculatively for every row.
    // A merged/closed PR is reported as-is: `merged` is what ends a branch.
    const review =
      pr && pr.state === "open"
        ? await provider.pullRequestReview(pr.number).catch(() => {
            degraded = true;
            return null;
          })
        : null;
    payload = await hostingPayload(row, provider, { pr, ci, review });
  }
  if (!degraded) cache.set(row.id, { at: Date.now(), payload });
  return payload;
}

/**
 * Open pull requests per project, keyed off each project's MAIN checkout —
 * a PR belongs to the repository, not to whichever worktree happens to exist,
 * and the whole point of this list is the PRs you have NO worktree for.
 *
 * Cached with a longer TTL than per-worktree status: a PR list changes on human
 * time, and this is a browse surface rather than a state indicator. A project
 * whose provider could not be listed is omitted, same rule as above.
 */
const PR_CACHE_MS = 60_000;
const prCache = new Map<
  string,
  { at: number; payload: ProjectPullRequests | null; failed: boolean }
>();

/**
 * Bumped by every {@link invalidateProjectPullRequests}. A list read that
 * STARTED before an invalidation describes the repository from before the
 * change, so it still answers its caller but must not be written into the
 * cache — otherwise the refetch an action makes right after merging would
 * repopulate the very entry it dropped. It is one counter for all projects
 * because the cost of a missed WRITE is one extra read, while the cost of a
 * stale one is a merged pull request offered for merging again.
 */
let prCacheGeneration = 0;

/**
 * Forget one project's open pull requests (or every project's), because
 * something just changed one of them.
 *
 * The list stands for 60 s, which suits the background inventory cadence and
 * not the refresh that follows an action on a pull request IN it: a merge that
 * landed must not come back as open. `pullRequestInventory.ts` has the matching
 * per-pull-request invalidator; both are needed, since the inventory folds the
 * two reads.
 */
export function invalidateProjectPullRequests(projectId?: string): void {
  prCacheGeneration += 1;
  if (projectId === undefined) prCache.clear();
  else prCache.delete(projectId);
}

export interface ProjectPullRequestRead {
  lists: ProjectPullRequests[];
  /** Projects whose provider read failed; their persisted inventory stays put. */
  failedProjectIds: string[];
}

export async function projectPullRequestsWithFailures(
  mains: WorktreeRow[],
): Promise<ProjectPullRequestRead> {
  const out: ProjectPullRequests[] = [];
  const failedProjectIds = new Set<string>();
  const queue = mains.filter((row) => isMainWorktreeId(row.id));
  const workers = Array.from(
    { length: Math.min(BULK_CONCURRENCY, queue.length) },
    async () => {
      for (let row = queue.shift(); row; row = queue.shift()) {
        const cached = prCache.get(row.projectId);
        if (cached && Date.now() - cached.at < PR_CACHE_MS) {
          if (cached.payload) out.push(cached.payload);
          if (cached.failed) failedProjectIds.add(row.projectId);
          continue;
        }
        const generation = prCacheGeneration;
        let payload: ProjectPullRequests | null = null;
        let failed = false;
        try {
          const provider = await hostingProviderForRepo(row.path);
          const pulls = provider ? await provider.listOpenPullRequests() : null;
          if (provider && pulls) {
            payload = {
              projectId: row.projectId,
              provider: provider.kind,
              repoWebUrl: provider.repoWebUrl,
              pullRequests: pulls,
            };
          }
        } catch {
          payload = null;
          failed = true;
        }
        if (generation === prCacheGeneration)
          prCache.set(row.projectId, { at: Date.now(), payload, failed });
        if (payload) out.push(payload);
        if (failed) failedProjectIds.add(row.projectId);
      }
    },
  );
  await Promise.all(workers);
  return { lists: out, failedProjectIds: [...failedProjectIds] };
}

/**
 * Hosting state for MANY worktrees, for the Worktrees inbox — which needs every
 * row's PR/CI to order the list, and cannot make one request per card.
 *
 * A row is OMITTED rather than returned empty when the read that throws is the
 * one the payload cannot be honest without — provider resolution or the
 * pull-request lookup: the inbox reads a missing entry as unknown and an empty
 * one as "no PR, no CI", so inventing the second from a failure would quietly
 * turn an outage into a list of clean-looking branches. A failed CI or review
 * read keeps the row, per the isolation described above. Per-row TTL caching is
 * shared with the single-worktree path, so an open detail page and this list do
 * not double up.
 */
export interface WorktreeHostingStatusRead {
  statuses: WorktreeHostingStatusResponse[];
  /** Worktrees whose provider identity or pull-request lookup failed. */
  failedWorktreeIds: string[];
}

export async function worktreeHostingStatuses(
  rows: WorktreeRow[],
): Promise<WorktreeHostingStatusResponse[]> {
  return (await worktreeHostingStatusesWithFailures(rows)).statuses;
}

export async function worktreeHostingStatusesWithFailures(
  rows: WorktreeRow[],
): Promise<WorktreeHostingStatusRead> {
  const out: WorktreeHostingStatusResponse[] = [];
  const failedWorktreeIds = new Set<string>();
  const misses: WorktreeRow[] = [];
  for (const row of rows) {
    const cached = cache.get(row.id);
    if (cached && Date.now() - cached.at < CACHE_MS) out.push(cached.payload);
    else misses.push(row);
  }
  const resolved: ResolvedRow[] = [];
  const queue = [...misses];
  const workers = Array.from(
    { length: Math.min(BULK_CONCURRENCY, queue.length) },
    async () => {
      for (let row = queue.shift(); row; row = queue.shift()) {
        try {
          resolved.push(await resolveRow(row));
        } catch {
          failedWorktreeIds.add(row.id);
        }
      }
    },
  );
  await Promise.all(workers);
  const answers = await readStatuses(resolved);
  answers.forEach((answer, index) => {
    if (answer.status === "fulfilled") out.push(answer.value);
    // Omit: absence means unknown, and preserve this project's persisted
    // inventory rather than turning an outage into a confident deletion.
    else failedWorktreeIds.add(resolved[index]!.row.id);
  });
  return { statuses: out, failedWorktreeIds: [...failedWorktreeIds] };
}

export async function createWorktreePullRequest(
  row: WorktreeRow,
  input: WorktreeCreatePrRequest,
): Promise<WorktreeCreatePrResponse> {
  if (isMainWorktreeId(row.id))
    throw new Error(
      "The main checkout has no branch to open a pull request for.",
    );
  const title = input.title?.trim();
  if (!title) throw new Error("Pull request title cannot be empty.");
  const provider = await hostingProviderForRepo(row.path);
  if (!provider)
    throw new Error(
      "No git hosting provider is configured for this repository.",
    );
  const bodyValue = input.body?.trim() || undefined;
  const pr = await provider.createPullRequest({
    title,
    ...(bodyValue !== undefined ? { body: bodyValue } : {}),
    head: row.branch,
    base: row.baseBranch,
  });
  invalidateWorktreeHosting(row.id);
  invalidateProjectPullRequests(row.projectId);
  void import("../pullRequestInventorySync.ts")
    .then((sync) => sync.invalidatePullRequestInventorySnapshot())
    .catch(() => undefined);
  return { worktreeId: row.id, pr };
}
