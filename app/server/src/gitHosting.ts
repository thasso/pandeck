/**
 * Provider-abstract git hosting seam: pull requests and CI status for the
 * repository behind a checkout's selected push remote (`origin` by default).
 *
 * The provider is DETECTED from the remote push URL host — Forgejo when it matches
 * the Forgejo integration's configured instance base URL (Settings → Forgejo),
 * GitHub when it is github.com and the GitHub PAT integration is available. No
 * provider match = the feature is simply absent for that repo; callers degrade
 * to nothing.
 *
 * Forgejo speaks the Gitea-compatible API v1 with an optional access token
 * (`Authorization: token …`); without a token, public read endpoints may still
 * work but PR creation fails with a clear message.
 */
import {
  PULL_REQUEST_MERGE_METHODS,
  type GitHostingProviderKind,
  type HostedPullRequest,
  type PullRequestCloseResult,
  type PullRequestDetail,
  type PullRequestMergeMethod,
  type PullRequestMergeResult,
  type PullRequestRepositoryCapabilities,
  type WorktreeCiStatus,
  type WorktreePullRequestInfo,
  type WorktreePullRequestReview,
} from "@assistant/shared";
import { gitOptional } from "./gitExec.ts";
import { getGithubConfigIfAvailable } from "./githubSettings.ts";
import {
  GITHUB_WEB_BASE,
  githubGraphql,
  githubRateLimit,
  githubRefChecks,
  githubRequest,
  type GithubApiConfig,
} from "./githubClient.ts";
import {
  isFailedGitCheckStatus,
  isTerminalGitCheckStatus,
} from "./gitCheckStatus.ts";
import { getForgejoConfigIfAvailable } from "./forgejoSettings.ts";
import {
  type ForgejoApiConfig,
  ForgejoHttpError,
  forgejoRefChecks,
  forgejoRequest,
  normalizeForgejoBaseUrl,
  resolveForgejoLogin,
} from "./forgejoClient.ts";
import { errorText } from "./errors.ts";

const REQUEST_TIMEOUT_MS = 8_000;

/** Bound each provider request while still honoring a long-running tool's cancellation. */
function requestSignal(parentSignal?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  return parentSignal ? AbortSignal.any([parentSignal, timeout]) : timeout;
}

/**
 * A parsed `updated_at`, or nothing at all when the provider omitted it or it
 * did not parse. Returned as a fragment so the key is absent rather than
 * present-and-undefined.
 */
function updatedAtFragment(raw: string | undefined): { updatedAt?: number } {
  const parsed = raw ? Date.parse(raw) || undefined : undefined;
  return parsed !== undefined ? { updatedAt: parsed } : {};
}

export interface RemoteRepoRef {
  host: string;
  owner: string;
  repo: string;
}

/** Parse ssh://user@host:port/owner/repo(.git), user@host:owner/repo, http(s)://host/owner/repo. */
export function parseRemoteUrl(remote: string): RemoteRepoRef | null {
  const trimmed = remote.trim();
  if (!trimmed) return null;
  const scpLike = trimmed.match(
    /^(?:[\w.-]+@)?([\w.-]+):([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/,
  );
  if (scpLike && !trimmed.includes("://")) {
    return { host: scpLike[1]!, owner: scpLike[2]!, repo: scpLike[3]! };
  }
  try {
    const url = new URL(trimmed);
    const segments = url.pathname
      .replace(/^\/+/, "")
      .replace(/\.git\/?$/, "")
      .split("/");
    if (segments.length < 2 || !segments[0] || !segments[1]) return null;
    return { host: url.hostname, owner: segments[0], repo: segments[1] };
  } catch {
    return null;
  }
}

export interface GitHostingCheck {
  name: string;
  status: string;
  url?: string;
  /** Authenticated API endpoint for logs when the provider exposes one. */
  logUrl?: string;
  /** Job id accepted by the provider's agent-facing log reader tool. */
  logJobId?: number;
  /** Provider-supplied failure output or description; callers bound it. */
  excerpt?: string;
}

export interface GitHostingRefChecks {
  state: "success" | "failure" | "pending" | "none";
  checks: GitHostingCheck[];
  /** Provider-reported total when it can exceed the bounded rows returned. */
  total?: number;
  /** The verdict covers less than the provider-reported total. */
  truncated?: boolean;
}

export interface GitHostingProvider {
  kind: GitHostingProviderKind;
  /** Parsed repository identity used to bind managed push and PR targets. */
  repository?: RemoteRepoRef;
  /** Web URL of the repository for user-facing links. */
  repoWebUrl: string;
  /**
   * The pull request for this branch, whatever state it is in. `null` means
   * there is none; a THROW means the provider could not be asked, and callers
   * must keep those two apart — see the note on failures below.
   *
   * It deliberately does not filter to open PRs: a MERGED pull request is the
   * one signal that a branch's life is over, and querying only `state=open`
   * made that state unreachable.
   */
  findPullRequestForBranch(
    headBranch: string,
  ): Promise<WorktreePullRequestInfo | null>;
  /**
   * The COMPLETE set of OPEN pull requests for this head branch, plus the newest
   * terminal one as bounded context. Managed delivery uses this explicit
   * multiplicity read to require one canonical open PR; ordinary
   * status/adoption paths intentionally keep using the tolerant single-result
   * read above.
   *
   * "Complete" is the whole point, so `open` is paged until the provider is
   * exhausted and a read that cannot be exhausted within its page cap THROWS:
   * a truncated answer would let a second open pull request sit past the page
   * boundary and be merged as if it were the only one.
   */
  findPullRequestsForBranch(headBranch: string): Promise<BranchPullRequests>;
  /**
   * Point-in-time detail for `pullRequestWatcher.ts`'s poll: state, merged,
   * mergeable, draft, headSha, base. A THROW means the provider could not be
   * asked (network error, deleted PR, ...); the watcher retries later rather
   * than treating that as any particular state.
   *
   * `mergeable` is THREE-valued for both providers: `null` means "ask again",
   * never "conflicting". Each provider maps its own unknowns onto it — GitHub's
   * literal `null` while it recomputes, Forgejo's `false` on a draft/WIP pull
   * request, which it reports whether or not the base actually conflicts.
   */
  pullRequestDetail(prNumber: number): Promise<PullRequestDetail | null>;
  createPullRequest(input: {
    title: string;
    body?: string;
    head: string;
    base: string;
    draft?: boolean;
  }): Promise<WorktreePullRequestInfo>;
  /** Move an existing draft/WIP pull request into ordinary reviewable state. */
  markPullRequestReady(prNumber: number): Promise<{ title?: string }>;
  /**
   * Merge one pull request and, when asked, delete its remote head branch — as
   * ONE call. Deleting the branch is part of merging, not a second step a
   * caller orchestrates: every surface that merges wants the branch gone, and
   * two calls means two ways to leave a merged PR with a stale branch behind.
   *
   * A refusal (branch protection, required checks, a PR that is not mergeable
   * after all) THROWS with the provider's own message: the provider is the
   * authority on whether a merge is allowed, so nothing here pre-judges it.
   * Deleting the branch is the one part allowed to fail softly — the merge has
   * already landed by then, and a protected branch is not a failed merge.
   */
  mergePullRequest(
    prNumber: number,
    options: {
      method: PullRequestMergeMethod;
      deleteBranch?: boolean;
      /** Refuse atomically if the provider's current PR head differs. */
      expectedHeadSha?: string;
      /**
       * The head branch to delete, already PROVEN by the caller against this
       * same pull request. Supplying it removes the provider's own pre-merge
       * read: that read is a round trip between the caller's identity check and
       * the merge, and a retarget landing inside it would keep the expected
       * head — satisfying the only precondition the merge APIs offer — while
       * moving the merge onto another base. A caller that could not prove the
       * branch omits it and accepts the read below instead.
       */
      headBranch?: string;
      /**
       * The base the caller decided to merge into. Checked only when a
       * pre-merge read happens anyway, so that read cannot pass a pull request
       * it just saw pointing somewhere else.
       */
      expectedBaseBranch?: string;
    },
  ): Promise<PullRequestMergeResult>;
  /**
   * Close ONE open pull request without merging it.
   *
   * Neither backend offers an atomic head precondition for the state
   * transition, so the exact head is proven by a read immediately BEFORE the
   * write and the closed state by a read after it. A refusal (no permission,
   * already closed, a head that moved) THROWS with the provider's own message;
   * a write that landed but could not be confirmed comes back as a result with
   * `closed: false` and `unconfirmedReason`, never as an invented success.
   */
  closePullRequest(
    prNumber: number,
    options: { expectedHeadSha: string },
  ): Promise<PullRequestCloseResult>;
  /**
   * What this repository allows for pull requests: its exact default branch,
   * the merge methods its own settings permit, and whether closing/branch
   * deletion are available. Read from repository METADATA — never assumed —
   * and a failure THROWS rather than answering "everything is allowed".
   *
   * Callers reach it through {@link repositoryCapabilitiesFor}, which caches
   * and coalesces per repository; a provider implements only the raw read.
   */
  repositoryCapabilities(): Promise<PullRequestRepositoryCapabilities>;
  ciStatus(ref: string): Promise<WorktreeCiStatus | null>;
  /** Per-check machine evidence for an exact ref, used by Workflow Runs. */
  refChecks(ref: string): Promise<GitHostingRefChecks>;
  /** Review state of one open PR. `null` = could not be determined. */
  pullRequestReview(
    prNumber: number,
  ): Promise<WorktreePullRequestReview | null>;
  /**
   * Open pull requests on the repo, each tagged with whether it is yours and
   * whether your review was requested. `null` = the repo could not be listed,
   * which is deliberately different from an empty list.
   *
   * Everything open is returned rather than only your own: it is ONE request
   * either way (the ownership facts ride along in the same response), and the
   * two consumers want different slices — the inbox takes what needs you, the
   * Project page shows the repo.
   */
  listOpenPullRequests(): Promise<HostedPullRequest[] | null>;
  /**
   * OPTIONAL batched `findPullRequestForBranch` + `ciStatus` + (for an open
   * pull request) `pullRequestReview` for many branches of this repository in
   * ONE provider request, answered in request order. A provider without a
   * cheap batch leaves it out and callers issue the per-row reads. It is all
   * or nothing: a THROW means none of the rows was answered.
   */
  branchStatuses?(requests: BranchStatusRequest[]): Promise<BranchStatus[]>;
  /**
   * OPTIONAL: what the most recent `listOpenPullRequests` of this repository
   * already read about one of its open pull requests in the same request.
   * `undefined` = not known (never listed, too old, or invalidated by a
   * mutation since); the caller reads it per pull request instead.
   */
  openPullRequestAnnotation?(
    prNumber: number,
  ): OpenPullRequestAnnotation | undefined;
  /**
   * OPTIONAL: requests left in the provider's rate-limit window as of its
   * latest response, for a caller that paces repeated reads. `null` = unknown
   * or already reset; a provider without a metered budget leaves it out.
   */
  rateLimit?(): { remaining: number; resetAt: number } | null;
}

/** One worktree's question to {@link GitHostingProvider.branchStatuses}. */
interface BranchStatusRequest {
  /** `null` asks for no pull request (the main checkout IS the base). */
  branch: string | null;
  /** The local HEAD whose CI is wanted; `null` asks for none. */
  headSha: string | null;
}

export interface BranchStatus {
  pr: WorktreePullRequestInfo | null;
  ci: WorktreeCiStatus | null;
  /** Only for an OPEN pull request; `null` otherwise. */
  review: WorktreePullRequestReview | null;
}

/** An open pull request's detail, head CI and review, read with its list. */
interface OpenPullRequestAnnotation {
  detail: PullRequestDetail;
  ci: WorktreeCiStatus | null;
  review: WorktreePullRequestReview;
}

/** Cap per repo: a browse list, not an archive. */
const MAX_PULL_REQUESTS = 50;

/**
 * What one branch's pull requests are, for a caller that must be able to say
 * "exactly one".
 */
interface BranchPullRequests {
  /** EVERY open pull request for the branch — proven complete, or a throw. */
  open: WorktreePullRequestInfo[];
  /** The newest merged/closed one, read only when nothing is open. */
  latestTerminal?: WorktreePullRequestInfo;
}

/**
 * Paging bounds for the complete open-pull-request read. Reaching the cap is
 * treated as "could not prove", never as "that was all of them"; a branch with
 * hundreds of open pull requests is not a delivery target anyway.
 */
const OPEN_PULL_REQUEST_PAGE_CAP = 20;

/**
 * Is this pull request's head branch really OURS? Both providers list pull
 * requests opened from FORKS beside their own, and a fork may carry a branch of
 * exactly the same name, so the head repository — not just the ref — decides.
 * A head repository that cannot be read (a deleted fork) proves nothing and is
 * therefore excluded rather than assumed to be this repository.
 */
function headIsOwnBranch(
  pull: { head?: { ref?: string; repo?: { full_name?: string } | null } },
  headBranch: string,
  ref: RemoteRepoRef,
): boolean {
  if (pull.head?.ref !== headBranch) return false;
  const headRepo = pull.head?.repo?.full_name;
  return (
    typeof headRepo === "string" &&
    headRepo.toLowerCase() === `${ref.owner}/${ref.repo}`.toLowerCase()
  );
}

/**
 * Provider calls THROW when the API could not be reached or refused, and return
 * `null`/empty only when the answer is genuinely "there is nothing".
 *
 * Swallowing a failure into `null` produced a payload that said "no PR, no CI"
 * — indistinguishable from a clean branch — so an outage rendered as a list of
 * healthy-looking worktrees. The bulk projection turns a throw into an OMITTED
 * row, which the inbox reads as unknown.
 */
function requireData<T>(res: { data: T } | null, what: string): T {
  if (!res)
    throw new Error(`Could not read ${what} from the hosting provider.`);
  return res.data;
}

/**
 * A provider list, or a THROW. A body that is not an array was not understood,
 * and "not understood" is not "there are none": treating one as the other let a
 * malformed page end a paged read as if the set were complete, so a first-page
 * match could look like the proven only open pull request while the rest went
 * unread.
 */
function requirePullRequestList<T>(value: unknown, what: string): T[] {
  if (!Array.isArray(value))
    throw new Error(
      `The hosting provider answered ${what} in a shape this app does not understand.`,
    );
  return value as T[];
}

/* --------------------------- repository capabilities ----------------------- */

/**
 * Long enough to coalesce across the background loops' five-minute cadence.
 * Only the merge-method picker reads a cached answer; the merge itself asks for
 * a `fresh` one, so a settings change is never acted on from here.
 */
const CAPABILITIES_CACHE_MS = 5 * 60_000;

/**
 * Cache and in-flight entries carry the GENERATION they belong to.
 *
 * Deleting the settled cache is not enough to obsolete a read: a request that
 * started before an invalidation (or before a merge took the mutation lock)
 * describes the world from before it, and both joining that promise and letting
 * it repopulate the cache afterwards would hand a "forced" caller a stale
 * answer. Invalidating therefore BUMPS the generation, and every entry from an
 * older one is ignored on read and dropped on settle.
 */
interface CapabilitiesEntry {
  at: number;
  generation: number;
  value: PullRequestRepositoryCapabilities;
}

const capabilitiesCache = new Map<string, CapabilitiesEntry>();
const capabilitiesInFlight = new Map<
  string,
  { generation: number; promise: Promise<PullRequestRepositoryCapabilities> }
>();
const capabilitiesGenerations = new Map<string, number>();

function capabilitiesKey(provider: GitHostingProvider): string {
  const ref = provider.repository;
  return `${provider.kind}#${ref ? `${ref.host}/${ref.owner}/${ref.repo}` : provider.repoWebUrl}`.toLowerCase();
}

function bumpCapabilitiesGeneration(key: string): number {
  const next = (capabilitiesGenerations.get(key) ?? 0) + 1;
  capabilitiesGenerations.set(key, next);
  capabilitiesCache.delete(key);
  return next;
}

/**
 * Repository capabilities for one provider, cached and coalesced per
 * repository. A FAILED read is unknown-with-a-reason rather than a throw: every
 * consumer of an unknown capability already fails closed, and a capability
 * outage must not turn a legible refusal into an unexplained tool error.
 *
 * `fresh` is for a caller about to act irreversibly on the answer: it starts a
 * NEW generation, so it can neither be served from the cache nor adopt a
 * request that was already in flight, and the answer it gets was asked for
 * after it decided to ask.
 */
export async function repositoryCapabilitiesFor(
  provider: GitHostingProvider,
  options: { fresh?: boolean } = {},
): Promise<PullRequestRepositoryCapabilities> {
  const key = capabilitiesKey(provider);
  const generation = options.fresh
    ? bumpCapabilitiesGeneration(key)
    : (capabilitiesGenerations.get(key) ?? 0);
  const cached = capabilitiesCache.get(key);
  if (
    cached &&
    cached.generation === generation &&
    Date.now() - cached.at < CAPABILITIES_CACHE_MS
  )
    return cached.value;
  const inFlight = capabilitiesInFlight.get(key);
  // Only work from THIS generation may be joined; anything older was asked
  // before the invalidation that produced this generation.
  if (inFlight && inFlight.generation === generation) return inFlight.promise;
  const promise = Promise.resolve()
    .then(() => provider.repositoryCapabilities())
    .then((value) => {
      // A newer generation has since invalidated this answer; hand it to the
      // caller that asked, but never leave it behind as the current one.
      if ((capabilitiesGenerations.get(key) ?? 0) === generation)
        capabilitiesCache.set(key, { at: Date.now(), generation, value });
      return value;
    })
    .catch((err) => {
      // Deliberately NOT cached: an outage must not freeze "unknown" in for a
      // minute, and the next caller may well get a real answer.
      const value: PullRequestRepositoryCapabilities = {
        unknownReason: errorText(err),
      };
      return value;
    })
    .finally(() => {
      // Only retract THIS entry: a newer generation's request may already own
      // the slot.
      if (capabilitiesInFlight.get(key)?.promise === promise)
        capabilitiesInFlight.delete(key);
    });
  capabilitiesInFlight.set(key, { generation, promise });
  return promise;
}

/**
 * Obsolete cached capabilities — one repository's, or every one of them. An
 * in-flight read started before this call can no longer be joined or cached.
 */
export function invalidateRepositoryCapabilities(
  provider?: GitHostingProvider,
): void {
  if (!provider) {
    for (const key of new Set([
      ...capabilitiesCache.keys(),
      ...capabilitiesInFlight.keys(),
      ...capabilitiesGenerations.keys(),
    ]))
      bumpCapabilitiesGeneration(key);
    capabilitiesCache.clear();
    return;
  }
  bumpCapabilitiesGeneration(capabilitiesKey(provider));
}

/**
 * A pre-merge read that happened anyway must not pass a pull request it just
 * saw pointing somewhere else.
 *
 * No merge API offers a base precondition — only the head SHA — so a retarget
 * that keeps the head is invisible to the merge call itself. Whenever a
 * provider does read the pull request before merging, that read is therefore
 * also the last chance to notice one.
 */
function requireUnmovedMergeBase(
  prNumber: number,
  pull: { base?: { ref?: string } } | null,
  expectedBaseBranch: string | undefined,
): void {
  if (!expectedBaseBranch) return;
  // Only the BASE is checked here. The head gets an atomic precondition on the
  // merge call itself (`sha`/`head_commit_id`), which is stronger than
  // anything a read can say about it; the base has none at all, which is
  // exactly why the one read that does happen must speak for it.
  const base = pull?.base?.ref ?? "";
  if (base !== expectedBaseBranch)
    throw new Error(
      `Pull request #${prNumber} now targets ${base || "an unreported branch"}, not the ${expectedBaseBranch} this merge was decided for; nothing was merged.`,
    );
}

/** What a merge call must be able to state about its target. */
interface MergePreconditions {
  /** The ref to delete afterwards; empty when nothing is being deleted. */
  headBranch: string;
  /** The head the merge is conditioned on. Never empty — the merge needs one. */
  expectedHeadSha: string;
}

type MergeOptions = Parameters<GitHostingProvider["mergePullRequest"]>[1];

/**
 * Everything the merge must be able to state, resolved for BOTH providers.
 *
 * The pull request is read here only when the caller could not state it all: an
 * exact head to condition the merge on, and — when the branch is being deleted
 * — its name. A caller that proved both (the merge seam, straight after its own
 * identity check) is answered without any read, so nothing can move the target
 * in between. Everyone else pays for exactly one read, and that read is where
 * the decided base is bound and the head precondition comes from: no merge API
 * has a base precondition, and merging with no head precondition at all would
 * leave the one window every provider CAN close — a push between the last read
 * and the merge — wide open.
 */
async function resolveMergePreconditions(
  prNumber: number,
  options: MergeOptions,
  readPull: () => Promise<{
    head?: { ref?: string; sha?: string };
    base?: { ref?: string };
  } | null>,
): Promise<MergePreconditions> {
  const deletingBranch = options.deleteBranch === true;
  if (options.expectedHeadSha && (!deletingBranch || options.headBranch))
    return {
      headBranch: deletingBranch ? (options.headBranch ?? "") : "",
      expectedHeadSha: options.expectedHeadSha,
    };
  const pull = await readPull();
  requireUnmovedMergeBase(prNumber, pull, options.expectedBaseBranch);
  const expectedHeadSha = options.expectedHeadSha || (pull?.head?.sha ?? "");
  if (!expectedHeadSha)
    throw new Error(
      `Pull request #${prNumber} reports no head commit, so the merge could not be conditioned on one; nothing was merged.`,
    );
  return {
    headBranch: deletingBranch
      ? (options.headBranch ?? pull?.head?.ref ?? "")
      : "",
    expectedHeadSha,
  };
}

/**
 * Refuse a close whose target is not the exact OPEN pull request at the exact
 * head the caller decided about. Both providers write the state transition
 * without a precondition of their own, so this pre-read IS the precondition.
 */
function requireClosablePull(
  prNumber: number,
  pull: { state?: string; merged?: boolean; head?: { sha?: string } } | null,
  expectedHeadSha: string,
): void {
  if (!pull) throw new Error(`Pull request #${prNumber} could not be read.`);
  if (pull.merged === true)
    throw new Error(`Pull request #${prNumber} is already merged.`);
  if (pull.state !== "open")
    throw new Error(
      `Pull request #${prNumber} is ${pull.state || "not open"}; nothing was closed.`,
    );
  const headSha = pull.head?.sha ?? "";
  if (headSha.toLowerCase() !== expectedHeadSha.toLowerCase())
    throw new Error(
      `Pull request #${prNumber} head moved from ${expectedHeadSha} to ${headSha || "an unreported commit"}; nothing was closed.`,
    );
}

/** Read the post-write state into an honest result, partials included. */
function closeResultFrom(
  prNumber: number,
  headSha: string,
  after: { state: string; merged: boolean; headSha: string },
): PullRequestCloseResult {
  if (after.merged)
    throw new Error(
      `Pull request #${prNumber} merged while it was being closed; it was not closed.`,
    );
  if (after.headSha.toLowerCase() !== headSha.toLowerCase())
    return {
      number: prNumber,
      closed: false,
      headSha,
      unconfirmedReason: `the close was sent, but the pull request head moved from ${headSha} to ${after.headSha || "an unreported commit"} before closure could be confirmed.`,
    };
  if (after.state === "closed")
    return { number: prNumber, closed: true, headSha };
  return {
    number: prNumber,
    closed: false,
    headSha,
    unconfirmedReason: `the close was sent but the pull request still reports state ${after.state || "unknown"}.`,
  };
}

/**
 * Turn a provider's allow-flags into the supported set, in the shared
 * vocabulary's own order — or into UNKNOWN.
 *
 * A flag the repository payload did not carry is NOT a permission and NOT a
 * denial: it is metadata we could not read. Reading an absent flag as "allowed"
 * once let a response carrying only `default_branch` advertise all three
 * methods, which is exactly the guess this capability read exists to prevent,
 * so ONE missing flag makes the whole set unknown and every merge consumer
 * fails closed on it. Closing and the default branch are unaffected: they are
 * read from their own fields.
 */
function mergeMethodsFrom(
  allowed: Record<PullRequestMergeMethod, boolean | undefined>,
  fieldNames: Record<PullRequestMergeMethod, string>,
): { mergeMethods: PullRequestMergeMethod[] } | { unknownReason: string } {
  const missing = PULL_REQUEST_MERGE_METHODS.filter(
    (method) => typeof allowed[method] !== "boolean",
  );
  if (missing.length > 0)
    return {
      unknownReason: `the repository did not report ${missing
        .map((method) => fieldNames[method])
        .join(", ")}, so its supported merge methods are unknown`,
    };
  return {
    mergeMethods: PULL_REQUEST_MERGE_METHODS.filter(
      (method) => allowed[method] === true,
    ),
  };
}

/** Prefer an open PR; otherwise use the most recent terminal PR. */
export function pickBranchPull<T extends { state: string; merged?: boolean }>(
  pulls: T[],
): T | undefined {
  return pulls.find((pull) => pull.state === "open") ?? pulls[0];
}

/** One review as both providers report it, modulo the state spelling. */
interface ProviderReview {
  state: string;
  user?: { login?: string };
  submitted_at?: string;
  stale?: boolean;
  dismissed?: boolean;
}

/**
 * Does a standing review ask for changes? Only the LATEST review per person
 * counts — a reviewer who asked for changes and later approved has not left an
 * objection standing — and stale/dismissed reviews never count.
 *
 * The two providers spell the same state differently (`REQUEST_CHANGES` on
 * Forgejo, `CHANGES_REQUESTED` on GitHub), which is the only reason this is not
 * a one-liner in each.
 */
export function changesRequestedFromReviews(
  reviews: ProviderReview[],
): boolean {
  const latestByUser = new Map<string, ProviderReview>();
  for (const review of reviews) {
    const state = (review.state ?? "").toUpperCase();
    if (state === "PENDING" || state === "COMMENTED" || state === "COMMENT")
      continue;
    if (review.stale || review.dismissed || state === "DISMISSED") continue;
    const login = review.user?.login ?? "";
    const previous = latestByUser.get(login);
    if (
      !previous ||
      (review.submitted_at ?? "") >= (previous.submitted_at ?? "")
    )
      latestByUser.set(login, review);
  }
  for (const review of latestByUser.values()) {
    const state = (review.state ?? "").toUpperCase();
    if (state === "REQUEST_CHANGES" || state === "CHANGES_REQUESTED")
      return true;
  }
  return false;
}

/**
 * Resolve the provider for one named remote of the repo containing `repoPath`.
 * The push URL is authoritative: a remote may fetch from one repository while
 * publishing to another, and PR creation must follow the latter.
 */
export async function hostingProviderForRepo(
  repoPath: string,
  remote = "origin",
): Promise<GitHostingProvider | null> {
  const remoteRes = await gitOptional(
    ["remote", "get-url", "--push", remote],
    repoPath,
  );
  if (remoteRes.code !== 0) return null;
  const ref = parseRemoteUrl(remoteRes.stdout.trim());
  if (!ref) return null;

  const forgejoConfig = getForgejoConfigIfAvailable();
  if (forgejoConfig) {
    try {
      if (
        new URL(normalizeForgejoBaseUrl(forgejoConfig.baseUrl)).hostname ===
        ref.host
      ) {
        return forgejoProvider(ref, forgejoConfig);
      }
    } catch {
      // Invalid configured base URL — treat as unconfigured.
    }
  }
  if (ref.host === "github.com") {
    // Uses the existing GitHub PAT integration; absent/disabled = feature off.
    const config = getGithubConfigIfAvailable();
    if (config) return githubProvider(ref, config);
  }
  return null;
}

/* ---------------------------------- github ---------------------------------- */

interface GithubPull {
  number: number;
  title: string;
  html_url: string;
  state: string;
  merged?: boolean;
  merged_at?: string | null;
  /** `null` while GitHub is still computing it. */
  mergeable?: boolean | null;
  /** `repo` is null when the head fork was deleted; it never proves ownership. */
  head?: { ref?: string; sha?: string; repo?: { full_name?: string } | null };
  base?: { ref?: string };
  user?: { login?: string };
  requested_reviewers?: Array<{ login?: string }>;
  draft?: boolean;
  node_id?: string;
  updated_at?: string;
}

/**
 * The repository settings GitHub reports. An absent merge flag is UNKNOWN, not
 * a default: see {@link mergeMethodsFrom}.
 */
interface GithubRepository {
  default_branch?: string;
  allow_merge_commit?: boolean;
  allow_squash_merge?: boolean;
  allow_rebase_merge?: boolean;
  delete_branch_on_merge?: boolean;
}

function toGithubPullRequestInfo(pull: GithubPull): WorktreePullRequestInfo {
  const merged = pull.merged === true || Boolean(pull.merged_at);
  return {
    number: pull.number,
    url: pull.html_url,
    title: pull.title,
    state: merged ? "merged" : pull.state === "open" ? "open" : "closed",
  };
}

/*
 * GraphQL batching. The background loops (Pull Requests inventory, worktree
 * hosting) used to ask REST per row: a branch lookup, two CI reads and a review
 * per worktree, and a detail, two CI reads and a review per open pull request —
 * about 70 REST requests a minute for a normal set of worktrees, most of the
 * 5,000/hour budget every agent tool shares. One GraphQL query per repository
 * answers the same questions from the separate GraphQL budget.
 */

/** Check runs AND legacy commit statuses, as the REST `githubRefChecks` pair reads them. */
const GITHUB_ROLLUP_FIELDS = `statusCheckRollup {
  contexts(first: 100) {
    totalCount
    nodes {
      __typename
      ... on CheckRun { status conclusion url detailsUrl }
      ... on StatusContext { state targetUrl }
    }
  }
}`;

interface GithubRollup {
  contexts?: {
    totalCount?: number;
    nodes?: Array<{
      __typename?: string;
      status?: string | null;
      conclusion?: string | null;
      url?: string | null;
      detailsUrl?: string | null;
      state?: string | null;
      targetUrl?: string | null;
    } | null>;
  };
}

/**
 * The REST `ciStatus` rule over a rollup: any failed row fails, a row still
 * running — or rows beyond the first page — keep it pending, and no checks at
 * all is `null`.
 */
function ciFromGithubRollup(
  rollup: GithubRollup | null | undefined,
  commitUrl: string,
): WorktreeCiStatus | null {
  const rows = (rollup?.contexts?.nodes ?? []).flatMap((node) => {
    if (!node) return [];
    const check = node.__typename === "CheckRun";
    return [
      {
        failed: isFailedGitCheckStatus(check ? node.conclusion : node.state),
        terminal: isTerminalGitCheckStatus(check ? node.status : node.state),
        url: (check ? node.url || node.detailsUrl : node.targetUrl) || null,
      },
    ];
  });
  const total = rollup?.contexts?.totalCount ?? rows.length;
  if (total === 0) return null;
  const state: WorktreeCiStatus["state"] = rows.some((row) => row.failed)
    ? "failure"
    : total > rows.length || rows.some((row) => !row.terminal)
      ? "pending"
      : "success";
  return {
    state,
    url: rows.find((row) => row.failed)?.url || rows[0]?.url || commitUrl,
    total,
  };
}

const GITHUB_REVIEW_FIELDS = `latestOpinionatedReviews(first: 100) {
  nodes { state submittedAt author { login } }
}`;

interface GithubGraphqlReviews {
  latestOpinionatedReviews?: {
    nodes?: Array<{
      state?: string;
      submittedAt?: string | null;
      author?: { login?: string } | null;
    } | null>;
  };
}

function reviewFromGithubGraphql(
  pull: GithubGraphqlReviews,
): WorktreePullRequestReview {
  const reviews = (pull.latestOpinionatedReviews?.nodes ?? []).flatMap(
    (review) =>
      review
        ? [
            {
              state: review.state ?? "",
              ...(review.author?.login
                ? { user: { login: review.author.login } }
                : {}),
              ...(review.submittedAt
                ? { submitted_at: review.submittedAt }
                : {}),
            },
          ]
        : [],
  );
  return { changesRequested: changesRequestedFromReviews(reviews) };
}

function githubGraphqlState(
  state: string | undefined,
): "open" | "merged" | "closed" {
  return state === "MERGED" ? "merged" : state === "OPEN" ? "open" : "closed";
}

/** Branch lookups per query; each costs a connection per candidate pull request. */
const BRANCH_STATUS_BATCH = 10;

const GIT_OID = /^[0-9a-f]{40}$/i;

interface GithubBranchPull extends GithubGraphqlReviews {
  number: number;
  title: string;
  url: string;
  state: string;
  headRepository?: { nameWithOwner?: string } | null;
}

interface GithubBranchPulls {
  nodes?: Array<GithubBranchPull | null>;
  pageInfo?: { hasNextPage?: boolean };
}

/**
 * A GraphQL connection's nodes, or a THROW. A missing array is a response this
 * app did not understand, and reading it as "none" would turn unknown into "no
 * pull request" — the answer that retires a row from the inventory.
 */
function requireGraphqlNodes<T>(
  connection: { nodes?: Array<T | null> } | null | undefined,
  what: string,
): T[] {
  if (!Array.isArray(connection?.nodes))
    throw new Error(`GitHub answered ${what} without a node list.`);
  return connection.nodes.filter((node): node is T => node !== null);
}

async function githubBranchStatuses(
  config: GithubApiConfig,
  ref: RemoteRepoRef,
  repoWebUrl: string,
  requests: BranchStatusRequest[],
  signal: () => AbortSignal,
  /**
   * The owner-filtered REST lookup, for a branch whose GraphQL page cannot
   * prove it: `headRefName` matches same-named branches on EVERY fork, so a
   * full page with fork pull requests on it may have crowded ours off.
   */
  restLookup: (branch: string) => Promise<Pick<BranchStatus, "pr" | "review">>,
): Promise<BranchStatus[]> {
  const out: BranchStatus[] = [];
  for (let start = 0; start < requests.length; start += BRANCH_STATUS_BATCH) {
    const chunk = requests.slice(start, start + BRANCH_STATUS_BATCH);
    const declarations = ["$owner: String!", "$name: String!"];
    const variables: Record<string, unknown> = {
      owner: ref.owner,
      name: ref.repo,
    };
    const fields: string[] = [];
    chunk.forEach((request, index) => {
      if (request.branch !== null) {
        declarations.push(`$b${index}: String!`);
        variables[`b${index}`] = request.branch;
        // Newest first and every state, as the REST lookup: a MERGED pull
        // request is what ends a branch.
        fields.push(`b${index}: pullRequests(headRefName: $b${index}, first: 20, orderBy: {field: UPDATED_AT, direction: DESC}) {
          nodes { number title url state headRepository { nameWithOwner } ${GITHUB_REVIEW_FIELDS} }
          pageInfo { hasNextPage }
        }`);
      }
      if (request.headSha !== null && GIT_OID.test(request.headSha)) {
        declarations.push(`$c${index}: GitObjectID!`);
        variables[`c${index}`] = request.headSha;
        // A commit GitHub does not have (not pushed yet) is a null object:
        // it genuinely has no CI.
        fields.push(
          `c${index}: object(oid: $c${index}) { ... on Commit { ${GITHUB_ROLLUP_FIELDS} } }`,
        );
      }
    });
    if (fields.length === 0) {
      out.push(...chunk.map(() => ({ pr: null, ci: null, review: null })));
      continue;
    }
    const data = await githubGraphql<{
      repository?: Record<
        string,
        GithubBranchPulls | GithubRollupHolder | null
      > | null;
    }>(
      config,
      `query(${declarations.join(", ")}) { repository(owner: $owner, name: $name) { ${fields.join("\n")} } }`,
      variables,
      signal(),
    );
    if (!data.repository)
      throw new Error(
        `GitHub repository ${ref.owner}/${ref.repo} was not found.`,
      );
    const repository = data.repository;
    const own = `${ref.owner}/${ref.repo}`.toLowerCase();
    const answers = await Promise.all(
      chunk.map(async (request, index): Promise<BranchStatus> => {
        const commit = repository[`c${index}`] as GithubRollupHolder | null;
        const ci =
          request.headSha !== null
            ? ciFromGithubRollup(
                commit?.statusCheckRollup,
                `${repoWebUrl}/commit/${request.headSha}`,
              )
            : null;
        if (request.branch === null) return { pr: null, ci, review: null };
        const page = repository[`b${index}`] as GithubBranchPulls | null;
        const listed = requireGraphqlNodes(
          page,
          `the pull requests for ${request.branch}`,
        );
        // A same-named branch on a FORK is not ours; see `headIsOwnBranch`.
        const pulls = listed.filter(
          (pull) => pull.headRepository?.nameWithOwner?.toLowerCase() === own,
        );
        // Without a page flag the page proves nothing: it may be the full one
        // a fork crowded ours off.
        const hasNextPage = page?.pageInfo?.hasNextPage;
        if (typeof hasNextPage !== "boolean")
          throw new Error(
            `GitHub answered the pull requests for ${request.branch} without page information.`,
          );
        if (hasNextPage && pulls.length < listed.length)
          return { ...(await restLookup(request.branch)), ci };
        const picked = pickBranchPull(
          pulls.map((pull) => ({
            pull,
            state: githubGraphqlState(pull.state),
          })),
        );
        return {
          pr: picked
            ? {
                number: picked.pull.number,
                url: picked.pull.url,
                title: picked.pull.title,
                state: picked.state,
              }
            : null,
          ci,
          review:
            picked?.state === "open"
              ? reviewFromGithubGraphql(picked.pull)
              : null,
        };
      }),
    );
    out.push(...answers);
  }
  return out;
}

interface GithubRollupHolder {
  statusCheckRollup?: GithubRollup | null;
}

interface GithubOpenPull extends GithubGraphqlReviews {
  number: number;
  title: string;
  url: string;
  isDraft?: boolean;
  updatedAt?: string;
  mergeable?: "MERGEABLE" | "CONFLICTING" | "UNKNOWN";
  headRefName?: string;
  headRefOid?: string;
  baseRefName?: string;
  author?: { login?: string } | null;
  reviewRequests?: {
    totalCount?: number;
    nodes?: Array<{ requestedReviewer?: { login?: string } | null } | null>;
  };
  commits?: {
    nodes?: Array<{
      commit?: { oid?: string } & GithubRollupHolder;
    } | null>;
  };
}

const GITHUB_OPEN_PULLS_QUERY = `query($owner: String!, $name: String!) {
  viewer { login }
  repository(owner: $owner, name: $name) {
    pullRequests(states: OPEN, first: ${MAX_PULL_REQUESTS}, orderBy: {field: UPDATED_AT, direction: DESC}) {
      nodes {
        number title url isDraft updatedAt mergeable headRefName headRefOid baseRefName
        author { login }
        reviewRequests(first: 100) { totalCount nodes { requestedReviewer { ... on User { login } } } }
        ${GITHUB_REVIEW_FIELDS}
        commits(last: 1) { nodes { commit { oid ${GITHUB_ROLLUP_FIELDS} } } }
      }
    }
  }
}`;

/**
 * Per-repository annotations from the latest open-pull-request list, so the
 * inventory does not re-read each listed pull request by REST. Stands for two
 * minutes — the list it came from is itself cached for one — and is dropped
 * (with a generation bump, so a read already in flight cannot write it back)
 * by every mutation this provider performs.
 */
const OPEN_PULL_ANNOTATION_MS = 2 * 60_000;
const openPullAnnotations = new Map<
  string,
  { at: number; byNumber: Map<number, OpenPullRequestAnnotation> }
>();
const openPullAnnotationGenerations = new Map<string, number>();

function githubRepoKey(ref: RemoteRepoRef): string {
  return `${ref.owner}/${ref.repo}`.toLowerCase();
}

/**
 * Drop one repository's annotations. Exported for GitHub writes that bypass
 * the provider seam (the generic PR tools); the provider's own writes call it.
 */
export function forgetOpenPullAnnotations(ref: RemoteRepoRef): void {
  const key = githubRepoKey(ref);
  openPullAnnotations.delete(key);
  openPullAnnotationGenerations.set(
    key,
    (openPullAnnotationGenerations.get(key) ?? 0) + 1,
  );
}

/** Drop every cached annotation; the seam a test resets between cases. */
export function resetGithubOpenPullAnnotationsForTests(): void {
  openPullAnnotations.clear();
  openPullAnnotationGenerations.clear();
}

/** Pages of the REST reviewer list read before giving up as unknown. */
const REVIEW_REQUEST_PAGE_CAP = 10;

/**
 * Is `login` among this pull request's requested reviewers, by the complete
 * REST list? It pages until a short page proves the end, and THROWS when the
 * cap is reached first: an unproven "no" would drop the pull request from the
 * inventory's "needs you".
 */
async function githubUserReviewRequested(
  config: GithubApiConfig,
  ref: RemoteRepoRef,
  prNumber: number,
  login: string,
  signal: AbortSignal,
): Promise<boolean> {
  for (let page = 1; page <= REVIEW_REQUEST_PAGE_CAP; page += 1) {
    const res = await githubRequest<{ users?: Array<{ login?: string }> }>(
      config,
      "GET",
      `/repos/${encodeURIComponent(ref.owner)}/${encodeURIComponent(ref.repo)}/pulls/${prNumber}/requested_reviewers`,
      { query: { per_page: 100, page }, signal },
    );
    const users = requirePullRequestList<{ login?: string }>(
      res.data.users,
      "requested reviewers",
    );
    if (users.some((user) => user.login === login)) return true;
    if (users.length < 100) return false;
  }
  throw new Error(
    `GitHub still listed requested reviewers for #${prNumber} after ${REVIEW_REQUEST_PAGE_CAP} pages.`,
  );
}

async function githubOpenPullRequests(
  config: GithubApiConfig,
  ref: RemoteRepoRef,
  repoWebUrl: string,
  signal: AbortSignal,
): Promise<HostedPullRequest[]> {
  const key = githubRepoKey(ref);
  const generation = openPullAnnotationGenerations.get(key) ?? 0;
  const data = await githubGraphql<{
    viewer?: { login?: string };
    repository?: {
      pullRequests?: { nodes?: Array<GithubOpenPull | null> };
    } | null;
  }>(
    config,
    GITHUB_OPEN_PULLS_QUERY,
    { owner: ref.owner, name: ref.repo },
    signal,
  );
  if (!data.repository)
    throw new Error(
      `GitHub repository ${ref.owner}/${ref.repo} was not found.`,
    );
  const login = data.viewer?.login ?? null;
  const pulls = requireGraphqlNodes(
    data.repository.pullRequests,
    "the open pull requests",
  );
  const byNumber = new Map<number, OpenPullRequestAnnotation>();
  for (const pull of pulls) {
    const head = pull.commits?.nodes?.[0]?.commit;
    // Only a rollup for the EXACT head annotates; anything else is unknown and
    // the inventory reads it per pull request.
    if (!pull.headRefOid || head?.oid !== pull.headRefOid) continue;
    byNumber.set(pull.number, {
      detail: {
        number: pull.number,
        state: "open",
        merged: false,
        // `UNKNOWN` is GitHub still computing it; never read as a conflict.
        mergeable:
          pull.mergeable === "MERGEABLE"
            ? true
            : pull.mergeable === "CONFLICTING"
              ? false
              : null,
        draft: pull.isDraft === true,
        headSha: pull.headRefOid,
        headBranch: pull.headRefName ?? "",
        baseBranch: pull.baseRefName ?? "",
      },
      ci: ciFromGithubRollup(
        head.statusCheckRollup,
        `${repoWebUrl}/commit/${pull.headRefOid}`,
      ),
      review: reviewFromGithubGraphql(pull),
    });
  }
  if ((openPullAnnotationGenerations.get(key) ?? 0) === generation)
    openPullAnnotations.set(key, { at: Date.now(), byNumber });
  const reviewRequested = new Set<number>();
  if (login)
    await Promise.all(
      pulls.map(async (pull) => {
        const requests = pull.reviewRequests?.nodes ?? [];
        if (
          requests.some(
            (request) => request?.requestedReviewer?.login === login,
          )
        ) {
          reviewRequested.add(pull.number);
          return;
        }
        // More requests than the page holds: only the complete REST list can
        // say this one is not yours. Rare, so it is a few reads per such PR.
        if ((pull.reviewRequests?.totalCount ?? 0) <= requests.length) return;
        if (
          await githubUserReviewRequested(
            config,
            ref,
            pull.number,
            login,
            signal,
          )
        )
          reviewRequested.add(pull.number);
      }),
    );
  return pulls.map((pull) => ({
    number: pull.number,
    url: pull.url,
    title: pull.title,
    headBranch: pull.headRefName ?? "",
    baseBranch: pull.baseRefName ?? "",
    ...(pull.author?.login ? { author: pull.author.login } : {}),
    // An unknown identity means NOT mine: claiming ownership we cannot
    // verify would put someone else's PRs in your "needs you" list.
    mine: Boolean(login) && pull.author?.login === login,
    reviewRequested: reviewRequested.has(pull.number),
    ...(pull.isDraft === true ? { draft: true } : {}),
    ...updatedAtFragment(pull.updatedAt),
  }));
}

/** Exported for tests: build the GitHub provider without resolving a remote. */
export function githubProvider(
  ref: RemoteRepoRef,
  config: GithubApiConfig,
  parentSignal?: AbortSignal,
): GitHostingProvider {
  const repoApi = `/repos/${encodeURIComponent(ref.owner)}/${encodeURIComponent(ref.repo)}`;
  const repoWebUrl = `${GITHUB_WEB_BASE}/${ref.owner}/${ref.repo}`;
  const signal = () => requestSignal(parentSignal);
  /**
   * The BOUNDED newest-first read behind the tolerant single-result lookup.
   * `state: all` so a merged pull request — the one thing that ends a branch —
   * is visible at all.
   */
  const recentPullsForBranch = async (
    headBranch: string,
  ): Promise<GithubPull[]> => {
    const res = await githubRequest<GithubPull[]>(
      config,
      "GET",
      `${repoApi}/pulls`,
      {
        query: {
          state: "all",
          head: `${ref.owner}:${headBranch}`,
          per_page: 20,
          sort: "updated",
          direction: "desc",
        },
        signal: signal(),
      },
    );
    const pulls = requirePullRequestList<GithubPull>(
      requireData(res, "pull requests"),
      "pull requests",
    );
    // The `head` query filters by head USER, so a same-owner FORK's identically
    // named branch comes back too; the head repository is what settles it.
    return pulls.filter((pull) => headIsOwnBranch(pull, headBranch, ref));
  };
  const provider: GitHostingProvider = {
    kind: "github",
    repository: ref,
    repoWebUrl,
    async findPullRequestsForBranch(headBranch) {
      const open: WorktreePullRequestInfo[] = [];
      let exhausted = false;
      for (let page = 1; page <= OPEN_PULL_REQUEST_PAGE_CAP; page += 1) {
        const res = await githubRequest<GithubPull[]>(
          config,
          "GET",
          `${repoApi}/pulls`,
          {
            query: {
              state: "open",
              head: `${ref.owner}:${headBranch}`,
              per_page: 100,
              page,
              sort: "created",
              direction: "desc",
            },
            signal: signal(),
          },
        );
        const pulls = requirePullRequestList<GithubPull>(
          requireData(res, "open pull requests"),
          "open pull requests",
        );
        for (const pull of pulls)
          if (headIsOwnBranch(pull, headBranch, ref))
            open.push(toGithubPullRequestInfo(pull));
        // A short page is the provider saying there is no more; only that
        // proves the set below is every open pull request for this branch.
        if (pulls.length < 100) {
          exhausted = true;
          break;
        }
      }
      if (!exhausted)
        throw new Error(
          `GitHub still reported open pull requests for ${headBranch} after ${OPEN_PULL_REQUEST_PAGE_CAP} pages; the exact set could not be established.`,
        );
      if (open.length > 0) return { open };
      // Only worth a second request once nothing is open: it exists to say
      // "already merged/closed" instead of "no pull request".
      const terminal = (await recentPullsForBranch(headBranch)).find(
        (pull) => pull.state !== "open",
      );
      return {
        open,
        ...(terminal
          ? { latestTerminal: toGithubPullRequestInfo(terminal) }
          : {}),
      };
    },
    async findPullRequestForBranch(headBranch) {
      return (
        pickBranchPull(
          (await recentPullsForBranch(headBranch)).map(toGithubPullRequestInfo),
        ) ?? null
      );
    },
    async createPullRequest(input) {
      const res = await githubRequest<GithubPull>(
        config,
        "POST",
        `${repoApi}/pulls`,
        {
          body: {
            title: input.title,
            body: input.body ?? "",
            head: input.head,
            base: input.base,
            ...(input.draft ? { draft: true } : {}),
          },
          signal: signal(),
        },
      );
      return toGithubPullRequestInfo(res.data);
    },
    async markPullRequestReady(prNumber) {
      const pull = (
        await githubRequest<GithubPull>(
          config,
          "GET",
          `${repoApi}/pulls/${prNumber}`,
          { signal: signal() },
        )
      ).data;
      if (!pull?.node_id)
        throw new Error(
          `GitHub pull request #${prNumber} has no GraphQL node id.`,
        );
      if (pull.draft !== true) return { title: pull.title };
      const response = await githubRequest<{
        data?: {
          markPullRequestReadyForReview?: { pullRequest?: { title?: string } };
        };
        errors?: Array<{ message?: string }>;
      }>(config, "POST", "/graphql", {
        body: {
          query:
            "mutation MarkReady($id: ID!) { markPullRequestReadyForReview(input: { pullRequestId: $id }) { pullRequest { title } } }",
          variables: { id: pull.node_id },
        },
        signal: signal(),
      });
      const error = response.data.errors
        ?.map((item) => item.message)
        .filter(Boolean)
        .join("; ");
      if (error)
        throw new Error(
          `GitHub could not mark pull request #${prNumber} ready: ${error}`,
        );
      const readyPull =
        response.data.data?.markPullRequestReadyForReview?.pullRequest;
      if (!readyPull)
        throw new Error(
          `GitHub did not confirm pull request #${prNumber} was marked ready.`,
        );
      return { title: readyPull.title ?? pull.title };
    },
    async pullRequestDetail(prNumber) {
      const res = await githubRequest<GithubPull>(
        config,
        "GET",
        `${repoApi}/pulls/${prNumber}`,
        { signal: signal() },
      );
      const pull = res.data;
      if (!pull) return null;
      const merged = pull.merged === true || Boolean(pull.merged_at);
      return {
        number: pull.number,
        state: merged ? "merged" : pull.state === "open" ? "open" : "closed",
        merged,
        // GitHub computes this asynchronously and answers `null` right after a
        // push while it recomputes; never coerce that into `false` (conflict).
        mergeable: typeof pull.mergeable === "boolean" ? pull.mergeable : null,
        draft: pull.draft === true,
        headSha: pull.head?.sha ?? "",
        headBranch: pull.head?.ref ?? "",
        baseBranch: pull.base?.ref ?? "",
      };
    },
    async mergePullRequest(prNumber, options) {
      // A caller that proved the head and, when deleting, its branch is merged
      // with NO read in between — that read is a round trip its identity check
      // could not cover. Everyone else gets one read here, which binds the
      // decided base and supplies the head the merge is conditioned on.
      const { headBranch, expectedHeadSha } = await resolveMergePreconditions(
        prNumber,
        options,
        async () =>
          (
            await githubRequest<GithubPull>(
              config,
              "GET",
              `${repoApi}/pulls/${prNumber}`,
              { signal: signal() },
            )
          ).data ?? null,
      );
      await githubRequest<{ merged?: boolean; message?: string }>(
        config,
        "PUT",
        `${repoApi}/pulls/${prNumber}/merge`,
        {
          body: {
            merge_method: options.method,
            sha: expectedHeadSha,
          },
          signal: signal(),
        },
      );
      let branchDeleted = false;
      let branchDeleteError: string | undefined;
      if (options.deleteBranch && headBranch) {
        try {
          await githubRequest(
            config,
            "DELETE",
            `${repoApi}/git/refs/heads/${headBranch.split("/").map(encodeURIComponent).join("/")}`,
            { signal: signal() },
          );
          branchDeleted = true;
        } catch (err) {
          branchDeleteError = err instanceof Error ? err.message : String(err);
        }
      }
      return {
        number: prNumber,
        method: options.method,
        branchDeleted,
        ...(branchDeleteError ? { branchDeleteError } : {}),
      };
    },
    async closePullRequest(prNumber, options) {
      // GitHub's PR update has no head precondition, so the exact head is
      // proven by the read immediately before the write.
      const before = (
        await githubRequest<GithubPull>(
          config,
          "GET",
          `${repoApi}/pulls/${prNumber}`,
          { signal: signal() },
        )
      ).data;
      requireClosablePull(prNumber, before ?? null, options.expectedHeadSha);
      await githubRequest(config, "PATCH", `${repoApi}/pulls/${prNumber}`, {
        body: { state: "closed" },
        signal: signal(),
      });
      try {
        const after = (
          await githubRequest<GithubPull>(
            config,
            "GET",
            `${repoApi}/pulls/${prNumber}`,
            { signal: signal() },
          )
        ).data;
        return closeResultFrom(prNumber, options.expectedHeadSha, {
          state: after?.state ?? "",
          merged: after?.merged === true || Boolean(after?.merged_at),
          headSha: after?.head?.sha ?? "",
        });
      } catch (err) {
        return {
          number: prNumber,
          closed: false,
          headSha: options.expectedHeadSha,
          unconfirmedReason: `the close was sent but its state could not be confirmed (${errorText(err)}).`,
        };
      }
    },
    async repositoryCapabilities() {
      const repo = requireData(
        await githubRequest<GithubRepository>(config, "GET", repoApi, {
          signal: signal(),
        }),
        "repository settings",
      );
      if (!repo?.default_branch)
        throw new Error(
          `GitHub did not report a default branch for ${ref.owner}/${ref.repo}.`,
        );
      return {
        defaultBranch: repo.default_branch,
        ...mergeMethodsFrom(
          {
            squash: repo.allow_squash_merge,
            merge: repo.allow_merge_commit,
            rebase: repo.allow_rebase_merge,
          },
          {
            squash: "allow_squash_merge",
            merge: "allow_merge_commit",
            rebase: "allow_rebase_merge",
          },
        ),
        // GitHub repository metadata names no default merge method, so none is
        // reported rather than one being invented from the ordering above.
        canClose: true,
        canDeleteBranchOnMerge: true,
        ...(typeof repo.delete_branch_on_merge === "boolean"
          ? { deleteBranchOnMergeDefault: repo.delete_branch_on_merge }
          : {}),
      };
    },
    async ciStatus(refOid) {
      const summary = await githubRefChecks(
        config,
        ref.owner,
        ref.repo,
        refOid,
        signal(),
      );
      if (!summary || summary.total === 0) return null;
      const state: WorktreeCiStatus["state"] =
        summary.state === "failure"
          ? "failure"
          : summary.truncated
            ? "pending"
            : summary.state === "success"
              ? "success"
              : "pending";
      return {
        state,
        url: summary.url || `${repoWebUrl}/commit/${refOid}`,
        total: summary.total,
      };
    },
    async refChecks(refOid) {
      const summary = await githubRefChecks(
        config,
        ref.owner,
        ref.repo,
        refOid,
        signal(),
      );
      return {
        state:
          summary.total === 0
            ? "none"
            : summary.state === "failure"
              ? "failure"
              : summary.truncated
                ? "pending"
                : summary.state === "success"
                  ? "success"
                  : "pending",
        total: summary.total,
        ...(summary.truncated ? { truncated: true } : {}),
        checks: [
          ...summary.checkRuns.map((check) => ({
            name: check.name || check.app || "GitHub check",
            status: check.conclusion || check.status || "unknown",
            ...(check.url ? { url: check.url } : {}),
            ...(check.appSlug === "github-actions" && check.id !== null
              ? {
                  logJobId: check.id,
                  logUrl: `${config.apiBaseUrl.replace(/\/$/, "")}/repos/${encodeURIComponent(ref.owner)}/${encodeURIComponent(ref.repo)}/actions/jobs/${check.id}/logs`,
                }
              : {}),
            ...(check.output ? { excerpt: check.output } : {}),
          })),
          ...summary.statuses.map((status) => ({
            name: status.context || "GitHub status",
            status: status.state || "unknown",
            ...(status.url ? { url: status.url } : {}),
            ...(status.description ? { excerpt: status.description } : {}),
          })),
        ],
      };
    },
    async pullRequestReview(prNumber) {
      const res = await githubRequest<ProviderReview[]>(
        config,
        "GET",
        `${repoApi}/pulls/${prNumber}/reviews`,
        {
          query: { per_page: 100 },
          signal: signal(),
        },
      );
      const reviews = requireData(res, "pull request reviews");
      if (!Array.isArray(reviews)) return null;
      // No `unresolvedThreads`: thread resolution is GraphQL-only on GitHub.
      return { changesRequested: changesRequestedFromReviews(reviews) };
    },
    listOpenPullRequests() {
      return githubOpenPullRequests(config, ref, repoWebUrl, signal());
    },
    rateLimit() {
      return githubRateLimit(config);
    },
    openPullRequestAnnotation(prNumber) {
      const entry = openPullAnnotations.get(githubRepoKey(ref));
      if (!entry || Date.now() - entry.at >= OPEN_PULL_ANNOTATION_MS)
        return undefined;
      return entry.byNumber.get(prNumber);
    },
    branchStatuses(requests) {
      return githubBranchStatuses(
        config,
        ref,
        repoWebUrl,
        requests,
        signal,
        async (branch) => {
          const pr = await provider.findPullRequestForBranch(branch);
          return {
            pr,
            review:
              pr?.state === "open"
                ? await provider.pullRequestReview(pr.number)
                : null,
          };
        },
      );
    },
  };
  // Every write may change what a listed pull request looks like; drop the
  // repository's annotations after it, even when it threw part-way.
  const forgetting =
    <A extends unknown[], R>(write: (...args: A) => Promise<R>) =>
    (...args: A) =>
      write(...args).finally(() => forgetOpenPullAnnotations(ref));
  provider.createPullRequest = forgetting(provider.createPullRequest);
  provider.markPullRequestReady = forgetting(provider.markPullRequestReady);
  provider.mergePullRequest = forgetting(provider.mergePullRequest);
  provider.closePullRequest = forgetting(provider.closePullRequest);
  return provider;
}

/* ---------------------------------- forgejo --------------------------------- */

interface ForgejoPull {
  number: number;
  title: string;
  html_url: string;
  state: string;
  merged: boolean;
  /**
   * Gitea/Forgejo have no "still computing" value, so this ONE boolean carries
   * two different answers: `false` is a real conflict, but it is also what a
   * WIP/draft pull request and a queued conflict check report. It is therefore
   * never read as a conflict on its own — see `pullRequestDetail` below.
   */
  mergeable?: boolean;
  /**
   * `repo` names the head's OWN repository (`full_name`), which is what tells a
   * fork's identically named branch apart from this repository's; it is null
   * once that fork is deleted.
   */
  head?: { ref?: string; sha?: string; repo?: { full_name?: string } | null };
  base?: { ref?: string };
  user?: { login?: string };
  requested_reviewers?: Array<{ login?: string }> | null;
  draft?: boolean;
  updated_at?: string;
}

/**
 * Forgejo repository settings, as `GET /repos/{owner}/{repo}` reports them on
 * the configured instance. Nothing here shares GitHub's spelling, and a missing
 * flag is neither allowed nor denied: an instance that did not report one
 * leaves the whole supported set unknown (see {@link mergeMethodsFrom}).
 */
interface ForgejoRepository {
  default_branch?: string;
  allow_merge_commits?: boolean;
  allow_squash_merge?: boolean;
  allow_rebase?: boolean;
  /** Rebase, then a merge commit — outside the shared three-method vocabulary. */
  allow_rebase_explicit?: boolean;
  default_merge_style?: string;
  default_delete_branch_after_merge?: boolean;
}

/** Forgejo's merge style, mapped only when it IS one of the shared methods. */
function forgejoMergeStyle(
  style: string | undefined,
): PullRequestMergeMethod | undefined {
  return PULL_REQUEST_MERGE_METHODS.find((method) => method === style);
}

/**
 * Did the head branch of a just-merged Forgejo pull request really go away?
 * `deleted` is claimed ONLY for a 404 on the branch; every other answer,
 * including one we could not obtain, reports why it is unconfirmed.
 */
async function confirmForgejoBranchDeleted(
  config: ForgejoApiConfig,
  repoApi: string,
  prNumber: number,
  signal: () => AbortSignal,
  knownHeadRef?: string,
): Promise<{ deleted: boolean; reason?: string }> {
  // A caller that proved the head branch spares this read; only one that did
  // not asks the (already merged) pull request which ref it had.
  let headRef = knownHeadRef ?? "";
  if (!headRef)
    try {
      const res = await forgejoRequest<ForgejoPull>(
        config,
        "GET",
        `${repoApi}/pulls/${prNumber}`,
        { signal: signal() },
      );
      headRef = res.data?.head?.ref ?? "";
    } catch (err) {
      return {
        deleted: false,
        reason: `the branch deletion could not be confirmed (${errorText(err)}).`,
      };
    }
  if (!headRef)
    return {
      deleted: false,
      reason:
        "the branch deletion could not be confirmed (the pull request no longer reports a head branch).",
    };
  try {
    await forgejoRequest(
      config,
      "GET",
      `${repoApi}/branches/${headRef.split("/").map(encodeURIComponent).join("/")}`,
      { signal: signal() },
    );
    return {
      deleted: false,
      reason: "the branch still exists on the remote (it may be protected).",
    };
  } catch (err) {
    if (err instanceof ForgejoHttpError && err.status === 404)
      return { deleted: true };
    return {
      deleted: false,
      reason: `the branch deletion could not be confirmed (${errorText(err)}).`,
    };
  }
}

export function forgejoPullRequestTitle(title: string, draft = false): string {
  return draft && !/^(?:WIP:|\[WIP\])/i.test(title) ? `WIP: ${title}` : title;
}

export function forgejoReadyPullRequestTitle(title: string): string {
  return title.replace(/^(?:WIP:|\[WIP\])\s*/i, "");
}

function toPullRequestInfo(pull: ForgejoPull): WorktreePullRequestInfo {
  return {
    number: pull.number,
    url: pull.html_url,
    title: pull.title,
    state: pull.merged ? "merged" : pull.state === "open" ? "open" : "closed",
  };
}

/** Exported for tests: build the Forgejo provider without resolving a remote. */
export function forgejoProvider(
  ref: RemoteRepoRef,
  config: ForgejoApiConfig,
  parentSignal?: AbortSignal,
): GitHostingProvider {
  const repoApi = `/repos/${encodeURIComponent(ref.owner)}/${encodeURIComponent(ref.repo)}`;
  const repoWebUrl = `${normalizeForgejoBaseUrl(config.baseUrl)}/${ref.owner}/${ref.repo}`;
  const signal = () => requestSignal(parentSignal);
  /**
   * The BOUNDED newest-first read behind the tolerant single-result lookup.
   * Forgejo's list takes no head filter, so the branch (and its head
   * repository — the list includes fork pull requests) is matched here.
   */
  const recentPullsForBranch = async (
    headBranch: string,
  ): Promise<ForgejoPull[]> => {
    const res = await forgejoRequest<ForgejoPull[]>(
      config,
      "GET",
      `${repoApi}/pulls`,
      {
        // See the GitHub twin: `state: all` is what makes a merged PR — the end
        // of a branch's life — reachable at all.
        query: {
          state: "all",
          limit: MAX_PULL_REQUESTS,
          sort: "recentupdate",
        },
        signal: signal(),
      },
    );
    const pulls = requirePullRequestList<ForgejoPull>(
      requireData(res, "pull requests"),
      "pull requests",
    );
    return pulls.filter((pull) => headIsOwnBranch(pull, headBranch, ref));
  };
  return {
    kind: "forgejo",
    repository: ref,
    repoWebUrl,
    async findPullRequestsForBranch(headBranch) {
      const open: WorktreePullRequestInfo[] = [];
      let exhausted = false;
      // Forgejo cannot filter by head branch, so the repository's OPEN pull
      // requests are paged and filtered here. That is the cost of being able to
      // say "exactly one" rather than "one within the first page".
      for (let page = 1; page <= OPEN_PULL_REQUEST_PAGE_CAP; page += 1) {
        const res = await forgejoRequest<ForgejoPull[]>(
          config,
          "GET",
          `${repoApi}/pulls`,
          {
            query: {
              state: "open",
              limit: MAX_PULL_REQUESTS,
              page,
              sort: "recentupdate",
            },
            signal: signal(),
          },
        );
        const pulls = requirePullRequestList<ForgejoPull>(
          requireData(res, "open pull requests"),
          "open pull requests",
        );
        for (const pull of pulls)
          if (headIsOwnBranch(pull, headBranch, ref))
            open.push(toPullRequestInfo(pull));
        if (pulls.length < MAX_PULL_REQUESTS) {
          exhausted = true;
          break;
        }
      }
      if (!exhausted)
        throw new Error(
          `Forgejo still reported open pull requests after ${OPEN_PULL_REQUEST_PAGE_CAP} pages; the exact set for ${headBranch} could not be established.`,
        );
      if (open.length > 0) return { open };
      const terminal = (await recentPullsForBranch(headBranch)).find(
        (pull) => pull.state !== "open",
      );
      return {
        open,
        ...(terminal ? { latestTerminal: toPullRequestInfo(terminal) } : {}),
      };
    },
    async findPullRequestForBranch(headBranch) {
      return (
        pickBranchPull(
          (await recentPullsForBranch(headBranch)).map(toPullRequestInfo),
        ) ?? null
      );
    },
    async createPullRequest(input) {
      if (!config.token)
        throw new Error(
          "A Forgejo access token is not configured. Add one in Settings → Forgejo.",
        );
      const res = await forgejoRequest<ForgejoPull>(
        config,
        "POST",
        `${repoApi}/pulls`,
        {
          body: {
            title: forgejoPullRequestTitle(input.title, input.draft),
            body: input.body ?? "",
            head: input.head,
            base: input.base,
          },
          signal: signal(),
        },
      );
      return toPullRequestInfo(res.data);
    },
    async markPullRequestReady(prNumber) {
      if (!config.token)
        throw new Error(
          "A Forgejo access token is not configured. Add one in Settings → Forgejo.",
        );
      const pull = (
        await forgejoRequest<ForgejoPull>(
          config,
          "GET",
          `${repoApi}/pulls/${prNumber}`,
          { signal: signal() },
        )
      ).data;
      if (!pull)
        throw new Error(`Forgejo returned no pull request #${prNumber}.`);
      const title = forgejoReadyPullRequestTitle(pull.title);
      if (title === pull.title && pull.draft === true)
        throw new Error(
          `Forgejo pull request #${prNumber} reports a draft without a removable WIP title marker.`,
        );
      if (title !== pull.title)
        await forgejoRequest(config, "PATCH", `${repoApi}/issues/${prNumber}`, {
          body: { title },
          signal: signal(),
        });
      return { title };
    },
    async pullRequestDetail(prNumber) {
      const res = await forgejoRequest<ForgejoPull>(
        config,
        "GET",
        `${repoApi}/pulls/${prNumber}`,
        { signal: signal() },
      );
      const pull = res.data;
      if (!pull) return null;
      const draft =
        pull.draft === true || /^(?:WIP:|\[WIP\])/i.test(pull.title);
      return {
        number: pull.number,
        state: pull.merged
          ? "merged"
          : pull.state === "open"
            ? "open"
            : "closed",
        merged: pull.merged,
        // Gitea/Forgejo answer `mergeable: false` for EVERY work-in-progress
        // pull request, whatever its base looks like, so a draft's `false` is
        // UNKNOWN and travels as `null` — the same value GitHub uses while it
        // is still computing. Reading a draft-era `false` as a conflict paused
        // a workflow run on a phantom base conflict (Task 535). A non-draft
        // `false` can still be a queued check rather than a conflict; that one
        // is confirmed by a second read in `pullRequestWatcher.ts`.
        mergeable: draft
          ? pull.mergeable === true
            ? true
            : null
          : typeof pull.mergeable === "boolean"
            ? pull.mergeable
            : null,
        draft,
        headSha: pull.head?.sha ?? "",
        headBranch: pull.head?.ref ?? "",
        baseBranch: pull.base?.ref ?? "",
      };
    },
    async mergePullRequest(prNumber, options) {
      if (!config.token)
        throw new Error(
          "A Forgejo access token is not configured. Add one in Settings → Forgejo.",
        );
      // Merging and deleting are ONE request here, so Forgejo never needs the
      // branch name up front — but it still needs the head to condition on and
      // the base bound, and a caller that proved neither is read for once here.
      const { headBranch, expectedHeadSha } = await resolveMergePreconditions(
        prNumber,
        options,
        async () =>
          (
            await forgejoRequest<ForgejoPull>(
              config,
              "GET",
              `${repoApi}/pulls/${prNumber}`,
              { signal: signal() },
            )
          ).data ?? null,
      );
      // Gitea/Forgejo merge and branch deletion are one request: `Do` picks the
      // method, `delete_branch_after_merge` disposes of the head branch.
      await forgejoRequest(
        config,
        "POST",
        `${repoApi}/pulls/${prNumber}/merge`,
        {
          body: {
            Do: options.method,
            delete_branch_after_merge: options.deleteBranch === true,
            head_commit_id: expectedHeadSha,
          },
          signal: signal(),
        },
      );
      if (options.deleteBranch !== true)
        return {
          number: prNumber,
          method: options.method,
          branchDeleted: false,
        };
      // The merge response carries no separate deletion outcome and a PROTECTED
      // head branch is simply kept, so the deletion is CONFIRMED rather than
      // assumed: the card states it as fact, and a false claim about a branch is
      // worse than one more read.
      //
      // Exactly ONE outcome means "deleted": a 404 on the branch. Everything
      // else — the branch still there, an unauthorized/500/timeout answer, an
      // unreadable pull request — is reported as NOT confirmed, because a check
      // that could not be completed must not invent the answer it was for. The
      // merge itself already landed either way.
      const deletion = await confirmForgejoBranchDeleted(
        config,
        repoApi,
        prNumber,
        signal,
        headBranch,
      );
      return {
        number: prNumber,
        method: options.method,
        branchDeleted: deletion.deleted,
        ...(deletion.reason ? { branchDeleteError: deletion.reason } : {}),
      };
    },
    async closePullRequest(prNumber, options) {
      if (!config.token)
        throw new Error(
          "A Forgejo access token is not configured. Add one in Settings → Forgejo.",
        );
      const before = (
        await forgejoRequest<ForgejoPull>(
          config,
          "GET",
          `${repoApi}/pulls/${prNumber}`,
          { signal: signal() },
        )
      ).data;
      requireClosablePull(prNumber, before ?? null, options.expectedHeadSha);
      // Forgejo closes a pull request through the same state transition as an
      // issue, on the pulls endpoint's edit option.
      await forgejoRequest(config, "PATCH", `${repoApi}/pulls/${prNumber}`, {
        body: { state: "closed" },
        signal: signal(),
      });
      try {
        const after = (
          await forgejoRequest<ForgejoPull>(
            config,
            "GET",
            `${repoApi}/pulls/${prNumber}`,
            { signal: signal() },
          )
        ).data;
        return closeResultFrom(prNumber, options.expectedHeadSha, {
          state: after?.state ?? "",
          merged: after?.merged === true,
          headSha: after?.head?.sha ?? "",
        });
      } catch (err) {
        return {
          number: prNumber,
          closed: false,
          headSha: options.expectedHeadSha,
          unconfirmedReason: `the close was sent but its state could not be confirmed (${errorText(err)}).`,
        };
      }
    },
    async repositoryCapabilities() {
      const repo = requireData(
        await forgejoRequest<ForgejoRepository>(config, "GET", repoApi, {
          signal: signal(),
        }),
        "repository settings",
      );
      if (!repo?.default_branch)
        throw new Error(
          `Forgejo did not report a default branch for ${ref.owner}/${ref.repo}.`,
        );
      // Field names verified against the configured Forgejo API v1
      // (`GET /repos/{owner}/{repo}`), NOT carried over from GitHub: Forgejo
      // spells them `allow_merge_commits` and `allow_rebase`, and names its own
      // `default_merge_style`. `allow_rebase_explicit` is Forgejo's
      // rebase-then-merge-commit style, which the shared three-method
      // vocabulary has no word for, so it never enables `rebase`.
      const defaultMethod = forgejoMergeStyle(repo.default_merge_style);
      return {
        defaultBranch: repo.default_branch,
        ...mergeMethodsFrom(
          {
            squash: repo.allow_squash_merge,
            merge: repo.allow_merge_commits,
            rebase: repo.allow_rebase,
          },
          {
            squash: "allow_squash_merge",
            merge: "allow_merge_commits",
            rebase: "allow_rebase",
          },
        ),
        ...(defaultMethod ? { defaultMergeMethod: defaultMethod } : {}),
        canClose: true,
        canDeleteBranchOnMerge: true,
        ...(typeof repo.default_delete_branch_after_merge === "boolean"
          ? {
              deleteBranchOnMergeDefault:
                repo.default_delete_branch_after_merge,
            }
          : {}),
      };
    },
    async ciStatus(refOid) {
      const summary = await forgejoRefChecks(
        config,
        ref.owner,
        ref.repo,
        refOid,
        signal(),
      );
      if (summary.total === 0) return null;
      const state: WorktreeCiStatus["state"] =
        summary.state === "failure" || summary.state === "error"
          ? summary.state
          : summary.truncated
            ? "pending"
            : summary.state === "success"
              ? "success"
              : "pending";
      return {
        state,
        url: summary.url || `${repoWebUrl}/commit/${refOid}`,
        total: summary.total,
      };
    },
    async refChecks(refOid) {
      const summary = await forgejoRefChecks(
        config,
        ref.owner,
        ref.repo,
        refOid,
        signal(),
      );
      return {
        state:
          summary.total === 0
            ? "none"
            : summary.state === "failure" || summary.state === "error"
              ? "failure"
              : summary.truncated
                ? "pending"
                : summary.state === "success"
                  ? "success"
                  : "pending",
        total: summary.total,
        ...(summary.truncated ? { truncated: true } : {}),
        checks: summary.statuses.map((status) => ({
          name: status.context || "Forgejo status",
          status: status.state || "unknown",
          ...(status.url ? { url: status.url } : {}),
          ...(status.description ? { excerpt: status.description } : {}),
        })),
      };
    },
    async pullRequestReview(prNumber) {
      const res = await forgejoRequest<ProviderReview[]>(
        config,
        "GET",
        `${repoApi}/pulls/${prNumber}/reviews`,
        {
          query: { limit: 100 },
          signal: signal(),
        },
      );
      const reviews = requireData(res, "pull request reviews");
      if (!Array.isArray(reviews)) return null;
      return { changesRequested: changesRequestedFromReviews(reviews) };
    },
    async listOpenPullRequests() {
      const [res, login] = await Promise.all([
        forgejoRequest<ForgejoPull[]>(config, "GET", `${repoApi}/pulls`, {
          query: {
            state: "open",
            limit: MAX_PULL_REQUESTS,
            sort: "recentupdate",
          },
          signal: signal(),
        }),
        resolveForgejoLogin(config, signal()),
      ]);
      const pulls = requireData(res, "pull requests");
      if (!Array.isArray(pulls)) return null;
      return pulls.map((pull) => ({
        number: pull.number,
        url: pull.html_url,
        title: pull.title,
        headBranch: pull.head?.ref ?? "",
        baseBranch: pull.base?.ref ?? "",
        ...(pull.user?.login ? { author: pull.user.login } : {}),
        mine: Boolean(login) && pull.user?.login === login,
        reviewRequested:
          Boolean(login) &&
          (pull.requested_reviewers ?? []).some((r) => r?.login === login),
        ...(pull.draft === true || /^(?:WIP:|\[WIP\])/i.test(pull.title)
          ? { draft: true }
          : {}),
        ...updatedAtFragment(pull.updated_at),
      }));
    },
  };
}
