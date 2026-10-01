/**
 * The Pull Requests view's inventory: every pull request that still wants
 * something from the user, in ONE projection. Served as GET `/api/pull-requests`
 * by `pullRequestHttp.ts`.
 *
 * Two sources, because the two halves of the view ask different questions:
 *
 * - WAITING ON YOU comes from each project's open pull-request list
 *   (`worktrees/worktreeHosting.ts`'s `projectPullRequests`, 60 s cache): the
 *   ones you opened plus the ones your review was requested on. A draft of
 *   yours is still yours, so drafts are listed and flagged, never hidden.
 * - NEEDS CLEANUP comes from the per-worktree hosting projection
 *   (`worktreeHostingStatuses`, 15 s cache), which already reads a branch's
 *   latest pull request in WHATEVER state. A merged or closed pull request
 *   whose head branch still has a local worktree is the cleanup queue — that
 *   checkout is the thing left to deal with, and this is what keeps the pull
 *   request visible until it is gone.
 *
 * Both are caches the worktree surfaces already fill, so an open worktree page
 * and this list coalesce onto the same provider conversations instead of
 * doubling them. `pullRequestInventorySync.ts` builds this projection in the
 * background and persists it; the HTTP view reads that local snapshot only.
 * Mergeability, the exact head and that head's CI live in neither cache, so they
 * are read per LISTED pull request through the coalescing per-read caches below.
 *
 * Everything here is keyed by REPOSITORY and number (`pullRequestIdentity.ts`),
 * never by number alone: a project's worktree may publish to a different
 * repository than its main checkout lists, and two repositories both having #7
 * is the normal case, so a number-keyed join hands one repository's sessions,
 * Tasks, authorship or review state to another's pull request.
 *
 * Absence means UNKNOWN throughout. A project whose provider could not be
 * reached contributes nothing rather than an empty slice, a failed CI/review
 * read leaves its field absent instead of inventing a clean answer, and one
 * project's failure never drops another's items.
 */
import type {
  GitHostingProviderKind,
  HostedPullRequest,
  PullRequestDetail,
  PullRequestInventoryItem,
  ProjectPullRequests,
  WorktreeCiStatus,
  WorktreeHostingStatusResponse,
  WorktreePullRequestReview,
} from "@assistant/shared";
import type { WorktreeRow } from "./db/worktreeStore.ts";
import {
  sessionIdsForWorktree,
  taskIdsForWorktree,
} from "./db/worktreeStore.ts";
import {
  hostingProviderForRepo,
  repositoryCapabilitiesFor,
  type GitHostingProvider,
} from "./gitHosting.ts";
import {
  pullRequestCardLinksByPullRequest,
  type PullRequestCardLinks,
} from "./pullRequestCards.ts";
import { pullRequestIdentity } from "./pullRequestIdentity.ts";
import { isMainWorktreeId } from "./worktrees/worktreeResolve.ts";
import {
  projectPullRequestsWithFailures,
  worktreeHostingStatusesWithFailures,
} from "./worktrees/worktreeHosting.ts";

/** At most this many provider conversations at once, as in the hosting bulk path. */
const CONCURRENCY = 4;

/**
 * How long one of the per-pull-request reads below stands. Deliberately the
 * background sync period: these reads annotate the project list, and refreshing
 * them faster would only ask the provider again about a pull request that list
 * still describes from the previous sync.
 */
const READ_CACHE_MS = 5 * 60_000;

/* ------------------------------ per-read caches ---------------------------- */

/**
 * One provider read, TTL-cached and COALESCED per pull request.
 *
 * Each read has its own store, which is what makes the failure rule work:
 * nothing but an ANSWER is ever cached, so a CI outage does not pin an absent
 * CI onto a pull request whose detail answered, and the next poll retries
 * exactly the read that failed. Concurrent callers — several browsers polling,
 * or the same build asking twice — join the in-flight promise instead of
 * issuing a second request.
 */
interface ReadStore<T> {
  values: Map<string, { at: number; value: T }>;
  inFlight: Map<string, Promise<T>>;
  /**
   * Bumped by every invalidation. A read that STARTED before one describes the
   * world from before the mutation that invalidated it, so it may still answer
   * its own caller but must never be written into the cache — otherwise an
   * action's own refetch repopulates exactly the stale answer it just dropped.
   */
  generation: number;
}

function readStore<T>(): ReadStore<T> {
  return { values: new Map(), inFlight: new Map(), generation: 0 };
}

/**
 * Above this many cached answers, expired ones are swept on the next miss. The
 * CI store is keyed by HEAD SHA, so an entry for a head nobody will ask about
 * again would otherwise sit there for the life of the process.
 */
const READ_CACHE_SWEEP_AT = 256;

async function cachedRead<T>(
  store: ReadStore<T>,
  key: string,
  read: () => Promise<T>,
): Promise<T> {
  const cached = store.values.get(key);
  if (cached && Date.now() - cached.at < READ_CACHE_MS) return cached.value;
  const inFlight = store.inFlight.get(key);
  if (inFlight) return inFlight;
  if (store.values.size > READ_CACHE_SWEEP_AT) {
    const now = Date.now();
    for (const [stale, entry] of store.values)
      if (now - entry.at >= READ_CACHE_MS) store.values.delete(stale);
  }
  const generation = store.generation;
  const promise = Promise.resolve()
    .then(read)
    .then((value) => {
      if (store.generation === generation)
        store.values.set(key, { at: Date.now(), value });
      return value;
    })
    .finally(() => {
      // Only retract OUR entry: a later call may already own the slot.
      if (store.inFlight.get(key) === promise) store.inFlight.delete(key);
    });
  store.inFlight.set(key, promise);
  return promise;
}

const detailReads = readStore<PullRequestDetail>();
const ciReads = readStore<WorktreeCiStatus | null>();
const reviewReads = readStore<WorktreePullRequestReview>();

/** Drop every cached read; the seam a test resets between cases. */
export function resetPullRequestInventoryCacheForTests(): void {
  for (const store of [detailReads, ciReads, reviewReads]) {
    store.values.clear();
    store.inFlight.clear();
    store.generation += 1;
  }
}

/**
 * Drop what this projection remembers about ONE pull request, after an action
 * changed it.
 *
 * These reads stand for 60 s, which is right for a poll and wrong for the
 * refetch an action makes immediately after merging: without this, that refetch
 * would hand the surface back the OPEN pull request the action just merged. The
 * scope is the pull request's own identity — its detail, its review, and the CI
 * of every head that identity was read for (`<key>@<sha>`) — so nothing else's
 * answer is thrown away.
 *
 * In-flight reads are dropped as well as cached ones, and the store generation
 * is bumped: a read that started before this call describes the world from
 * before the change, so it may not settle into the cache afterwards.
 */
export function invalidatePullRequestInventoryReads(key: string): void {
  for (const store of [detailReads, ciReads, reviewReads]) {
    store.generation += 1;
    for (const cached of [...store.values.keys()])
      if (cached === key || cached.startsWith(`${key}@`))
        store.values.delete(cached);
    for (const pending of [...store.inFlight.keys()])
      if (pending === key || pending.startsWith(`${key}@`))
        store.inFlight.delete(pending);
  }
}

/**
 * What a listed OPEN pull request needs beyond its list entry: the mergeability
 * and head SHA a merge decision pins itself to, the CI of that exact head, and
 * the review state. Every field is optional because every one of these reads
 * can fail, and a failed read is unknown.
 */
interface PullRequestAnnotation {
  mergeable?: boolean | null;
  headSha?: string;
  ci?: WorktreeCiStatus;
  review?: WorktreePullRequestReview;
}

/**
 * Detail, head CI and review for one OPEN pull request, each read through its
 * own cache above.
 *
 * A provider that answers `null` where the seam documents it as "could not be
 * determined" (detail, review) is treated as a failed read — unknown, never
 * cached. `ciStatus`'s `null` is a real answer ("this head has no checks") and
 * is cached as one.
 *
 * The review read is SKIPPED when the worktree projection already has one for
 * this pull request: that is the same number-keyed answer from a fresher cache.
 * Skipping writes nothing, so a later build whose worktree projection has no
 * review still performs the read. The CI read cannot be reused that way — the
 * worktree projection's CI belongs to the LOCAL head, which need not be the
 * head the provider has.
 */
async function annotate(
  key: string,
  provider: GitHostingProvider,
  number: number,
  reusedReview: WorktreePullRequestReview | undefined,
): Promise<PullRequestAnnotation> {
  // The open list may already have read all of it in the same request
  // (GitHub's GraphQL list): no per-pull-request round trip at all.
  const listed = provider.openPullRequestAnnotation?.(number);
  if (listed)
    return {
      mergeable: listed.detail.mergeable,
      ...(listed.detail.headSha ? { headSha: listed.detail.headSha } : {}),
      ...(listed.ci ? { ci: listed.ci } : {}),
      ...(reusedReview ? {} : { review: listed.review }),
    };
  const annotation: PullRequestAnnotation = {};
  const detail = await cachedRead(detailReads, key, async () => {
    const value = await provider.pullRequestDetail(number);
    if (!value) throw new Error(`Pull request #${number} could not be read.`);
    return value;
  }).catch(() => undefined);
  if (detail) {
    // `mergeable` is three-valued and `null` is a real answer ("ask again"), so
    // it is assigned whenever the detail was read at all.
    annotation.mergeable = detail.mergeable;
    if (detail.headSha) annotation.headSha = detail.headSha;
  }
  const headSha = annotation.headSha;
  if (headSha) {
    const ci = await cachedRead(ciReads, `${key}@${headSha}`, () =>
      provider.ciStatus(headSha),
    ).catch(() => null);
    if (ci) annotation.ci = ci;
  }
  if (!reusedReview) {
    const review = await cachedRead(reviewReads, key, async () => {
      const value = await provider.pullRequestReview(number);
      if (!value)
        throw new Error(`Review of #${number} could not be determined.`);
      return value;
    }).catch(() => undefined);
    if (review) annotation.review = review;
  }
  return annotation;
}

/* -------------------------------- candidates ------------------------------- */

/** A merged/closed pull request whose head branch still has a local worktree. */
interface TerminalCandidate {
  /** Repository-scoped identity; the join key for everything about it. */
  key: string;
  /** Its addressable half (`owner/repo`), which the wire item carries. */
  repositoryKey: string;
  row: WorktreeRow;
  provider: GitHostingProviderKind;
  repoWebUrl: string;
  number: number;
  url: string;
  title: string;
  state: "merged" | "closed";
}

/** One selected OPEN pull request, with the repository that listed it. */
interface OpenCandidate {
  key: string;
  repositoryKey: string;
  provider: GitHostingProviderKind;
  repoWebUrl: string;
  pull: HostedPullRequest;
}

/** Everything one project contributes, before annotation and local joins. */
interface ProjectCandidates {
  projectId: string;
  /** The project's main checkout, where its provider object is resolved from. */
  mainPath?: string;
  open: OpenCandidate[];
  terminal: TerminalCandidate[];
}

/** One pull request to project, with the context it needs. */
type InventoryUnit =
  | {
      kind: "open";
      projectId: string;
      provider: GitHostingProvider | null;
      candidate: OpenCandidate;
      /** The worktree projection's review for this exact pull request. */
      reusedReview?: WorktreePullRequestReview;
    }
  | {
      kind: "terminal";
      projectId: string;
      terminal: TerminalCandidate;
      /**
       * This SAME pull request's entry in the open list, when the 60 s list has
       * not caught up with its terminal state yet — the only thing that can
       * state authorship. Matched by identity, never by number.
       */
      listed?: HostedPullRequest;
    };

/** The hosting projection of the worktree that published one pull request. */
interface HostingByKey {
  row: WorktreeRow;
  repositoryKey: string;
  provider: GitHostingProviderKind;
  repoWebUrl: string;
  status: WorktreeHostingStatusResponse;
}

/**
 * The inventory for the worktree rows of every registered project — the same
 * `listWorktreeRows()` set the hosting endpoints take, so the main checkouts
 * (which own the PR lists) and the spawned worktrees (which own the local
 * joins) come from one read.
 */
export interface PullRequestInventoryBuild {
  items: PullRequestInventoryItem[];
  /** Every project represented by the current registered worktree rows. */
  projectIds: string[];
  /** Projects whose provider-backed source failed during this build. */
  failedProjectIds: string[];
}

/** Test-facing item-only facade; production needs the build metadata below. */
export async function pullRequestInventory(
  rows: WorktreeRow[],
): Promise<PullRequestInventoryItem[]> {
  return (await buildPullRequestInventory(rows)).items;
}

/** Build the inventory plus the failure metadata persistence needs. */
export async function buildPullRequestInventory(
  rows: WorktreeRow[],
): Promise<PullRequestInventoryBuild> {
  // Synthetic main records are never inventoried and never joined: the main
  // checkout IS the base branch, so it has no pull request of its own.
  const spawned = rows.filter(
    (row) => !isMainWorktreeId(row.id) && row.status === "active",
  );
  // Both reads have their own cache and their own bounded fan-out, and neither
  // needs the other's answer: running them together keeps one slow project from
  // serializing the other half of the inventory.
  const [listRead, hostingRead] = await Promise.all([
    projectPullRequestsWithFailures(rows),
    worktreeHostingStatusesWithFailures(spawned),
  ]);

  const hostingByKey = indexHosting(spawned, hostingRead.statuses);
  const projects = groupCandidates(rows, listRead.lists, hostingByKey);
  const cardLinks = pullRequestCardLinksByPullRequest();
  // The branch-name fallback below may only claim a worktree whose own
  // projection found NO pull request. One that did belongs to that pull request
  // — possibly in another repository, where the same branch name is another
  // piece of work — and lending it to a same-named branch elsewhere is exactly
  // the number-shaped guess this module refuses to make.
  const spokenFor = new Set(
    [...hostingByKey.values()].map((hosting) => hosting.row.id),
  );
  const worktreeByBranch = new Map(
    spawned
      .filter((row) => !spokenFor.has(row.id))
      .map((row) => [`${row.projectId}#${row.branch}`, row]),
  );

  const units = await inventoryUnits(projects);
  const items: PullRequestInventoryItem[] = [];
  const queue = [...units];
  const workers = Array.from(
    { length: Math.min(CONCURRENCY, queue.length) },
    async () => {
      for (let unit = queue.shift(); unit; unit = queue.shift()) {
        try {
          items.push(
            await inventoryItem(
              unit,
              hostingByKey,
              worktreeByBranch,
              cardLinks,
            ),
          );
        } catch {
          // One pull request's failure is its own: it drops out of the
          // inventory (absence means unknown) and every other one still
          // answers, whatever project it belongs to.
        }
      }
    },
  );
  await Promise.all(workers);

  // A stable order for a client that groups and sorts again anyway: newest pull
  // request first within a project, projects by id. The repository breaks the
  // tie, because one project may hold two repositories' #N and the fan-out
  // above finishes them in whatever order the provider answered.
  items.sort(
    (a, b) =>
      a.projectId.localeCompare(b.projectId) ||
      b.number - a.number ||
      a.repoWebUrl.localeCompare(b.repoWebUrl),
  );
  const projectByWorktree = new Map(rows.map((row) => [row.id, row.projectId]));
  const failedProjectIds = new Set(listRead.failedProjectIds);
  for (const worktreeId of hostingRead.failedWorktreeIds) {
    const projectId = projectByWorktree.get(worktreeId);
    if (projectId) failedProjectIds.add(projectId);
  }
  return {
    items,
    projectIds: [...new Set(rows.map((row) => row.projectId))].sort(),
    failedProjectIds: [...failedProjectIds].sort(),
  };
}

/**
 * The worktree projections that FOUND a pull request, by that pull request's
 * repository-scoped identity — the worktree's own publication repository, which
 * is not necessarily the one its project's main checkout lists.
 */
function indexHosting(
  spawned: WorktreeRow[],
  hostingStatuses: WorktreeHostingStatusResponse[],
): Map<string, HostingByKey> {
  const rowById = new Map(spawned.map((row) => [row.id, row]));
  const out = new Map<string, HostingByKey>();
  for (const status of hostingStatuses) {
    const row = rowById.get(status.worktreeId);
    if (!row || !status.pr || !status.provider || !status.repoWebUrl) continue;
    const identity = pullRequestIdentity(
      status.provider,
      status.repoWebUrl,
      status.pr.number,
    );
    if (!identity) continue;
    out.set(identity.key, {
      row,
      repositoryKey: identity.repositoryKey,
      provider: status.provider,
      repoWebUrl: status.repoWebUrl,
      status,
    });
  }
  return out;
}

/**
 * Fold the two source reads into one bucket per project.
 *
 * A project appears only through what actually answered — its list, or the
 * worktree projections of its branches — so a provider outage removes that
 * project rather than flattening it to "no pull requests".
 */
function groupCandidates(
  rows: WorktreeRow[],
  lists: ProjectPullRequests[],
  hostingByKey: Map<string, HostingByKey>,
): ProjectCandidates[] {
  const byProject = new Map<string, ProjectCandidates>();
  const bucket = (projectId: string): ProjectCandidates => {
    const existing = byProject.get(projectId);
    if (existing) return existing;
    const mainPath = rows.find(
      (row) => row.projectId === projectId && isMainWorktreeId(row.id),
    )?.path;
    const created: ProjectCandidates = {
      projectId,
      ...(mainPath ? { mainPath } : {}),
      open: [],
      terminal: [],
    };
    byProject.set(projectId, created);
    return created;
  };

  for (const list of lists) {
    // Selection: a pull request is listed when it is YOURS or when your review
    // was asked for. Everything else open on the repository is the Project
    // page's business, not this view's.
    for (const pull of list.pullRequests) {
      if (!pull.mine && !pull.reviewRequested) continue;
      const identity = pullRequestIdentity(
        list.provider,
        list.repoWebUrl,
        pull.number,
      );
      if (!identity) continue;
      bucket(list.projectId).open.push({
        key: identity.key,
        repositoryKey: identity.repositoryKey,
        provider: list.provider,
        repoWebUrl: list.repoWebUrl,
        pull,
      });
    }
  }

  for (const [
    key,
    { row, repositoryKey, provider, repoWebUrl, status },
  ] of hostingByKey) {
    if (!status.pr || status.pr.state === "open") continue;
    bucket(row.projectId).terminal.push({
      key,
      repositoryKey,
      row,
      provider,
      repoWebUrl,
      number: status.pr.number,
      url: status.pr.url,
      title: status.pr.title,
      state: status.pr.state,
    });
  }

  return [...byProject.values()];
}

/**
 * One work unit per pull request to project, with its project's provider object
 * resolved once (a local `git remote get-url`, so it is read ahead of the
 * fan-out rather than inside every unit).
 *
 * A pull request the 60 s list still calls open, while the 15 s projection of
 * the SAME repository's branch already reports it merged or closed, is
 * TERMINAL: the fresher read wins, and the cleanup queue is where it belongs.
 * That de-duplication is by identity, so another repository's #N — a fork the
 * project also publishes to — cannot suppress this one.
 */
async function inventoryUnits(
  projects: ProjectCandidates[],
): Promise<InventoryUnit[]> {
  const units: InventoryUnit[] = [];
  for (const project of projects) {
    const terminalKeys = new Set(project.terminal.map((pr) => pr.key));
    const open = project.open.filter(
      (candidate) => !terminalKeys.has(candidate.key),
    );
    const provider = open.length ? await resolveProvider(project) : null;
    for (const candidate of open)
      units.push({
        kind: "open",
        projectId: project.projectId,
        provider,
        candidate,
      });
    const listedByKey = new Map(
      project.open.map((candidate) => [candidate.key, candidate.pull]),
    );
    for (const terminal of project.terminal) {
      const listed = listedByKey.get(terminal.key);
      units.push({
        kind: "terminal",
        projectId: project.projectId,
        terminal,
        ...(listed ? { listed } : {}),
      });
    }
  }
  return units;
}

/**
 * The provider object for one project, resolved from its MAIN checkout — the
 * repository whose list produced these open pull requests. `null` when the
 * project has no main checkout or its remote resolves to no configured
 * provider; its pull requests then travel with the list facts alone.
 */
async function resolveProvider(
  project: ProjectCandidates,
): Promise<GitHostingProvider | null> {
  if (!project.mainPath) return null;
  return hostingProviderForRepo(project.mainPath).catch(() => null);
}

async function inventoryItem(
  unit: InventoryUnit,
  hostingByKey: Map<string, HostingByKey>,
  worktreeByBranch: Map<string, WorktreeRow>,
  cardLinks: Map<string, PullRequestCardLinks>,
): Promise<PullRequestInventoryItem> {
  if (unit.kind === "terminal") {
    // A terminal pull request is inventoried for its LOCAL consequence, so it
    // carries no CI, review, mergeability or capabilities: there is nothing
    // left to merge or review, and the branch's local head CI is not this pull
    // request's. Its head/base branches come from the worktree that found it.
    const { terminal, listed } = unit;
    return {
      projectId: unit.projectId,
      provider: terminal.provider,
      repositoryKey: terminal.repositoryKey,
      repoWebUrl: terminal.repoWebUrl,
      number: terminal.number,
      url: terminal.url,
      title: terminal.title,
      headBranch: terminal.row.branch,
      baseBranch: terminal.row.baseBranch,
      ...(listed?.author ? { author: listed.author } : {}),
      // Only the open-PR list can state authorship, and the entry above is this
      // pull request's own — matched by repository-scoped identity, so another
      // repository's #N can never lend it. A pull request that has already left
      // the list reports unknown rather than a guess from the fact that a local
      // branch survives.
      mine: listed?.mine ?? false,
      reviewRequested: listed?.reviewRequested ?? false,
      ...(listed?.draft ? { draft: true } : {}),
      ...(listed?.updatedAt !== undefined
        ? { updatedAt: listed.updatedAt }
        : {}),
      state: terminal.state,
      ...localJoins(terminal.key, terminal.row, cardLinks),
    };
  }

  const { candidate, provider } = unit;
  const hosting = hostingByKey.get(candidate.key);
  const { pull } = candidate;
  const annotation: PullRequestAnnotation = provider
    ? await annotate(
        candidate.key,
        provider,
        pull.number,
        hosting?.status.review,
      )
    : {};
  // Capabilities decide which merge methods the view may OFFER, so they are
  // read for every open pull request. Their own per-repository cache coalesces
  // that across the project's pull requests, and an unknown answer travels as
  // unknown: the picker then offers nothing.
  const capabilities = provider
    ? await repositoryCapabilitiesFor(provider)
    : undefined;
  const review = hosting?.status.review ?? annotation.review;
  // The worktree for this pull request is the one that PUBLISHED it when the
  // hosting projection found it there; otherwise the project's active worktree
  // standing on the head branch, which is the case where no projection has an
  // answer yet.
  const worktree =
    hosting?.row ??
    worktreeByBranch.get(`${unit.projectId}#${pull.headBranch}`);
  return {
    projectId: unit.projectId,
    provider: candidate.provider,
    repositoryKey: candidate.repositoryKey,
    repoWebUrl: candidate.repoWebUrl,
    number: pull.number,
    url: pull.url,
    title: pull.title,
    headBranch: pull.headBranch,
    baseBranch: pull.baseBranch,
    ...(pull.author ? { author: pull.author } : {}),
    mine: pull.mine,
    reviewRequested: pull.reviewRequested,
    ...(pull.draft ? { draft: true } : {}),
    ...(pull.updatedAt !== undefined ? { updatedAt: pull.updatedAt } : {}),
    state: "open",
    ...(annotation.ci ? { ci: annotation.ci } : {}),
    ...(review ? { review } : {}),
    ...("mergeable" in annotation ? { mergeable: annotation.mergeable } : {}),
    ...(annotation.headSha ? { headSha: annotation.headSha } : {}),
    ...(capabilities ? { capabilities } : {}),
    ...localJoins(candidate.key, worktree, cardLinks),
  };
}

/**
 * The joins the client cannot make: the local worktree for this pull request,
 * the sessions reachable through it and through the pull request's `/pr` cards,
 * and the Tasks those two carry. IDs only, de-duplicated, worktree edges first.
 */
function localJoins(
  key: string,
  worktree: WorktreeRow | undefined,
  cardLinks: Map<string, PullRequestCardLinks>,
): Pick<PullRequestInventoryItem, "worktreeId" | "sessionIds" | "taskIds"> {
  const links = cardLinks.get(key);
  const sessionIds = unique([
    ...(worktree ? sessionIdsForWorktree(worktree.id) : []),
    ...(links?.sessionIds ?? []),
  ]);
  const taskIds = unique([
    ...(worktree ? taskIdsForWorktree(worktree.id) : []),
    ...(links?.taskIds ?? []),
  ]);
  return {
    ...(worktree ? { worktreeId: worktree.id } : {}),
    sessionIds,
    taskIds,
  };
}

function unique(ids: string[]): string[] {
  return [...new Set(ids)];
}
