import {
  isFailedGitCheckStatus,
  isTerminalGitCheckStatus,
} from "../gitCheckStatus.ts";
import {
  repositoryCapabilitiesFor,
  type GitHostingCheck,
  type GitHostingProvider,
  type GitHostingRefChecks,
} from "../gitHosting.ts";
import type {
  PullRequestDetail,
  WorktreePullRequestReview,
} from "@assistant/shared";
import {
  defineAgentTool,
  jsonResult,
  type AgentTool,
  type ToolCallContext,
} from "../mcp/tool.ts";

type PullRequestCheckWatchParams = {
  repo: string;
  number: number;
  wait?: boolean;
  timeoutSeconds?: number;
  pollIntervalSeconds?: number;
};

interface ResolvedWatchProvider {
  repo: string;
  provider: GitHostingProvider;
  pullRequestUrl(number: number): string;
}

interface PullRequestCheckSnapshot {
  detail: NonNullable<
    Awaited<ReturnType<GitHostingProvider["pullRequestDetail"]>>
  >;
  checks: GitHostingRefChecks;
  checksFinished: boolean;
}

type StopReason =
  | "current_status"
  | "checks_finished"
  | "checks_truncated"
  | "no_checks"
  | "pull_request_not_open"
  | "rate_limited"
  | "timeout";

interface WatchOutcome {
  snapshot: PullRequestCheckSnapshot;
  stopReason: StopReason;
  polls: number;
  elapsedMs: number;
  /** Provider requests left after the last poll, when it reports a budget. */
  rateLimitRemaining?: number;
}

const DEFAULT_TIMEOUT_SECONDS = 30 * 60;
const MAX_TIMEOUT_SECONDS = 2 * 60 * 60;
/**
 * Each poll is three provider requests. GitHub's REST budget (5,000/hour) is
 * shared with every background loop and agent, so a GitHub wait polls slower;
 * Forgejo is local and keeps the quick cadence.
 */
const POLL_INTERVAL_SECONDS = {
  GitHub: { default: 60, min: 30 },
  Forgejo: { default: 15, min: 5 },
} as const;
const MAX_POLL_INTERVAL_SECONDS = 120;
/**
 * How long one head may show no checks at all before a wait gives up on it.
 * CI registers its checks within seconds of a push, so a head still bare after
 * this has no CI (or none that reports), and the full timeout would only burn
 * requests.
 */
const NO_CHECKS_GRACE_SECONDS = 120;
/**
 * A wait stops once the provider reports fewer requests than this left in its
 * window, leaving the rest of the shared budget to everything else.
 */
const MIN_RATE_LIMIT_REMAINING = 500;
const MAX_EXCERPT_CHARS = 2_000;

/**
 * Build one provider-specific deferred tool over the shared git-hosting seam.
 * The seam keeps GitHub and Forgejo semantics aligned while each catalog group
 * still retains its own integration gate.
 */
export function createPullRequestCheckWatchTool(options: {
  name: string;
  label: string;
  providerName: "GitHub" | "Forgejo";
  repoDescription: string;
  resolve(
    repo: string,
    signal: AbortSignal | undefined,
  ): ResolvedWatchProvider | Promise<ResolvedWatchProvider>;
}): AgentTool {
  const poll = POLL_INTERVAL_SECONDS[options.providerName];
  return defineAgentTool<PullRequestCheckWatchParams>({
    name: options.name,
    label: options.label,
    description: `Report the current checks for one ${options.providerName} pull request, or wait until every observed check is terminal and then report. Returns exact-head check details, failure/log links and agent log-reader arguments when the provider exposes them, hosted-review state, the repository's reported default branch and supported merge methods, and a conservative canMergeNow preflight. Read-only. wait defaults to false; waiting polls every ${poll.default} seconds for up to 30 minutes by default and supports up to 2 hours.${options.providerName === "GitHub" ? ` A wait also stops early with rate_limited when fewer than ${MIN_RATE_LIMIT_REMAINING} REST requests remain.` : ""}`,
    searchHint: `${options.providerName} pull request PR CI checks status wait watch pending complete failure logs mergeable merge readiness`,
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["repo", "number"],
      properties: {
        repo: { type: "string", description: options.repoDescription },
        number: {
          type: "number",
          description: "Pull-request number/index.",
        },
        wait: {
          type: "boolean",
          description: `Wait for at least one check to appear and then until all observed checks finish. Defaults to false, which returns one current snapshot immediately. A closed or merged PR also stops the wait, and a head still without any check after ${NO_CHECKS_GRACE_SECONDS} seconds stops it with no_checks (state none).`,
        },
        timeoutSeconds: {
          type: "number",
          description:
            "Maximum wait time when wait is true. Defaults to 1800 seconds (30 minutes), minimum 30, maximum 7200 (2 hours). Timeout returns the latest snapshot rather than throwing.",
        },
        pollIntervalSeconds: {
          type: "number",
          description: `Polling interval while waiting. Defaults to ${poll.default} seconds, minimum ${poll.min}, maximum ${MAX_POLL_INTERVAL_SECONDS}.`,
        },
      },
    },
    async execute(params, ctx) {
      const number = clamp(params.number, 1, 1, Number.MAX_SAFE_INTEGER);
      const timeoutSeconds = clamp(
        params.timeoutSeconds,
        DEFAULT_TIMEOUT_SECONDS,
        30,
        MAX_TIMEOUT_SECONDS,
      );
      const pollIntervalSeconds = clamp(
        params.pollIntervalSeconds,
        poll.default,
        poll.min,
        MAX_POLL_INTERVAL_SECONDS,
      );
      const resolved = await options.resolve(params.repo, ctx.signal);
      const outcome = await observePullRequestChecks({
        provider: resolved.provider,
        number,
        wait: params.wait === true,
        timeoutMs: timeoutSeconds * 1_000,
        pollIntervalMs: pollIntervalSeconds * 1_000,
        ctx,
        repo: resolved.repo,
        providerName: options.providerName,
      });
      const { detail, checks } = outcome.snapshot;
      const review =
        detail.state === "open"
          ? await resolved.provider.pullRequestReview(number)
          : null;
      // The SHARED verdict, identical to the one the managed finish tool
      // re-derives before merging.
      const { checksFinished, canMergeNow, mergeBlockers } =
        evaluatePullRequestReadiness(detail, checks, review);
      const compactChecks = checks.checks.map((check) =>
        compactCheck(check, resolved.repo),
      );
      const failedChecks = compactChecks.filter((check) =>
        isFailedGitCheckStatus(check.status),
      );
      // Capabilities travel with the readiness answer so an agent can pick a
      // method the repository actually supports before it calls the finish
      // tool, which revalidates them anyway.
      const capabilities = await repositoryCapabilitiesFor(resolved.provider);
      const payload = {
        provider: resolved.provider.kind,
        repo: resolved.repo,
        pullRequest: {
          number,
          url: resolved.pullRequestUrl(number),
          state: detail.state,
          draft: detail.draft,
          mergeable: detail.mergeable,
          head: { ref: detail.headBranch, sha: detail.headSha },
          base: { ref: detail.baseBranch },
        },
        checks: {
          headSha: detail.headSha,
          state: checks.state,
          finished: checksFinished,
          ...(checks.total !== undefined ? { total: checks.total } : {}),
          returned: compactChecks.length,
          truncated: checks.truncated === true,
          checks: compactChecks,
          failedChecks,
          failureLinks: uniqueStrings(
            failedChecks.flatMap((check) =>
              [check.logUrl, check.url].filter(
                (value): value is string => typeof value === "string",
              ),
            ),
          ),
        },
        review: detail.state === "open" ? review : null,
        repository: {
          ...capabilities,
          // Absent facts are UNKNOWN, never permission: a merge tool refuses
          // rather than guessing a default branch or a method set.
          capabilitiesKnown:
            capabilities.defaultBranch !== undefined &&
            capabilities.mergeMethods !== undefined,
        },
        canMergeNow,
        mergeBlockers,
        mergeabilityNote:
          "Conservative preflight from open/draft state, provider mergeability, observed checks, and hosted changes-requested reviews. The provider remains authoritative for permissions and branch rules when merge is attempted.",
        observation: {
          mode: params.wait === true ? "wait" : "current",
          stopReason: outcome.stopReason,
          polls: outcome.polls,
          elapsedSeconds: Math.round(outcome.elapsedMs / 100) / 10,
          timeoutSeconds,
          pollIntervalSeconds,
          ...(outcome.rateLimitRemaining !== undefined
            ? { rateLimitRemaining: outcome.rateLimitRemaining }
            : {}),
        },
      };
      return jsonResult(payload);
    },
  });
}

async function observePullRequestChecks(input: {
  provider: GitHostingProvider;
  number: number;
  wait: boolean;
  timeoutMs: number;
  pollIntervalMs: number;
  ctx: ToolCallContext;
  repo: string;
  providerName: string;
}): Promise<WatchOutcome> {
  const startedAt = Date.now();
  let polls = 0;
  // When the CURRENT head was first seen without checks; a push restarts it.
  // (Cast, not annotation: TS would narrow the loop's reads to `null`.)
  let bare = null as { headSha: string; since: number } | null;
  while (true) {
    throwIfAborted(input.ctx.signal);
    const polledAt = Date.now();
    const detail = await input.provider.pullRequestDetail(input.number);
    if (!detail)
      throw new Error(
        `${input.providerName} returned no pull request #${input.number}.`,
      );
    if (!detail.headSha)
      throw new Error(
        `${input.providerName} pull request #${input.number} has no head commit SHA.`,
      );
    const checks = await input.provider.refChecks(detail.headSha);
    const checksFinished = checksAreFinished(checks);
    const snapshot = { detail, checks, checksFinished };
    polls += 1;
    const elapsedMs = Date.now() - startedAt;
    const rateLimitRemaining = input.provider.rateLimit?.()?.remaining;
    const stop = (stopReason: StopReason): WatchOutcome => ({
      snapshot,
      stopReason,
      polls,
      elapsedMs,
      ...(rateLimitRemaining !== undefined ? { rateLimitRemaining } : {}),
    });

    if (!input.wait) return stop("current_status");
    if (detail.state !== "open") return stop("pull_request_not_open");
    if (checks.truncated === true) return stop("checks_truncated");
    if (checksFinished) return stop("checks_finished");
    if (checks.state === "none") {
      if (bare?.headSha !== detail.headSha)
        bare = { headSha: detail.headSha, since: polledAt };
      if (Date.now() - bare.since >= NO_CHECKS_GRACE_SECONDS * 1_000)
        return stop("no_checks");
    } else bare = null;
    if (
      rateLimitRemaining !== undefined &&
      rateLimitRemaining < MIN_RATE_LIMIT_REMAINING
    )
      return stop("rate_limited");
    if (elapsedMs >= input.timeoutMs) return stop("timeout");

    input.ctx.progress?.(
      jsonResult({
        provider: input.provider.kind,
        repo: input.repo,
        pullRequestNumber: input.number,
        status: "waiting",
        polls,
        elapsedSeconds: Math.round(elapsedMs / 100) / 10,
        headSha: detail.headSha,
        checks: {
          state: checks.state,
          finished: false,
          total: checks.total ?? checks.checks.length,
        },
      }),
    );
    await abortableSleep(
      Math.min(input.pollIntervalMs, input.timeoutMs - elapsedMs),
      input.ctx.signal,
    );
  }
}

function allChecksFinished(checks: GitHostingCheck[]): boolean {
  return checks.every((check) => isTerminalGitCheckStatus(check.status));
}

function compactCheck(
  check: GitHostingCheck,
  repo: string,
): {
  name: string;
  status: string;
  url?: string;
  logUrl?: string;
  jobId?: number;
  logReader?: {
    tool: "github_get_actions_job_log";
    arguments: { repo: string; jobId: number };
  };
  excerpt?: string;
  excerptTruncated?: boolean;
} {
  const excerpt = check.excerpt?.trim();
  return {
    name: check.name,
    status: check.status,
    ...(check.url ? { url: check.url } : {}),
    ...(check.logUrl ? { logUrl: check.logUrl } : {}),
    ...(check.logJobId !== undefined
      ? {
          jobId: check.logJobId,
          logReader: {
            tool: "github_get_actions_job_log" as const,
            arguments: { repo, jobId: check.logJobId },
          },
        }
      : {}),
    ...(excerpt ? { excerpt: excerpt.slice(0, MAX_EXCERPT_CHARS) } : {}),
    ...(excerpt && excerpt.length > MAX_EXCERPT_CHARS
      ? { excerptTruncated: true }
      : {}),
  };
}

/**
 * Read one pull request's CURRENT merge readiness: exact-head checks and the
 * hosted review, evaluated by {@link blockersFor}.
 *
 * This is the shared readiness path — the watch tools above report it, and
 * `worktree_finish_pull_request` re-runs it immediately before merging rather
 * than trusting a model's memory of a previous answer. One function, so the two
 * can never disagree about what "ready" means.
 */
export async function readPullRequestReadiness(
  provider: GitHostingProvider,
  number: number,
): Promise<PullRequestReadiness> {
  const detail = await provider.pullRequestDetail(number);
  if (!detail) throw new Error(`Pull request #${number} could not be read.`);
  if (!detail.headSha)
    throw new Error(`Pull request #${number} has no head commit SHA.`);
  const checks = await provider.refChecks(detail.headSha);
  const review =
    detail.state === "open" ? await provider.pullRequestReview(number) : null;
  return evaluatePullRequestReadiness(detail, checks, review);
}

/**
 * The readiness VERDICT over already-observed provider facts. Both the watch
 * tools (which poll checks themselves) and the fetching read above end here, so
 * "ready" has exactly one definition.
 */
export function evaluatePullRequestReadiness(
  detail: PullRequestDetail,
  checks: GitHostingRefChecks,
  review: WorktreePullRequestReview | null,
): PullRequestReadiness {
  const checksFinished = checksAreFinished(checks);
  const mergeBlockers = blockersFor(detail, checks, checksFinished, review);
  return {
    detail,
    checks,
    checksFinished,
    review,
    canMergeNow: mergeBlockers.length === 0,
    mergeBlockers,
  };
}

/** Every observed check is terminal, and the verdict covers all of them. */
export function checksAreFinished(checks: GitHostingRefChecks): boolean {
  return (
    checks.state !== "none" &&
    checks.truncated !== true &&
    allChecksFinished(checks.checks)
  );
}

/** Everything the shared readiness read observed, plus its verdict. */
export interface PullRequestReadiness {
  detail: PullRequestDetail;
  checks: GitHostingRefChecks;
  checksFinished: boolean;
  review: WorktreePullRequestReview | null;
  canMergeNow: boolean;
  mergeBlockers: string[];
}

function blockersFor(
  detail: PullRequestCheckSnapshot["detail"],
  checks: GitHostingRefChecks,
  checksFinished: boolean,
  review: Awaited<ReturnType<GitHostingProvider["pullRequestReview"]>>,
): string[] {
  const blockers: string[] = [];
  if (detail.state !== "open") blockers.push(`pull_request_${detail.state}`);
  if (detail.draft) blockers.push("draft");
  if (detail.mergeable === false) blockers.push("provider_not_mergeable");
  if (detail.mergeable === null) blockers.push("mergeability_unknown");
  if (checks.truncated) blockers.push("checks_truncated");
  else if (!checksFinished)
    blockers.push(
      checks.state === "none" ? "checks_not_found" : "checks_pending",
    );
  if (checks.state === "failure") blockers.push("checks_failed");
  if (checksFinished && checks.state === "pending")
    blockers.push("checks_inconclusive");
  if (detail.state === "open") {
    if (review === null) blockers.push("review_unknown");
    else if (review.changesRequested) blockers.push("changes_requested");
  }
  return uniqueStrings(blockers);
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)];
}

function clamp(
  value: number | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  throw signal.reason instanceof Error
    ? signal.reason
    : new Error("Pull-request check watch was cancelled.");
}

function abortableSleep(ms: number, signal: AbortSignal | undefined) {
  return new Promise<void>((resolve, reject) => {
    throwIfAborted(signal);
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      reject(
        signal?.reason instanceof Error
          ? signal.reason
          : new Error("Pull-request check watch was cancelled."),
      );
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
