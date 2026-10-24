/**
 * Provider-abstract git hosting seam: pull requests and CI status for the
 * repository behind a checkout's selected push remote (`origin` by default),
 * or an explicitly named integration repository via `hostingProviderFor`.
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
  type PullRequestStack,
  type PullRequestReviewThread,
  type PullRequestReviewVerdict,
  type PullRequestTimelineEntry,
  type WorktreeCiStatus,
  type WorktreePullRequestInfo,
  type WorktreePullRequestReview,
} from "@assistant/shared";
import { gitOptional } from "./gitExec.ts";
import {
  getGithubConfigIfAvailable,
  getGithubToolConfig,
} from "./githubSettings.ts";
import {
  GITHUB_WEB_BASE,
  githubGraphql,
  githubRateLimit,
  githubRefChecks,
  githubRequest,
  type GithubApiConfig,
  type GithubRefChecksSummary,
  type GithubResponse,
} from "./githubClient.ts";
import {
  isFailedGitCheckStatus,
  isTerminalGitCheckStatus,
} from "./gitCheckStatus.ts";
import {
  getForgejoConfigIfAvailable,
  getForgejoToolConfig,
} from "./forgejoSettings.ts";
import {
  type ForgejoApiConfig,
  type ForgejoRefChecksSummary,
  ForgejoHttpError,
  forgejoRefChecks,
  forgejoRequest,
  normalizeForgejoBaseUrl,
  resolveForgejoLogin,
} from "./forgejoClient.ts";
import { errorText } from "./errors.ts";

const REQUEST_TIMEOUT_MS = 8_000;

/** The same ref verdict for the provider and agent-facing ref waits. */
export function githubRefChecksVerdict(
  summary: GithubRefChecksSummary,
  config: GithubApiConfig,
  ref: Pick<RemoteRepoRef, "owner" | "repo">,
): GitHostingRefChecks {
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
}

export function forgejoRefChecksVerdict(
  summary: ForgejoRefChecksSummary,
): GitHostingRefChecks {
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
}

/** Bound each provider request while still honoring a long-running tool's cancellation. */
function requestSignal(
  parentSignal?: AbortSignal,
  timeoutMs = REQUEST_TIMEOUT_MS,
): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
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
   *
   * `stack` is GitHub's native stack, read from the same response; a stack
   * the response carries in a shape this app cannot read is
   * `stackUnknownReason`, never silently absent.
   */
  pullRequestDetail(prNumber: number): Promise<PullRequestDetail | null>;
  /**
   * OPTIONAL: the members of one provider-native stack, bottom to top and
   * merged ones included, for a provider that has stacks (GitHub). A THROW
   * means they could not be read, including a body this app does not
   * understand.
   */
  stackMembers?(stackNumber: number): Promise<PullRequestStackMembers>;
  /**
   * OPTIONAL: where one accepted asynchronous merge request stands, for a
   * provider whose merges can come back pending (GitHub). `expired` = the
   * provider no longer knows the request (GitHub drops a result 24 h after
   * its last update). A THROW means it could not be asked.
   */
  mergeRequestStatus?(
    prNumber: number,
    requestId: string,
  ): Promise<MergeRequestStatus>;
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
   * Point one open pull request at another base branch. Neither backend offers
   * a precondition on this edit, so the caller proves the pull request's
   * identity immediately before and reads the result back after. A refusal (a
   * base missing on the remote, no permission, a closed pull request) THROWS
   * with the provider's own message.
   */
  retargetPullRequest(prNumber: number, base: string): Promise<void>;
  /** A pull request's current description, `""` when it has none. */
  pullRequestBody(prNumber: number): Promise<string>;
  /**
   * Replace a pull request's description. Like a retarget it has no
   * precondition, so the caller proves the pull request's identity before and
   * reads {@link pullRequestBody} back after. Returns the API URL when supplied;
   * a successful body-only response need not contain a URL or a full PR.
   */
  editPullRequestBody(
    prNumber: number,
    body: string,
  ): Promise<{ url?: string }>;
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
   *
   * GitHub merges asynchronously and is waited for, boundedly: a request it
   * accepted but has not finished comes back as `outcome: "pending"`, never
   * as a merge or a refusal. The branch is deleted only after a CONFIRMED
   * merge, and only while no other open pull request targets it as its base:
   * deleting a stacked pull request's base can close that pull request.
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
      /**
       * The native stack the caller bound (`null` = it proved there is none),
       * checked by the same pre-merge read: one that finds a stack the caller
       * did not bind refuses.
       */
      expectedStack?: PullRequestStack | null;
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
   *
   * A `comment` is posted after the head check and BEFORE the state
   * transition, so the pull request reads "why" above "closed"; a comment that
   * cannot be posted refuses the close. `deleteBranch` removes the head branch
   * only after a CONFIRMED close, only when it is this repository's own branch
   * (never a fork's), still at the closed head, and no other open pull request
   * targets it as its base. Like a merge, the deletion fails softly: the close
   * has landed by then.
   */
  closePullRequest(
    prNumber: number,
    options: {
      expectedHeadSha: string;
      comment?: string;
      deleteBranch?: boolean;
    },
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
  /** Raw: callers pass it through {@link ciBesideReviewGates} with the review. */
  ciStatus(ref: string): Promise<ProviderCiStatus | null>;
  /** Per-check machine evidence for an exact ref, used by Workflow Runs. */
  refChecks(ref: string): Promise<GitHostingRefChecks>;
  /**
   * What is written ON one pull request — description, comments, submitted
   * reviews, inline review threads — plus its current head, for the detail
   * page. Bounded per section; a THROW means it could not be read.
   */
  pullRequestConversation(
    prNumber: number,
    options?: { threadsOnly?: boolean },
  ): Promise<ProviderPullRequestConversation>;
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

/** {@link GitHostingProvider.pullRequestConversation}'s answer. */
interface ProviderPullRequestConversation {
  headSha?: string;
  body: string;
  author?: string;
  createdAt?: number;
  assignees: string[];
  requestedReviewers: { users: string[]; teams: string[] };
  /** Oldest first. */
  timeline: PullRequestTimelineEntry[];
  timelineTruncated?: boolean;
  threads: PullRequestReviewThread[];
  threadsTotal?: number;
}

/** Per-section bounds for the conversation read. */
const CONVERSATION_ENTRIES = 50;
const CONVERSATION_THREADS = 50;
const THREAD_COMMENTS = 20;
/** One body's characters; a longer one is cut with a note. */
const CONVERSATION_BODY_CHARS = 20_000;
const DIFF_HUNK_CHARS = 600;

function boundedBody(raw: unknown): string {
  const text = typeof raw === "string" ? raw : "";
  return text.length > CONVERSATION_BODY_CHARS
    ? `${text.slice(0, CONVERSATION_BODY_CHARS)}\n\n_… cut here; the rest is on the provider._`
    : text;
}

function parsedTime(raw: string | null | undefined): { createdAt?: number } {
  const parsed = raw ? Date.parse(raw) || undefined : undefined;
  return parsed !== undefined ? { createdAt: parsed } : {};
}

function boundedHunk(raw: unknown): { diffHunk?: string } {
  return typeof raw === "string" && raw
    ? { diffHunk: raw.slice(-DIFF_HUNK_CHARS) }
    : {};
}

/**
 * A "commented" review with no body is only the envelope of inline comments,
 * which the threads already show; listing it would put an empty "reviewed"
 * line in the conversation for every reply. Verdicts always stay.
 */
function keepReviewInTimeline(
  verdict: PullRequestReviewVerdict,
  body: string,
): boolean {
  return verdict !== "commented" || body.trim().length > 0;
}

function byCreatedAt(
  a: { createdAt?: number },
  b: { createdAt?: number },
): number {
  return (a.createdAt ?? 0) - (b.createdAt ?? 0);
}

/* ---------------------- GitHub conversation (GraphQL) ---------------------- */

interface GithubConversationComment {
  databaseId?: number | null;
  author?: { login?: string } | null;
  body?: string | null;
  createdAt?: string | null;
  url?: string | null;
}

interface GithubConversationPull {
  body?: string | null;
  createdAt?: string | null;
  headRefOid?: string | null;
  author?: { login?: string } | null;
  assignees?: { nodes?: Array<{ login?: string } | null> };
  reviewRequests?: {
    nodes?: Array<{
      requestedReviewer?: {
        __typename?: string;
        login?: string;
        slug?: string;
      } | null;
    } | null>;
  };
  comments?: {
    totalCount?: number;
    nodes?: Array<GithubConversationComment | null>;
  };
  reviews?: {
    totalCount?: number;
    nodes?: Array<
      | (GithubConversationComment & {
          state?: string | null;
          submittedAt?: string | null;
          comments?: { totalCount?: number };
        })
      | null
    >;
  };
  reviewThreads?: {
    totalCount?: number;
    nodes?: Array<{
      id?: string;
      isResolved?: boolean;
      isOutdated?: boolean;
      path?: string | null;
      line?: number | null;
      originalLine?: number | null;
      comments?: {
        totalCount?: number;
        nodes?: Array<
          | (GithubConversationComment & {
              diffHunk?: string | null;
            })
          | null
        >;
      };
    } | null>;
  };
}

/**
 * Team reviewers by `slug` only: reading a team's organization needs the
 * `read:org` scope, and one field the token may not read fails the whole
 * GraphQL query.
 */
const GITHUB_CONVERSATION_QUERY = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      body createdAt headRefOid author { login }
      assignees(first: 20) { nodes { login } }
      reviewRequests(first: 50) { nodes { requestedReviewer { __typename ... on User { login } ... on Team { slug } } } }
      comments(last: ${CONVERSATION_ENTRIES}) { totalCount nodes { databaseId author { login } body createdAt url } }
      reviews(last: ${CONVERSATION_ENTRIES}) { totalCount nodes { databaseId author { login } state body submittedAt url comments { totalCount } } }
      reviewThreads(last: ${CONVERSATION_THREADS}) { totalCount nodes { id isResolved isOutdated path line originalLine comments(first: ${THREAD_COMMENTS}) { totalCount nodes { databaseId author { login } body createdAt url diffHunk } } } }
    }
  }
}`;

const GITHUB_THREADS_QUERY = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      reviewThreads(last: ${CONVERSATION_THREADS}) { totalCount nodes { id isResolved isOutdated path line originalLine comments(first: ${THREAD_COMMENTS}) { totalCount nodes { databaseId author { login } body createdAt url diffHunk } } } }
    }
  }
}`;

const GITHUB_VERDICT: Record<string, PullRequestReviewVerdict> = {
  APPROVED: "approved",
  CHANGES_REQUESTED: "changes-requested",
  COMMENTED: "commented",
  DISMISSED: "dismissed",
};

function githubCommentOf(
  node: GithubConversationComment,
  createdAt?: string | null,
) {
  return {
    id: String(node.databaseId ?? ""),
    ...(node.author?.login ? { author: node.author.login } : {}),
    body: boundedBody(node.body),
    ...parsedTime(createdAt ?? node.createdAt),
    ...(node.url ? { url: node.url } : {}),
  };
}

async function githubPullRequestConversation(
  config: GithubApiConfig,
  ref: RemoteRepoRef,
  prNumber: number,
  signal: AbortSignal,
  threadsOnly = false,
): Promise<ProviderPullRequestConversation> {
  const data = await githubGraphql<{
    repository?: { pullRequest?: GithubConversationPull | null } | null;
  }>(
    config,
    threadsOnly ? GITHUB_THREADS_QUERY : GITHUB_CONVERSATION_QUERY,
    { owner: ref.owner, name: ref.repo, number: prNumber },
    signal,
  );
  const pull = data.repository?.pullRequest;
  if (!pull) throw new Error(`Pull request #${prNumber} was not found.`);
  const timeline: PullRequestTimelineEntry[] = [];
  for (const node of pull.comments?.nodes ?? [])
    if (node) timeline.push({ kind: "comment", ...githubCommentOf(node) });
  for (const node of pull.reviews?.nodes ?? []) {
    if (!node || !node.state || node.state === "PENDING") continue;
    const verdict = GITHUB_VERDICT[node.state] ?? "commented";
    const body = boundedBody(node.body);
    if (!keepReviewInTimeline(verdict, body)) continue;
    const inline = node.comments?.totalCount ?? 0;
    timeline.push({
      kind: "review",
      verdict,
      ...githubCommentOf(node, node.submittedAt),
      ...(inline > 0 ? { threadComments: inline } : {}),
    });
  }
  timeline.sort(byCreatedAt);
  const threads: PullRequestReviewThread[] = [];
  for (const node of pull.reviewThreads?.nodes ?? []) {
    if (!node?.id) continue;
    const comments = (node.comments?.nodes ?? []).filter(
      (comment): comment is NonNullable<typeof comment> => comment !== null,
    );
    const line = node.line ?? node.originalLine ?? undefined;
    threads.push({
      id: node.id,
      path: node.path ?? "",
      ...(line ? { line } : {}),
      ...(typeof node.isResolved === "boolean"
        ? { resolved: node.isResolved }
        : {}),
      ...(node.isOutdated ? { outdated: true } : {}),
      ...boundedHunk(comments[0]?.diffHunk),
      ...(comments[0]?.url ? { url: comments[0].url } : {}),
      comments: comments.map((comment) => githubCommentOf(comment)),
      ...((node.comments?.totalCount ?? 0) > comments.length
        ? { truncated: true }
        : {}),
    });
  }
  const users: string[] = [];
  const teams: string[] = [];
  for (const request of pull.reviewRequests?.nodes ?? []) {
    const reviewer = request?.requestedReviewer;
    if (reviewer?.__typename === "User" && reviewer.login)
      users.push(reviewer.login);
    else if (reviewer?.__typename === "Team" && reviewer.slug)
      teams.push(reviewer.slug);
  }
  const entriesTotal =
    (pull.comments?.totalCount ?? 0) + (pull.reviews?.totalCount ?? 0);
  const threadsTotal = pull.reviewThreads?.totalCount ?? threads.length;
  return {
    ...(pull.headRefOid ? { headSha: pull.headRefOid } : {}),
    body: boundedBody(pull.body),
    ...(pull.author?.login ? { author: pull.author.login } : {}),
    ...parsedTime(pull.createdAt),
    assignees: (pull.assignees?.nodes ?? [])
      .map((node) => node?.login)
      .filter((login): login is string => Boolean(login)),
    requestedReviewers: { users, teams },
    timeline,
    ...((pull.comments?.totalCount ?? 0) >
      (pull.comments?.nodes?.length ?? 0) ||
    (pull.reviews?.totalCount ?? 0) > (pull.reviews?.nodes?.length ?? 0)
      ? { timelineTruncated: entriesTotal > 0 }
      : {}),
    threads,
    ...(threadsTotal > threads.length ? { threadsTotal } : {}),
  };
}

/** Resolve or reopen only a review thread belonging to the approved repository and PR. */
export async function githubSetReviewThreadResolved(
  ref: Pick<RemoteRepoRef, "owner" | "repo">,
  config: GithubApiConfig,
  prNumber: number,
  threadId: string,
  resolved: boolean,
  signal?: AbortSignal,
): Promise<void> {
  if (!Number.isSafeInteger(prNumber) || prNumber < 1)
    throw new Error("number must be a valid pull-request number.");
  if (typeof threadId !== "string" || !threadId.trim())
    throw new Error("threadId must be a non-empty review-thread id.");
  if (typeof resolved !== "boolean")
    throw new Error("resolved must be a boolean.");
  const data = await githubGraphql<{
    node?: {
      __typename?: string;
      id?: string;
      isResolved?: boolean;
      pullRequest?: {
        number?: number;
        repository?: { nameWithOwner?: string };
      };
    } | null;
  }>(
    config,
    `query($id: ID!) {
    node(id: $id) { __typename ... on PullRequestReviewThread {
      id isResolved pullRequest { number repository { nameWithOwner } }
    } }
  }`,
    { id: threadId },
    requestSignal(signal),
  );
  const node = data.node;
  if (
    node?.__typename !== "PullRequestReviewThread" ||
    node.id !== threadId ||
    node.pullRequest?.number !== prNumber ||
    node.pullRequest.repository?.nameWithOwner?.toLowerCase() !==
      `${ref.owner}/${ref.repo}`.toLowerCase()
  )
    throw new Error(
      `Review thread does not belong to pull request ${ref.owner}/${ref.repo}#${prNumber}, or is unavailable.`,
    );
  if (node.isResolved === resolved) return;
  const field = resolved ? "resolveReviewThread" : "unresolveReviewThread";
  const result = await githubGraphql<
    Record<string, { thread?: { id?: string; isResolved?: boolean } } | null>
  >(
    config,
    `mutation($threadId: ID!) { ${field}(input: {threadId: $threadId}) { thread { id isResolved } } }`,
    { threadId },
    requestSignal(signal),
  );
  if (
    result[field]?.thread?.id !== threadId ||
    result[field]?.thread?.isResolved !== resolved
  )
    throw new Error(
      "GitHub did not confirm the requested review-thread state; read the thread again before retrying.",
    );
}

/* ------------------------ Forgejo conversation (REST) ---------------------- */

interface ForgejoComment {
  id?: number;
  user?: { login?: string } | null;
  body?: string | null;
  created_at?: string | null;
  html_url?: string | null;
}

interface ForgejoReview extends ForgejoComment {
  state?: string | null;
  submitted_at?: string | null;
  comments_count?: number;
  dismissed?: boolean;
  stale?: boolean;
}

interface ForgejoReviewComment extends ForgejoComment {
  path?: string | null;
  line?: number | null;
  original_line?: number | null;
  position?: number | null;
  original_position?: number | null;
  diff_hunk?: string | null;
  resolver?: { login?: string } | null;
  pull_request_review_id?: number;
}

const FORGEJO_VERDICT: Record<string, PullRequestReviewVerdict> = {
  APPROVED: "approved",
  REQUEST_CHANGES: "changes-requested",
  COMMENT: "commented",
};

/** Reviews whose inline comments are read (one request each). */
const FORGEJO_REVIEWS_WITH_COMMENTS = 20;

function forgejoCommentOf(node: ForgejoComment, createdAt?: string | null) {
  return {
    id: String(node.id ?? ""),
    ...(node.user?.login ? { author: node.user.login } : {}),
    body: boundedBody(node.body),
    ...parsedTime(createdAt ?? node.created_at),
    ...(node.html_url ? { url: node.html_url } : {}),
  };
}

async function forgejoPullRequestConversation(
  config: ForgejoApiConfig,
  repoApi: string,
  prNumber: number,
  signal: () => AbortSignal,
): Promise<ProviderPullRequestConversation> {
  const [pullRes, commentsRes, reviewsRes] = await Promise.all([
    forgejoRequest<
      ForgejoPull & {
        body?: string | null;
        created_at?: string | null;
        assignees?: Array<{ login?: string }> | null;
        requested_reviewers_teams?: Array<{ name?: string }> | null;
      }
    >(config, "GET", `${repoApi}/pulls/${prNumber}`, { signal: signal() }),
    forgejoRequest<ForgejoComment[]>(
      config,
      "GET",
      `${repoApi}/issues/${prNumber}/comments`,
      { query: { limit: CONVERSATION_ENTRIES }, signal: signal() },
    ),
    forgejoRequest<ForgejoReview[]>(
      config,
      "GET",
      `${repoApi}/pulls/${prNumber}/reviews`,
      { query: { limit: CONVERSATION_ENTRIES }, signal: signal() },
    ),
  ]);
  const pull = requireData(pullRes, "the pull request");
  const comments = requirePullRequestList<ForgejoComment>(
    requireData(commentsRes, "pull request comments"),
    "pull request comments",
  );
  const reviews = requirePullRequestList<ForgejoReview>(
    requireData(reviewsRes, "pull request reviews"),
    "pull request reviews",
  );
  const timeline: PullRequestTimelineEntry[] = comments.map((comment) => ({
    kind: "comment",
    ...forgejoCommentOf(comment),
  }));
  for (const review of reviews) {
    const raw = review.state ?? "";
    if (raw === "PENDING" || raw === "REQUEST_REVIEW") continue;
    const verdict: PullRequestReviewVerdict = review.dismissed
      ? "dismissed"
      : (FORGEJO_VERDICT[raw] ?? "commented");
    const body = boundedBody(review.body);
    if (!keepReviewInTimeline(verdict, body)) continue;
    timeline.push({
      kind: "review",
      verdict,
      ...forgejoCommentOf(review, review.submitted_at),
      ...((review.comments_count ?? 0) > 0
        ? { threadComments: review.comments_count! }
        : {}),
    });
  }
  timeline.sort(byCreatedAt);
  // Forgejo hangs inline comments off the review that wrote them and has no
  // reply chain, so a thread is the comments on one path and line, in order.
  const commented = reviews
    .filter((review) => (review.comments_count ?? 0) > 0 && review.id)
    .slice(-FORGEJO_REVIEWS_WITH_COMMENTS);
  const inline = (
    await Promise.all(
      commented.map(async (review) => {
        const res = await forgejoRequest<ForgejoReviewComment[]>(
          config,
          "GET",
          `${repoApi}/pulls/${prNumber}/reviews/${review.id}/comments`,
          { signal: signal() },
        );
        return requirePullRequestList<ForgejoReviewComment>(
          requireData(res, "review comments"),
          "review comments",
        );
      }),
    )
  ).flat();
  inline.sort((a, b) =>
    byCreatedAt(parsedTime(a.created_at), parsedTime(b.created_at)),
  );
  const threadsByKey = new Map<string, ForgejoReviewComment[]>();
  for (const comment of inline) {
    const line =
      comment.line ??
      comment.original_line ??
      comment.position ??
      comment.original_position ??
      0;
    const key = `${comment.path ?? ""}#${line}`;
    const list = threadsByKey.get(key) ?? [];
    list.push(comment);
    threadsByKey.set(key, list);
  }
  const threads: PullRequestReviewThread[] = [...threadsByKey].map(
    ([key, list]) => {
      const head = list[0]!;
      const line =
        head.line ?? head.original_line ?? head.position ?? undefined;
      const shown = list.slice(0, THREAD_COMMENTS);
      return {
        id: `${prNumber}:${key}`,
        path: head.path ?? "",
        ...(line ? { line } : {}),
        // Forgejo records who resolved a conversation on its comments.
        resolved: list.some((comment) => Boolean(comment.resolver)),
        ...(head.line == null && head.original_line != null
          ? { outdated: true }
          : {}),
        ...boundedHunk(head.diff_hunk),
        ...(head.html_url ? { url: head.html_url } : {}),
        comments: shown.map((comment) => forgejoCommentOf(comment)),
        ...(list.length > shown.length ? { truncated: true } : {}),
      };
    },
  );
  return {
    ...(pull.head?.sha ? { headSha: pull.head.sha } : {}),
    body: boundedBody(pull.body),
    ...(pull.user?.login ? { author: pull.user.login } : {}),
    ...parsedTime(pull.created_at),
    assignees: (pull.assignees ?? [])
      .map((user) => user?.login)
      .filter((login): login is string => Boolean(login)),
    requestedReviewers: {
      users: (pull.requested_reviewers ?? [])
        .map((user) => user?.login)
        .filter((login): login is string => Boolean(login)),
      teams: (pull.requested_reviewers_teams ?? [])
        .map((team) => team?.name)
        .filter((name): name is string => Boolean(name)),
    },
    timeline,
    ...(comments.length >= CONVERSATION_ENTRIES ||
    reviews.length >= CONVERSATION_ENTRIES
      ? { timelineTruncated: true }
      : {}),
    threads: threads.slice(-CONVERSATION_THREADS),
    ...(threads.length > CONVERSATION_THREADS
      ? { threadsTotal: threads.length }
      : {}),
  };
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
  ci: ProviderCiStatus | null;
  /** Only for an OPEN pull request; `null` otherwise. */
  review: WorktreePullRequestReview | null;
}

/** An open pull request's detail, head CI and review, read with its list. */
interface OpenPullRequestAnnotation {
  detail: PullRequestDetail;
  ci: ProviderCiStatus | null;
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

/** Where one accepted asynchronous merge request stands. */
export interface MergeRequestStatus {
  status: "pending" | "merged" | "failed" | "expired";
  /** The provider's own words, for a failure. */
  message?: string;
}

/** One provider-native stack's members, bottom to top, merged ones included. */
export interface PullRequestStackMembers {
  number: number;
  members: Array<{
    number: number;
    state: "open" | "merged" | "closed";
  }>;
}

type BranchDeletionOutcome = Pick<
  Extract<PullRequestMergeResult, { outcome: "merged" }>,
  "branchDeleted" | "branchDeleteError" | "branchKeptReason"
>;

/**
 * Delete a MERGED or CLOSED pull request's head branch — unless another open
 * pull request still targets it as its base.
 *
 * That is what a stack looks like, native or not: the branch just merged is
 * the base of the pull request above it. A native stack's is retargeted by
 * the time the merge reports done, but a plain chain's is not retargeted at
 * all — deleting its base CLOSES it, for good. So any open dependent keeps
 * the branch, and so does a dependents read that failed: a kept branch costs
 * a later cleanup, a closed pull request costs the work on it.
 */
async function deleteFinishedHeadBranch(
  headBranch: string,
  openPullsTargeting: (branch: string) => Promise<number[]>,
  remove: () => Promise<BranchDeletionOutcome>,
): Promise<BranchDeletionOutcome> {
  let dependents: number[];
  try {
    dependents = await openPullsTargeting(headBranch);
  } catch (err) {
    return {
      branchDeleted: false,
      branchKeptReason: `whether another open pull request targets it could not be checked (${errorText(err)})`,
    };
  }
  if (dependents.length > 0) {
    const list = dependents.map((number) => `#${number}`).join(", ");
    return {
      branchDeleted: false,
      branchKeptReason: `${list} still ${dependents.length === 1 ? "targets" : "target"} it as base, and deleting it could close ${dependents.length === 1 ? "that pull request" : "them"}; delete it once nothing targets it`,
    };
  }
  return remove();
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

/** The provider steps {@link closePullRequestWith} orders for both backends. */
interface CloseSteps<Pull> {
  read(): Promise<Pull | null>;
  postComment(body: string): Promise<{ url?: string }>;
  close(): Promise<void>;
  /** The post-write state, in the shape {@link closeResultFrom} reads. */
  state(pull: Pull | null): { state: string; merged: boolean; headSha: string };
  openPullsTargeting(branch: string): Promise<number[]>;
  /** Delete `branch` only while it still points at `headSha`. */
  removeBranch(branch: string, headSha: string): Promise<BranchDeletionOutcome>;
}

/**
 * Close one pull request: prove the head, post the comment, close, confirm,
 * then delete the head branch when asked. Both providers share this order;
 * only the HTTP calls differ.
 */
async function closePullRequestWith<
  Pull extends {
    state?: string;
    merged?: boolean;
    head?: {
      ref?: string;
      sha?: string;
      repo?: { full_name?: string } | null;
    };
  },
>(
  prNumber: number,
  options: Parameters<GitHostingProvider["closePullRequest"]>[1],
  ref: RemoteRepoRef,
  steps: CloseSteps<Pull>,
): Promise<PullRequestCloseResult> {
  const before = await steps.read();
  requireClosablePull(prNumber, before, options.expectedHeadSha);
  const comment = options.comment?.trim();
  let commentUrl: string | undefined;
  if (comment) {
    try {
      commentUrl = (await steps.postComment(comment)).url ?? "";
    } catch (err) {
      throw new Error(
        `The closing comment on pull request #${prNumber} could not be posted (${errorText(err)}); nothing was closed.`,
      );
    }
  }
  try {
    await steps.close();
  } catch (err) {
    if (commentUrl === undefined) throw err;
    throw new Error(
      `${errorText(err)} The closing comment was already posted${commentUrl ? ` (${commentUrl})` : ""}, but the pull request was not closed.`,
    );
  }
  const commented = commentUrl !== undefined ? { commentUrl } : {};
  let result: PullRequestCloseResult;
  try {
    result = {
      ...closeResultFrom(
        prNumber,
        options.expectedHeadSha,
        steps.state(await steps.read()),
      ),
      ...commented,
    };
  } catch (err) {
    result = {
      number: prNumber,
      closed: false,
      headSha: options.expectedHeadSha,
      unconfirmedReason: `the close was sent but its state could not be confirmed (${errorText(err)}).`,
      ...commented,
    };
  }
  if (options.deleteBranch !== true) return result;
  const headBranch = before?.head?.ref ?? "";
  if (!result.closed)
    return {
      ...result,
      branchDeleted: false,
      branchKeptReason: "closure was not confirmed",
    };
  if (!headBranch || !headIsOwnBranch(before!, headBranch, ref))
    return {
      ...result,
      branchDeleted: false,
      branchKeptReason:
        "the head branch is not one of this repository's own branches (a fork, or unreported)",
    };
  return {
    ...result,
    ...(await deleteFinishedHeadBranch(
      headBranch,
      steps.openPullsTargeting,
      () => steps.removeBranch(headBranch, options.expectedHeadSha),
    )),
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
  return standingChangeRequests(reviews).length > 0;
}

/**
 * The review read model, plus the GitHub Apps among the reviewers asking for
 * changes. `appOf` names the app behind a review's author, `null` for a person;
 * a provider without apps (Forgejo) passes none.
 */
function reviewFromProviderReviews(
  reviews: ProviderReview[],
  appOf?: (review: ProviderReview) => string | null,
): WorktreePullRequestReview {
  const standing = standingChangeRequests(reviews);
  const apps = appOf
    ? [
        ...new Set(
          standing.flatMap((review) => {
            const app = appOf(review);
            return app ? [app] : [];
          }),
        ),
      ]
    : [];
  return {
    changesRequested: standing.length > 0,
    ...(apps.length > 0 ? { changesRequestedByApps: apps } : {}),
  };
}

/**
 * The app slug behind a GitHub review author. An app's bot account is
 * `<slug>[bot]` over REST; GraphQL types it `Bot` and drops the suffix.
 */
function githubReviewApp(
  login: string | undefined,
  bot: boolean,
): string | null {
  if (!login) return null;
  const slug = login.replace(/\[bot\]$/i, "");
  return bot || slug !== login ? slug.toLowerCase() : null;
}

/**
 * CI as a provider reads it, before {@link ciBesideReviewGates} sets aside the
 * failures that are really a review. Never sent as is: the gate strips the two
 * extra fields.
 */
export interface ProviderCiStatus extends WorktreeCiStatus {
  /** One per FAILED row: the GitHub App that posted it, `null` when none is known. */
  failedApps?: Array<string | null>;
  /** State and link with every failed row set aside. */
  besideFailures?: { state: "success" | "pending"; url?: string };
}

/**
 * CI without the checks that are a reviewer's verdict. A review bot such as
 * Percival fails its own check while its findings are open, so a team can make
 * it required; that is the same objection as its "changes requested" review,
 * not a broken build, and reading it as CI paints the pull request red. A
 * failure is set aside only when EVERY failed row was posted by an app whose
 * review currently requests changes: one failing build keeps the whole state
 * a failure, and a failing check without such a review (a broken config) stays
 * CI.
 */
export function ciBesideReviewGates(
  ci: ProviderCiStatus | null,
  review: WorktreePullRequestReview | null | undefined,
): WorktreeCiStatus | null {
  if (!ci) return null;
  const { failedApps, besideFailures, ...plain } = ci;
  const gates = review?.changesRequested ? review.changesRequestedByApps : [];
  if (
    plain.state !== "failure" ||
    !besideFailures ||
    !failedApps?.length ||
    !gates?.length ||
    !failedApps.every((app) => app !== null && gates.includes(app))
  )
    return plain;
  return {
    ...plain,
    state: besideFailures.state,
    ...(besideFailures.url ? { url: besideFailures.url } : {}),
  };
}

/** One check run or legacy status, reduced to what the CI rule reads. */
interface CiRow {
  failed: boolean;
  terminal: boolean;
  url: string | null;
  /** The GitHub App slug that posted it; `null` for a legacy status. */
  app: string | null;
}

/**
 * The CI rule over check rows: any failed row fails, a row still running — or
 * rows beyond the first page — keep it pending, and no checks at all is `null`.
 */
function ciFromRows(
  rows: CiRow[],
  total: number,
  commitUrl: string,
): ProviderCiStatus | null {
  if (total === 0) return null;
  const failed = rows.filter((row) => row.failed);
  const others = rows.filter((row) => !row.failed);
  const besideState =
    total > rows.length || others.some((row) => !row.terminal)
      ? "pending"
      : "success";
  const besideUrl = others[0]?.url || commitUrl;
  if (failed.length === 0) return { state: besideState, url: besideUrl, total };
  return {
    state: "failure",
    url: failed[0]?.url || commitUrl,
    total,
    failedApps: failed.map((row) => row.app?.toLowerCase() || null),
    besideFailures: { state: besideState, url: besideUrl },
  };
}

/** Each person's latest opinionated review, where that review asks for changes. */
function standingChangeRequests(reviews: ProviderReview[]): ProviderReview[] {
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
  return [...latestByUser.values()].filter((review) => {
    const state = (review.state ?? "").toUpperCase();
    return state === "REQUEST_CHANGES" || state === "CHANGES_REQUESTED";
  });
}

/**
 * Build a provider for an explicit integration repository using current tool
 * settings. Throws the integration's settings error, without remote detection
 * or fallback. Construct at the caller's settings-snapshot boundary.
 */
export function hostingProviderFor(
  input: { service: GitHostingProviderKind; owner: string; repo: string },
  signal?: AbortSignal,
): GitHostingProvider {
  const { owner, repo } = input;
  switch (input.service) {
    case "github":
      return githubProvider(
        { host: "github.com", owner, repo },
        getGithubToolConfig(),
        signal,
      );
    case "forgejo": {
      const config = getForgejoToolConfig();
      return forgejoProvider(
        {
          host: new URL(normalizeForgejoBaseUrl(config.baseUrl)).host,
          owner,
          repo,
        },
        config,
        signal,
      );
    }
    default:
      throw new Error(
        `Unsupported git hosting service: ${String(input.service)}`,
      );
  }
}

/**
 * Resolve the provider for one named remote of the repo containing `repoPath`.
 * The push URL is authoritative: a remote may fetch from one repository while
 * publishing to another, and PR creation must follow the latter.
 */
export async function hostingProviderForRepo(
  repoPath: string,
  remote = "origin",
  signal?: AbortSignal,
): Promise<GitHostingProvider | null> {
  const remoteRes = await gitOptional(
    ["remote", "get-url", "--push", remote],
    repoPath,
    signal,
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
        return forgejoProvider(ref, forgejoConfig, signal);
      }
    } catch {
      // Invalid configured base URL — treat as unconfigured.
    }
  }
  if (ref.host === "github.com") {
    // Uses the existing GitHub PAT integration; absent/disabled = feature off.
    const config = getGithubConfigIfAvailable();
    if (config) return githubProvider(ref, config, signal);
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
  head?: {
    ref?: string;
    sha?: string;
    repo?: { full_name?: string; node_id?: string } | null;
  };
  base?: { ref?: string };
  user?: { login?: string };
  requested_reviewers?: Array<{ login?: string }>;
  draft?: boolean;
  node_id?: string;
  updated_at?: string;
  /** GitHub's native stack, when the pull request is in one; see {@link githubStackFrom}. */
  stack?: unknown;
}

/**
 * GitHub's `stack` object onto the shared shape — the ONE place that knows
 * how GitHub spells it, so a live answer that differs is fixed here.
 *
 * Absent or `null` is "not stacked". Anything else that does not carry every
 * field is UNKNOWN rather than absent: a stacked pull request read as an
 * unstacked one would merge the pull requests below it too.
 */
function githubStackFrom(
  raw: unknown,
): Pick<PullRequestDetail, "stack" | "stackUnknownReason"> {
  if (raw === undefined || raw === null) return {};
  const stack = raw as {
    number?: unknown;
    size?: unknown;
    position?: unknown;
    base?: { ref?: unknown } | null;
  };
  const baseBranch = stack.base?.ref;
  if (
    typeof stack.number !== "number" ||
    typeof stack.size !== "number" ||
    typeof stack.position !== "number" ||
    typeof baseBranch !== "string" ||
    !baseBranch
  )
    return {
      stackUnknownReason:
        "GitHub reported a stack for it in a shape this app does not understand",
    };
  return {
    stack: {
      number: stack.number,
      size: stack.size,
      position: stack.position,
      baseBranch,
    },
  };
}

/**
 * One answer about a GitHub `merge-async` request — the PUT, a poll, or a
 * refusal: every one of them, 4xx included, is JSON with `status` and
 * `details`, and the request id travels in `details.uuid`.
 */
interface GithubMergeRequest {
  /** `pending` | `merged` | `enqueued` | `failed`. */
  status?: string;
  message?: string;
  details?: {
    message?: string;
    uuid?: string;
    merge_method?: string;
    merge_action?: string;
    expected_head_sha?: string;
  } | null;
}

/** The statuses whose body says why GitHub refused, read rather than thrown. */
const GITHUB_MERGE_REFUSAL_STATUSES: readonly number[] = [
  400, 403, 404, 405, 409, 422,
];

type GithubMergeState =
  | { kind: "merged" }
  | { kind: "poll"; requestId: string }
  | { kind: "pending"; requestId?: string; reason: string };

/** What this merge asked for, which a request GitHub already holds must match. */
interface GithubMergeAsk {
  sha: string;
  method: PullRequestMergeMethod;
}

/**
 * GitHub's refusal in its own words. A head that moved is the same refusal
 * the seam's own head check gives, so it reads like one.
 */
function githubMergeRefusal(prNumber: number, message: string): Error {
  return /head branch was modified/i.test(message)
    ? new Error(
        `Pull request #${prNumber} head moved since it was checked (GitHub: ${message}); nothing was merged. Re-check it and decide again.`,
      )
    : new Error(
        `GitHub refused to merge pull request #${prNumber}: ${message}`,
      );
}

/**
 * What one `merge-async` answer means. Only `merged` is a merge; `failed` and
 * a refusal status throw. Anything else this app cannot settle is PENDING,
 * never guessed into either — and the decision rests on `status` alone: the
 * accepting answer's MESSAGE says "enqueued" even for a direct merge.
 */
function githubMergeStateFrom(
  prNumber: number,
  httpStatus: number,
  answer: GithubMergeRequest | null | undefined,
  ask: GithubMergeAsk,
  knownRequestId?: string,
): GithubMergeState {
  const details = answer?.details ?? undefined;
  const message = details?.message || answer?.message || `HTTP ${httpStatus}`;
  const requestId =
    (typeof details?.uuid === "string" && details.uuid) || knownRequestId;
  if (httpStatus === 409 && requestId) {
    // A request already exists for this pull request. Following it is what
    // makes a retry after a lost answer safe — but only when it IS this
    // merge: someone else's request for another head or method is not ours
    // to adopt.
    if (
      (details?.expected_head_sha ?? "").toLowerCase() ===
        ask.sha.toLowerCase() &&
      details?.merge_method === ask.method &&
      details?.merge_action === "direct_merge"
    )
      return { kind: "poll", requestId };
    throw new Error(
      `GitHub is already running another merge request for pull request #${prNumber} (${details?.merge_method ?? "unknown method"} at ${details?.expected_head_sha ?? "an unreported head"}); this merge sent nothing.`,
    );
  }
  if (httpStatus >= 400) throw githubMergeRefusal(prNumber, message);
  const status = answer?.status;
  if (status === "merged") return { kind: "merged" };
  if (status === "failed") throw githubMergeRefusal(prNumber, message);
  if (status === "enqueued")
    return {
      kind: "pending",
      ...(requestId ? { requestId } : {}),
      reason: "GitHub put it in the merge queue instead of merging it",
    };
  if (requestId) return { kind: "poll", requestId };
  return {
    kind: "pending",
    reason: `GitHub answered with status ${status || "(none)"} and no request to follow`,
  };
}

/**
 * How long a GitHub merge waits for its own outcome, and the waits between
 * polls (the last one repeats). The bound is ABSOLUTE — the PUT, every wait
 * and every poll's own request time count against it — because the merge
 * holds this pull request's mutation lock all along; one still unfinished
 * comes back PENDING for the watcher to settle.
 */
interface GithubMergeWait {
  budgetMs: number;
  delaysMs: readonly number[];
  now: () => number;
  /** Wait, or stop early when the caller gave up; `false` = cancelled. */
  pause: (ms: number, signal?: AbortSignal) => Promise<boolean>;
}

const GITHUB_MERGE_WAIT: GithubMergeWait = {
  budgetMs: 45_000,
  delaysMs: [1_000, 2_000, 3_000, 5_000],
  now: () => Date.now(),
  pause,
};
let githubMergeWait = GITHUB_MERGE_WAIT;

/** Test seam: replace (or restore) the merge wait's budget, steps and clock. */
export function setGithubMergeWaitForTests(
  wait?: Partial<GithubMergeWait>,
): void {
  githubMergeWait = { ...GITHUB_MERGE_WAIT, ...wait };
}

function pause(ms: number, signal?: AbortSignal): Promise<boolean> {
  if (signal?.aborted) return Promise.resolve(false);
  return new Promise((resolve) => {
    const onAbort = () => {
      clearTimeout(timer);
      resolve(false);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve(true);
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** Whether two reads describe the same native stack (or both none). */
export function samePullRequestStack(
  a: PullRequestStack | null | undefined,
  b: PullRequestStack | null | undefined,
): boolean {
  if (!a || !b) return !a && !b;
  return (
    a.number === b.number &&
    a.size === b.size &&
    a.position === b.position &&
    a.baseBranch === b.baseBranch
  );
}

/**
 * A pre-merge read that happened anyway must not pass a pull request whose
 * native stack is not the one the caller bound — including a stack that
 * appeared after the caller looked: merging it would land the pull requests
 * below it too.
 */
function requireBoundStack(
  prNumber: number,
  raw: unknown,
  expected: PullRequestStack | null | undefined,
): void {
  const seen = githubStackFrom(raw);
  if (seen.stackUnknownReason)
    throw new Error(
      `Pull request #${prNumber} was not merged: ${seen.stackUnknownReason}.`,
    );
  if (!samePullRequestStack(seen.stack, expected))
    throw new Error(
      `Pull request #${prNumber} is ${seen.stack ? `in stack ${seen.stack.number} (${seen.stack.position} of ${seen.stack.size} on ${seen.stack.baseBranch})` : "not in a stack"}, which is not what this merge was decided for; nothing was merged.`,
    );
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
      ... on CheckRun { status conclusion url detailsUrl checkSuite { app { slug } } }
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
      checkSuite?: { app?: { slug?: string | null } | null } | null;
      state?: string | null;
      targetUrl?: string | null;
    } | null>;
  };
}

/** The REST `ciStatus` rule over a rollup; see {@link ciFromRows}. */
function ciFromGithubRollup(
  rollup: GithubRollup | null | undefined,
  commitUrl: string,
): ProviderCiStatus | null {
  const rows = (rollup?.contexts?.nodes ?? []).flatMap((node): CiRow[] => {
    if (!node) return [];
    const check = node.__typename === "CheckRun";
    return [
      {
        failed: isFailedGitCheckStatus(check ? node.conclusion : node.state),
        terminal: isTerminalGitCheckStatus(check ? node.status : node.state),
        url: (check ? node.url || node.detailsUrl : node.targetUrl) || null,
        app: (check && node.checkSuite?.app?.slug) || null,
      },
    ];
  });
  return ciFromRows(
    rows,
    rollup?.contexts?.totalCount ?? rows.length,
    commitUrl,
  );
}

const GITHUB_REVIEW_FIELDS = `latestOpinionatedReviews(first: 100) {
  nodes { state submittedAt author { __typename login } }
}`;

interface GithubGraphqlReviews {
  latestOpinionatedReviews?: {
    nodes?: Array<{
      state?: string;
      submittedAt?: string | null;
      author?: { __typename?: string; login?: string } | null;
    } | null>;
  };
}

function reviewFromGithubGraphql(
  pull: GithubGraphqlReviews,
): WorktreePullRequestReview {
  const bots = new Set<string>();
  const reviews = (pull.latestOpinionatedReviews?.nodes ?? []).flatMap(
    (review) => {
      if (!review) return [];
      const login = review.author?.login;
      if (login && review.author?.__typename === "Bot") bots.add(login);
      return [
        {
          state: review.state ?? "",
          ...(login ? { user: { login } } : {}),
          ...(review.submittedAt ? { submitted_at: review.submittedAt } : {}),
        },
      ];
    },
  );
  return reviewFromProviderReviews(reviews, (review) =>
    githubReviewApp(review.user?.login, bots.has(review.user?.login ?? "")),
  );
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
  assignees?: { nodes?: Array<{ login?: string } | null> };
  reviewRequests?: {
    totalCount?: number;
    nodes?: Array<{
      requestedReviewer?: {
        __typename?: string;
        login?: string;
        slug?: string;
        combinedSlug?: string;
      } | null;
    } | null>;
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
        assignees(first: 20) { nodes { login } }
        reviewRequests(first: 100) { totalCount nodes { requestedReviewer { __typename ... on User { login } ... on Team { slug combinedSlug } } } }
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
/**
 * Bumped by `forgetAllOpenPullAnnotations`: a repository's read in flight may
 * have no generation entry yet, so only a global one can retract it.
 */
let openPullAnnotationEpoch = 0;

function openPullAnnotationGeneration(key: string): string {
  return `${openPullAnnotationEpoch}:${openPullAnnotationGenerations.get(key) ?? 0}`;
}

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

/** Drop every repository's annotations, for a user-requested refresh. */
export function forgetAllOpenPullAnnotations(): void {
  openPullAnnotationEpoch += 1;
  openPullAnnotations.clear();
}

/** Drop every cached annotation; the seam a test resets between cases. */
export function resetGithubOpenPullAnnotationsForTests(): void {
  openPullAnnotations.clear();
  openPullAnnotationGenerations.clear();
  viewerTeamsCache.clear();
}

/** Pages of the REST reviewer list read before giving up as unknown. */
const REVIEW_REQUEST_PAGE_CAP = 10;

/** Pages of a pull request's REST review history read before giving up as unknown. */
const REVIEW_PAGE_CAP = 10;

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

/**
 * The authenticated user's teams as lowercased `org/slug`, for telling a TEAM
 * review request that is yours from one that is not. REST `/user/teams` works
 * with the `repo` scope, unlike reading a team's organization in GraphQL, and
 * it changes rarely: cached per token. `null` = could not be read, which makes
 * every team request UNKNOWN rather than "not yours".
 */
const VIEWER_TEAMS_MS = 15 * 60_000;
const viewerTeamsCache = new Map<
  string,
  { at: number; teams: Promise<Set<string> | null> }
>();

function githubViewerTeams(
  config: GithubApiConfig,
  signal: AbortSignal,
): Promise<Set<string> | null> {
  const cached = viewerTeamsCache.get(config.token);
  if (cached && Date.now() - cached.at < VIEWER_TEAMS_MS) return cached.teams;
  const teams = githubRequest<
    Array<{ slug?: string; organization?: { login?: string } }>
  >(config, "GET", "/user/teams", { query: { per_page: 100 }, signal }).then(
    (res) =>
      Array.isArray(res.data)
        ? new Set(
            res.data
              .filter((team) => team.slug && team.organization?.login)
              .map((team) =>
                `${team.organization!.login}/${team.slug}`.toLowerCase(),
              ),
          )
        : null,
    () => {
      // Do not pin a failure for the whole window.
      viewerTeamsCache.delete(config.token);
      return null;
    },
  );
  viewerTeamsCache.set(config.token, { at: Date.now(), teams });
  return teams;
}

async function githubOpenPullRequests(
  config: GithubApiConfig,
  ref: RemoteRepoRef,
  repoWebUrl: string,
  signal: AbortSignal,
): Promise<HostedPullRequest[]> {
  const key = githubRepoKey(ref);
  const generation = openPullAnnotationGeneration(key);
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
  if (openPullAnnotationGeneration(key) === generation)
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
  const myTeams = await githubViewerTeams(config, signal);
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
    ...(login &&
    (pull.assignees?.nodes ?? []).some((node) => node?.login === login)
      ? { assignedToMe: true }
      : {}),
    // Unknown membership leaves the field out: absent is unknown, not none.
    ...(myTeams
      ? {
          teamReviewRequests: (pull.reviewRequests?.nodes ?? [])
            .map((node) => node?.requestedReviewer)
            .filter(
              (reviewer) =>
                reviewer?.__typename === "Team" &&
                reviewer.slug &&
                reviewer.combinedSlug &&
                myTeams.has(reviewer.combinedSlug.toLowerCase()),
            )
            .map((reviewer) => reviewer!.slug!),
        }
      : {}),
    ...(pull.isDraft === true ? { draft: true } : {}),
    ...updatedAtFragment(pull.updatedAt),
  }));
}

/**
 * A pull request's current description, `""` when it has none, for an edit
 * card to show what it replaces. Bounded like every provider read; a THROW
 * means it could not be read, an abort included.
 */
export async function githubPullRequestDescription(
  ref: Pick<RemoteRepoRef, "owner" | "repo">,
  config: GithubApiConfig,
  prNumber: number,
  parentSignal?: AbortSignal,
): Promise<string> {
  const res = await githubRequest<{ body?: string | null }>(
    config,
    "GET",
    `/repos/${encodeURIComponent(ref.owner)}/${encodeURIComponent(ref.repo)}/pulls/${prNumber}`,
    { signal: requestSignal(parentSignal) },
  );
  return res.data?.body ?? "";
}

/** The Forgejo twin of {@link githubPullRequestDescription}. */
export async function forgejoPullRequestDescription(
  ref: Pick<RemoteRepoRef, "owner" | "repo">,
  config: ForgejoApiConfig,
  prNumber: number,
  parentSignal?: AbortSignal,
): Promise<string> {
  const res = await forgejoRequest<{ body?: string | null }>(
    config,
    "GET",
    `/repos/${encodeURIComponent(ref.owner)}/${encodeURIComponent(ref.repo)}/pulls/${prNumber}`,
    { signal: requestSignal(parentSignal) },
  );
  return res.data?.body ?? "";
}

const ZERO_OID = "0".repeat(40);

/**
 * Delete `branch` only if it still points at `expectedSha`. REST
 * `DELETE /git/refs` takes no expected value, so a push landing between a read
 * and that call would delete the NEW tip; GraphQL `updateRefs` checks
 * `beforeOid` atomically on GitHub's side and rejects a moved ref.
 */
export async function githubDeleteBranchAt(
  config: GithubApiConfig,
  repositoryId: string,
  branch: string,
  expectedSha: string,
  signal?: AbortSignal,
): Promise<void> {
  await githubGraphql(
    config,
    `mutation($input: UpdateRefsInput!) { updateRefs(input: $input) { clientMutationId } }`,
    {
      input: {
        repositoryId,
        refUpdates: [
          {
            name: `refs/heads/${branch}`,
            beforeOid: expectedSha,
            afterOid: ZERO_OID,
            force: true,
          },
        ],
      },
    },
    signal,
  );
}

function githubProvider(
  ref: RemoteRepoRef,
  config: GithubApiConfig,
  parentSignal?: AbortSignal,
): GitHostingProvider {
  const repoApi = `/repos/${encodeURIComponent(ref.owner)}/${encodeURIComponent(ref.repo)}`;
  const repoWebUrl = `${GITHUB_WEB_BASE}/${ref.owner}/${ref.repo}`;
  const signal = () => requestSignal(parentSignal);
  /** Open pull requests based on `branch`, which keep it from being deleted. */
  const openPullsTargeting = async (branch: string): Promise<number[]> =>
    requirePullRequestList<GithubPull>(
      requireData(
        await githubRequest<GithubPull[]>(config, "GET", `${repoApi}/pulls`, {
          // Any one is enough to keep the branch; the page only bounds how
          // many the outcome sentence names.
          query: { state: "open", base: branch, per_page: 10 },
          signal: signal(),
        }),
        "open pull requests",
      ),
      "open pull requests",
    ).map((pull) => pull.number);
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
            ...(input.draft !== undefined ? { draft: input.draft } : {}),
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
    async retargetPullRequest(prNumber, base) {
      await githubRequest(config, "PATCH", `${repoApi}/pulls/${prNumber}`, {
        body: { base },
        signal: signal(),
      });
    },
    async pullRequestBody(prNumber) {
      const res = await githubRequest<{ body?: string | null }>(
        config,
        "GET",
        `${repoApi}/pulls/${prNumber}`,
        { signal: signal() },
      );
      return res.data?.body ?? "";
    },
    async editPullRequestBody(prNumber, body) {
      const res = await githubRequest<{ html_url?: string }>(
        config,
        "PATCH",
        `${repoApi}/pulls/${prNumber}`,
        {
          body: { body },
          signal: signal(),
        },
      );
      return {
        ...(res.data?.html_url !== undefined ? { url: res.data.html_url } : {}),
      };
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
        ...githubStackFrom(pull.stack),
      };
    },
    async stackMembers(stackNumber) {
      // Members are listed bottom to top and STAY listed once merged; they
      // carry no base, and `position`/`size` never change as the stack
      // merges down — so their order and state are the whole answer.
      const res = await githubRequest<{ pull_requests?: unknown }>(
        config,
        "GET",
        `${repoApi}/stacks/${stackNumber}`,
        { signal: signal() },
      );
      const pulls = requirePullRequestList<GithubPull>(
        requireData(res, "stack members")?.pull_requests,
        `the members of stack ${stackNumber}`,
      );
      return {
        number: stackNumber,
        members: pulls.map((pull) => {
          if (
            typeof pull?.number !== "number" ||
            typeof pull.state !== "string"
          )
            throw new Error(
              `GitHub listed a member of stack ${stackNumber} without its number or state.`,
            );
          return {
            number: pull.number,
            state: toGithubPullRequestInfo(pull).state,
          };
        }),
      };
    },
    async mergeRequestStatus(prNumber, requestId) {
      const res = await githubRequest<GithubMergeRequest>(
        config,
        "GET",
        `${repoApi}/pulls/${prNumber}/merge-async/${encodeURIComponent(requestId)}`,
        { acceptStatuses: [404], signal: signal() },
      );
      if (res.status === 404) return { status: "expired" };
      const status = res.data?.status;
      if (status === "merged") return { status: "merged" };
      if (status === "failed")
        return {
          status: "failed",
          message:
            res.data?.details?.message ||
            res.data?.message ||
            "the merge request failed",
        };
      // `pending`, `enqueued`, or anything not yet settled.
      return { status: "pending" };
    },
    async mergePullRequest(prNumber, options) {
      // A caller that proved the head and, when deleting, its branch is merged
      // with NO read in between — that read is a round trip its identity check
      // could not cover. Everyone else gets one read here, which binds the
      // decided base and supplies the head the merge is conditioned on.
      const { headBranch, expectedHeadSha } = await resolveMergePreconditions(
        prNumber,
        options,
        async () => {
          const pull =
            (
              await githubRequest<GithubPull>(
                config,
                "GET",
                `${repoApi}/pulls/${prNumber}`,
                { signal: signal() },
              )
            ).data ?? null;
          requireBoundStack(prNumber, pull?.stack, options.expectedStack);
          return pull;
        },
      );
      const mergeApi = `${repoApi}/pulls/${prNumber}/merge-async`;
      const wait = githubMergeWait;
      const deadline = wait.now() + wait.budgetMs;
      const remaining = () => deadline - wait.now();
      // Every request inside the wait is cut to what is left of it.
      const waitSignal = () =>
        requestSignal(
          parentSignal,
          Math.max(1, Math.min(REQUEST_TIMEOUT_MS, remaining())),
        );
      // `direct_merge` keeps the meaning "merge now": the default action
      // ENQUEUES on a base with a merge queue. `bypass_rules` is never sent —
      // the provider's rules are the authority on whether this may merge.
      const accepted = await githubRequest<GithubMergeRequest>(
        config,
        "PUT",
        mergeApi,
        {
          body: {
            merge_method: options.method,
            sha: expectedHeadSha,
            merge_action: "direct_merge",
          },
          // Every refusal's body is read for GitHub's own words, and a 409
          // names the request already running for this pull request.
          acceptStatuses: GITHUB_MERGE_REFUSAL_STATUSES,
          signal: waitSignal(),
        },
      );
      const ask: GithubMergeAsk = {
        sha: expectedHeadSha,
        method: options.method,
      };
      let state = githubMergeStateFrom(
        prNumber,
        accepted.status,
        accepted.data,
        ask,
      );
      for (let attempt = 0; state.kind === "poll"; attempt += 1) {
        const requestId = state.requestId;
        if (remaining() <= 0) break;
        const delay =
          wait.delaysMs[Math.min(attempt, wait.delaysMs.length - 1)] ?? 0;
        if (!(await wait.pause(Math.min(delay, remaining()), parentSignal))) {
          state = {
            kind: "pending",
            requestId,
            reason: "waiting for GitHub's answer was cancelled",
          };
          break;
        }
        if (remaining() <= 0) break;
        let polled: GithubResponse<GithubMergeRequest>;
        try {
          polled = await githubRequest<GithubMergeRequest>(
            config,
            "GET",
            `${mergeApi}/${encodeURIComponent(requestId)}`,
            { signal: waitSignal() },
          );
        } catch (err) {
          // A read the deadline cut short is the wait ending, not a failure.
          if (remaining() <= 0) break;
          state = {
            kind: "pending",
            requestId,
            reason: `its status could not be read (${errorText(err)})`,
          };
          break;
        }
        // Outside the read's `try`: a request that FAILED is a refusal, not
        // an unreadable answer.
        state = githubMergeStateFrom(
          prNumber,
          polled.status,
          polled.data,
          ask,
          requestId,
        );
      }
      if (state.kind !== "merged")
        return {
          outcome: "pending",
          number: prNumber,
          method: options.method,
          ...(state.requestId ? { requestId: state.requestId } : {}),
          pendingReason:
            state.kind === "poll"
              ? "GitHub had not finished merging it when this stopped waiting"
              : state.reason,
        };
      const deletion: BranchDeletionOutcome =
        options.deleteBranch && headBranch
          ? await deleteFinishedHeadBranch(
              headBranch,
              openPullsTargeting,
              async () => {
                try {
                  await githubRequest(
                    config,
                    "DELETE",
                    `${repoApi}/git/refs/heads/${headBranch.split("/").map(encodeURIComponent).join("/")}`,
                    { signal: signal() },
                  );
                  return { branchDeleted: true };
                } catch (err) {
                  return {
                    branchDeleted: false,
                    branchDeleteError:
                      err instanceof Error ? err.message : String(err),
                  };
                }
              },
            )
          : { branchDeleted: false };
      return {
        outcome: "merged",
        number: prNumber,
        method: options.method,
        ...deletion,
      };
    },
    async closePullRequest(prNumber, options) {
      // GitHub's PR update has no head precondition, so the exact head is
      // proven by the read immediately before the write.
      let repositoryId: string | undefined;
      return closePullRequestWith<GithubPull>(prNumber, options, ref, {
        async read() {
          const pull =
            (
              await githubRequest<GithubPull>(
                config,
                "GET",
                `${repoApi}/pulls/${prNumber}`,
                { signal: signal() },
              )
            ).data ?? null;
          repositoryId ??= pull?.head?.repo?.node_id;
          return pull;
        },
        async postComment(body) {
          const res = await githubRequest<{ html_url?: string }>(
            config,
            "POST",
            `${repoApi}/issues/${prNumber}/comments`,
            { body: { body }, signal: signal() },
          );
          return res.data?.html_url ? { url: res.data.html_url } : {};
        },
        async close() {
          await githubRequest(config, "PATCH", `${repoApi}/pulls/${prNumber}`, {
            body: { state: "closed" },
            signal: signal(),
          });
        },
        state: (after) => ({
          state: after?.state ?? "",
          merged: after?.merged === true || Boolean(after?.merged_at),
          headSha: after?.head?.sha ?? "",
        }),
        openPullsTargeting,
        async removeBranch(branch, headSha) {
          if (!repositoryId)
            return {
              branchDeleted: false,
              branchDeleteError:
                "GitHub reported no repository id for the head branch, so none was deleted.",
            };
          try {
            await githubDeleteBranchAt(
              config,
              repositoryId,
              branch,
              headSha,
              signal(),
            );
            return { branchDeleted: true };
          } catch (err) {
            return { branchDeleted: false, branchDeleteError: errorText(err) };
          }
        },
      });
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
      if (!summary) return null;
      return ciFromRows(
        [
          ...summary.checkRuns.map((run) => ({
            failed: isFailedGitCheckStatus(run.conclusion),
            terminal: isTerminalGitCheckStatus(run.status),
            url: run.url,
            app: run.appSlug,
          })),
          ...summary.statuses.map((status) => ({
            failed: isFailedGitCheckStatus(status.state),
            terminal: isTerminalGitCheckStatus(status.state),
            url: status.url,
            app: null,
          })),
        ],
        summary.total,
        `${repoWebUrl}/commit/${refOid}`,
      );
    },
    pullRequestConversation(prNumber, options) {
      return githubPullRequestConversation(
        config,
        ref,
        prNumber,
        signal(),
        options?.threadsOnly,
      );
    },
    async refChecks(refOid) {
      const summary = await githubRefChecks(
        config,
        ref.owner,
        ref.repo,
        refOid,
        signal(),
      );
      return githubRefChecksVerdict(summary, config, ref);
    },
    async pullRequestReview(prNumber) {
      // Every page: GitHub lists reviews oldest first, so a first page alone
      // can hold an app's old objection and miss the approval that withdrew
      // it — and that objection is what clears the app's failing check from
      // CI. A history past the cap is unknown, not the part that was read.
      const reviews: ProviderReview[] = [];
      for (let page = 1; ; page += 1) {
        if (page > REVIEW_PAGE_CAP) return null;
        const res = await githubRequest<ProviderReview[]>(
          config,
          "GET",
          `${repoApi}/pulls/${prNumber}/reviews`,
          {
            query: { per_page: 100, page },
            signal: signal(),
          },
        );
        const batch = requireData(res, "pull request reviews");
        if (!Array.isArray(batch)) return null;
        reviews.push(...batch);
        if (!res.nextUrl || batch.length === 0) break;
      }
      // No `unresolvedThreads`: thread resolution is GraphQL-only on GitHub.
      return reviewFromProviderReviews(reviews, (review) =>
        githubReviewApp(review.user?.login, false),
      );
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
  provider.retargetPullRequest = forgetting(provider.retargetPullRequest);
  provider.editPullRequestBody = forgetting(provider.editPullRequestBody);
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
  requested_reviewers_teams?: Array<{ id?: number; name?: string }> | null;
  assignees?: Array<{ login?: string }> | null;
  draft?: boolean;
  updated_at?: string;
}

/** Forgejo twin of {@link githubViewerTeams}: the user's team ids. */
const forgejoTeamsCache = new Map<
  string,
  { at: number; teams: Promise<Set<number> | null> }
>();

function forgejoViewerTeams(
  config: ForgejoApiConfig,
  signal: AbortSignal,
): Promise<Set<number> | null> {
  const key = `${config.baseUrl}#${config.token ?? ""}`;
  const cached = forgejoTeamsCache.get(key);
  if (cached && Date.now() - cached.at < VIEWER_TEAMS_MS) return cached.teams;
  const teams = forgejoRequest<Array<{ id?: number }>>(
    config,
    "GET",
    "/user/teams",
    { query: { limit: 100 }, signal },
  ).then(
    (res) =>
      res && Array.isArray(res.data)
        ? new Set(
            res.data
              .map((team) => team.id)
              .filter((id): id is number => typeof id === "number"),
          )
        : null,
    () => {
      forgejoTeamsCache.delete(key);
      return null;
    },
  );
  forgejoTeamsCache.set(key, { at: Date.now(), teams });
  return teams;
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

/** Branch names keep their `/` separators as path segments. */
function encodeBranch(branch: string): string {
  return branch.split("/").map(encodeURIComponent).join("/");
}

/**
 * Did the head branch of a just-merged or just-closed Forgejo pull request
 * really go away?
 * `deleted` is claimed ONLY for a 404 on the branch; every other answer,
 * including one we could not obtain, reports why it is unconfirmed.
 */
async function confirmForgejoBranchDeleted(
  config: ForgejoApiConfig,
  repoApi: string,
  signal: () => AbortSignal,
  headRef: string,
): Promise<{ deleted: boolean; reason?: string }> {
  try {
    await forgejoRequest(
      config,
      "GET",
      `${repoApi}/branches/${encodeBranch(headRef)}`,
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

function forgejoProvider(
  ref: RemoteRepoRef,
  config: ForgejoApiConfig,
  parentSignal?: AbortSignal,
): GitHostingProvider {
  const repoApi = `/repos/${encodeURIComponent(ref.owner)}/${encodeURIComponent(ref.repo)}`;
  const repoWebUrl = `${normalizeForgejoBaseUrl(config.baseUrl)}/${ref.owner}/${ref.repo}`;
  const signal = () => requestSignal(parentSignal);
  /** Open pull requests based on `branch`, which keep it from being deleted. */
  const openPullsTargeting = async (branch: string): Promise<number[]> => {
    // Forgejo cannot filter by base, so the open set is paged and filtered
    // here; one that cannot be exhausted proves nothing.
    const dependents: number[] = [];
    for (let page = 1; page <= OPEN_PULL_REQUEST_PAGE_CAP; page += 1) {
      const res = await forgejoRequest<ForgejoPull[]>(
        config,
        "GET",
        `${repoApi}/pulls`,
        {
          query: { state: "open", limit: MAX_PULL_REQUESTS, page },
          signal: signal(),
        },
      );
      const pulls = requirePullRequestList<ForgejoPull>(
        requireData(res, "open pull requests"),
        "open pull requests",
      );
      for (const pull of pulls)
        if (pull.base?.ref === branch) dependents.push(pull.number);
      if (pulls.length < MAX_PULL_REQUESTS) return dependents;
    }
    throw new Error(
      `Forgejo still reported open pull requests after ${OPEN_PULL_REQUEST_PAGE_CAP} pages`,
    );
  };
  /** Delete one branch and confirm it is gone. */
  const removeBranch = async (
    branch: string,
  ): Promise<BranchDeletionOutcome> => {
    try {
      await forgejoRequest(
        config,
        "DELETE",
        `${repoApi}/branches/${encodeBranch(branch)}`,
        { signal: signal() },
      );
    } catch (err) {
      // A refusal (a protected branch) leaves it in place, which the
      // confirmation below reports in its own words.
      if (!(err instanceof ForgejoHttpError))
        return {
          branchDeleted: false,
          branchDeleteError: `the branch deletion failed (${errorText(err)}).`,
        };
    }
    // Exactly ONE outcome means "deleted": a 404 on the branch. Everything
    // else — the branch still there, an unauthorized/500/timeout answer — is
    // reported as NOT confirmed, because a check that could not be completed
    // must not invent the answer it was for. The merge or close itself already
    // landed either way.
    const confirmed = await confirmForgejoBranchDeleted(
      config,
      repoApi,
      signal,
      branch,
    );
    return {
      branchDeleted: confirmed.deleted,
      ...(confirmed.reason ? { branchDeleteError: confirmed.reason } : {}),
    };
  };
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
    async retargetPullRequest(prNumber, base) {
      if (!config.token)
        throw new Error(
          "A Forgejo access token is not configured. Add one in Settings → Forgejo.",
        );
      await forgejoRequest(config, "PATCH", `${repoApi}/pulls/${prNumber}`, {
        body: { base },
        signal: signal(),
      });
    },
    async pullRequestBody(prNumber) {
      const res = await forgejoRequest<{ body?: string | null }>(
        config,
        "GET",
        `${repoApi}/pulls/${prNumber}`,
        { signal: signal() },
      );
      return res.data?.body ?? "";
    },
    async editPullRequestBody(prNumber, body) {
      if (!config.token)
        throw new Error(
          "A Forgejo access token is not configured. Add one in Settings → Forgejo.",
        );
      const res = await forgejoRequest<{ html_url?: string }>(
        config,
        "PATCH",
        `${repoApi}/pulls/${prNumber}`,
        {
          body: { body },
          signal: signal(),
        },
      );
      return {
        ...(res.data?.html_url !== undefined ? { url: res.data.html_url } : {}),
      };
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
      // Forgejo could delete the head branch in this same request
      // (`delete_branch_after_merge`), but only blindly: whether another open
      // pull request still targets that branch can be asked only AFTER the
      // merge, since a read between the identity check and the merge is the
      // window the preconditions above exist to close. So the merge keeps the
      // branch and the deletion follows it, guarded.
      await forgejoRequest(
        config,
        "POST",
        `${repoApi}/pulls/${prNumber}/merge`,
        {
          body: {
            Do: options.method,
            delete_branch_after_merge: false,
            head_commit_id: expectedHeadSha,
          },
          signal: signal(),
        },
      );
      if (options.deleteBranch !== true)
        return {
          outcome: "merged",
          number: prNumber,
          method: options.method,
          branchDeleted: false,
        };
      if (!headBranch)
        return {
          outcome: "merged",
          number: prNumber,
          method: options.method,
          branchDeleted: false,
          branchDeleteError:
            "the pull request reported no head branch, so none was deleted.",
        };
      const deletion = await deleteFinishedHeadBranch(
        headBranch,
        openPullsTargeting,
        () => removeBranch(headBranch),
      );
      return {
        outcome: "merged",
        number: prNumber,
        method: options.method,
        ...deletion,
      };
    },
    async closePullRequest(prNumber, options) {
      if (!config.token)
        throw new Error(
          "A Forgejo access token is not configured. Add one in Settings → Forgejo.",
        );
      return closePullRequestWith<ForgejoPull>(prNumber, options, ref, {
        async read() {
          return (
            (
              await forgejoRequest<ForgejoPull>(
                config,
                "GET",
                `${repoApi}/pulls/${prNumber}`,
                { signal: signal() },
              )
            ).data ?? null
          );
        },
        async postComment(body) {
          // A pull request's conversation is its issue's comments.
          const res = await forgejoRequest<{ html_url?: string }>(
            config,
            "POST",
            `${repoApi}/issues/${prNumber}/comments`,
            { body: { body }, signal: signal() },
          );
          return res.data?.html_url ? { url: res.data.html_url } : {};
        },
        async close() {
          // Forgejo closes a pull request through the same state transition as
          // an issue, on the pulls endpoint's edit option.
          await forgejoRequest(
            config,
            "PATCH",
            `${repoApi}/pulls/${prNumber}`,
            { body: { state: "closed" }, signal: signal() },
          );
        },
        state: (after) => ({
          state: after?.state ?? "",
          merged: after?.merged === true,
          headSha: after?.head?.sha ?? "",
        }),
        openPullsTargeting,
        async removeBranch(branch, headSha) {
          // Forgejo's branch delete takes no expected commit, so the tip is
          // read first: a branch someone pushed to since the close is kept.
          // A push between this read and the delete is the remaining window.
          let tip: string | undefined;
          try {
            tip = (
              await forgejoRequest<{ commit?: { id?: string } }>(
                config,
                "GET",
                `${repoApi}/branches/${encodeBranch(branch)}`,
                { signal: signal() },
              )
            ).data?.commit?.id;
          } catch (err) {
            return {
              branchDeleted: false,
              branchDeleteError: `the branch tip could not be read (${errorText(err)}).`,
            };
          }
          if (tip?.toLowerCase() !== headSha.toLowerCase())
            return {
              branchDeleted: false,
              branchKeptReason: `it moved to ${tip || "an unreported commit"} after the closed head ${headSha}`,
            };
          return removeBranch(branch);
        },
      });
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
    pullRequestConversation(prNumber) {
      return forgejoPullRequestConversation(config, repoApi, prNumber, signal);
    },
    async refChecks(refOid) {
      const summary = await forgejoRefChecks(
        config,
        ref.owner,
        ref.repo,
        refOid,
        signal(),
      );
      return forgejoRefChecksVerdict(summary);
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
      const myTeams = await forgejoViewerTeams(config, signal());
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
        ...(login && (pull.assignees ?? []).some((a) => a?.login === login)
          ? { assignedToMe: true }
          : {}),
        ...(myTeams
          ? {
              teamReviewRequests: (pull.requested_reviewers_teams ?? [])
                .filter(
                  (team) =>
                    typeof team?.id === "number" &&
                    myTeams.has(team.id) &&
                    team.name,
                )
                .map((team) => team.name!),
            }
          : {}),
        ...(pull.draft === true || /^(?:WIP:|\[WIP\])/i.test(pull.title)
          ? { draft: true }
          : {}),
        ...updatedAtFragment(pull.updated_at),
      }));
    },
  };
}
