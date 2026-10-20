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
import { defineAgentTool, jsonResult, type AgentTool } from "../mcp/tool.ts";

import { launchServerTask } from "../serverTasks.ts";

type PullRequestCheckWatchParams = {
  repo: string;
  number: number;
  wait?: boolean;
  background?: boolean;
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

/** What the caller asked for; `background` names the request, not the path. */
type ObservationMode = "current" | "wait" | "background";

export interface WatchOutcome<Snapshot> {
  snapshot: Snapshot;
  stopReason: StopReason;
  polls: number;
  elapsedMs: number;
  /** Provider requests left after the last poll, when it reports a budget. */
  rateLimitRemaining?: number;
}

/**
 * One observation of whatever a watch waits on, before the generic stop rules
 * judge it. The pull-request observation below is one; a ref observation can be
 * another without forking the loop.
 */
export interface CheckObservation<Snapshot> {
  snapshot: Snapshot;
  /** The commit whose checks were read; a new one restarts the no-checks grace. */
  headSha: string;
  checks: GitHostingRefChecks;
  /** A stop the observation itself decides, judged before the generic ones. */
  stopReason?: StopReason;
  rateLimitRemaining?: number;
}

/**
 * The state one watch carries from poll to poll. A background watch continues
 * the SAME state its foreground first observation started, so its clock runs
 * from before that first poll and never restarts at admission.
 */
interface CheckWatch {
  startedAt: number;
  polls: number;
  /** When the CURRENT head was first seen without checks; a push restarts it. */
  bare: { headSha: string; since: number } | null;
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
export const MIN_RATE_LIMIT_REMAINING = 500;
const MAX_EXCERPT_CHARS = 2_000;

export function checkWaitBounds(
  providerName: "GitHub" | "Forgejo",
  params: {
    wait?: boolean;
    background?: boolean;
    timeoutSeconds?: number;
    pollIntervalSeconds?: number;
  },
) {
  const poll = POLL_INTERVAL_SECONDS[providerName];
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
  const background = params.background === true;
  const wait = background || params.wait === true;
  const mode: ObservationMode = background
    ? "background"
    : wait
      ? "wait"
      : "current";
  return {
    background,
    wait,
    mode,
    timeoutSeconds,
    timeoutMs: timeoutSeconds * 1_000,
    pollIntervalSeconds,
    pollIntervalMs: pollIntervalSeconds * 1_000,
  };
}

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
    description: `Report the current checks for one ${options.providerName} pull request, or wait until every observed check is terminal and then report. Returns exact-head check details, failure/log links and agent log-reader arguments when the provider exposes them, hosted-review state, the repository's reported default branch and supported merge methods, and a conservative canMergeNow preflight. Read-only. wait defaults to false; waiting polls every ${poll.default} seconds for up to 30 minutes by default and supports up to 2 hours.${options.providerName === "GitHub" ? ` A wait also stops early with rate_limited when fewer than ${MIN_RATE_LIMIT_REMAINING} REST requests remain.` : ""} background runs the wait as a PA background task and returns at once.`,
    searchHint: `${options.providerName} pull request PR CI checks status wait watch pending complete failure logs mergeable merge readiness background`,
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
        background: {
          type: "boolean",
          description:
            "Wait as PA background work instead of blocking this turn; implies wait. Returns a taskId at once, or the result itself when the first observation already ends the wait. The final result, the same JSON a wait returns, arrives automatically when the wait ends and is kept as its output file; ending your turn does not stop it, background_tasks stop does. Bounded by the Settings background lifetime (default 60 minutes), which shortens a longer timeoutSeconds. Only an interactive top-level session may start one.",
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
      const {
        timeoutSeconds,
        pollIntervalSeconds,
        background,
        wait,
        mode,
        timeoutMs,
        pollIntervalMs,
      } = checkWaitBounds(options.providerName, params);
      const resolved = await options.resolve(params.repo, ctx.signal);
      const watch = startCheckWatch();
      const observe = observePullRequest(
        resolved.provider,
        number,
        options.providerName,
      );
      const report = async (
        outcome: WatchOutcome<PullRequestCheckSnapshot>,
        provider: ResolvedWatchProvider,
        effectiveTimeoutSeconds: number,
      ) =>
        pullRequestCheckPayload({
          resolved: provider,
          number,
          outcome,
          mode,
          timeoutSeconds: effectiveTimeoutSeconds,
          pollIntervalSeconds,
        });

      if (!background) {
        const outcome = await continueCheckWatch(watch, {
          observe,
          wait,
          timeoutMs,
          pollIntervalMs,
          signal: ctx.signal,
          sleepFirst: false,
          ...(ctx.progress
            ? {
                onWaiting: (step: CheckObservation<PullRequestCheckSnapshot>) =>
                  ctx.progress!(
                    jsonResult({
                      provider: resolved.provider.kind,
                      repo: resolved.repo,
                      pullRequestNumber: number,
                      status: "waiting",
                      polls: watch.polls,
                      elapsedSeconds: seconds(Date.now() - watch.startedAt),
                      headSha: step.headSha,
                      checks: {
                        state: step.checks.state,
                        finished: false,
                        total: step.checks.total ?? step.checks.checks.length,
                      },
                    }),
                  ),
              }
            : {}),
        });
        return jsonResult(await report(outcome, resolved, timeoutSeconds));
      }

      // The first observation runs in this call, so a wait that is already
      // over returns its answer inline and starts nothing.
      throwIfAborted(ctx.signal);
      const first = await pollCheckWatch(watch, {
        observe,
        wait: true,
        timeoutMs,
      });
      if (first.outcome)
        return jsonResult(
          await report(first.outcome, resolved, timeoutSeconds),
        );
      const target = `${resolved.repo}#${number}`;
      const started = await launchServerTask({
        ctx,
        kind: "check-watch",
        label: `${options.providerName} PR checks ${target}`,
        command: `${options.name} ${target}`,
        sourceTool: options.name,
        requestedTimeoutMs: timeoutMs,
        async run(budget) {
          // Its own provider, bound to the job's signal: the turn that started
          // this wait may end, or be stopped, long before the wait does.
          const jobProvider = await options.resolve(params.repo, budget.signal);
          const outcome = await continueCheckWatch(watch, {
            observe: observePullRequest(
              jobProvider.provider,
              number,
              options.providerName,
            ),
            wait: true,
            timeoutMs: budget.timeoutMs,
            pollIntervalMs,
            signal: budget.signal,
            sleepFirst: true,
          });
          const payload = await report(
            outcome,
            jobProvider,
            budget.timeoutMs / 1_000,
          );
          return {
            payload,
            summary: checkWaitSummary({
              ...outcome,
              checks: outcome.snapshot.checks,
              head: outcome.snapshot.detail.headSha.slice(0, 7),
              notOpen: `PR #${outcome.snapshot.detail.number} is ${outcome.snapshot.detail.state}`,
              providerName: options.providerName,
              timeoutMs: budget.timeoutMs,
            }),
          };
        },
      });
      return jsonResult(started);
    },
  });
}

/** One bounded line naming why the background wait ended and what it saw. */
export function checkWaitSummary(input: {
  stopReason: StopReason;
  checks: GitHostingRefChecks;
  head: string;
  providerName: string;
  timeoutMs: number;
  rateLimitRemaining?: number;
  notOpen?: string;
}): string {
  const { checks, head, providerName, timeoutMs } = input;
  switch (input.stopReason) {
    case "checks_finished": {
      const total = checks.total ?? checks.checks.length;
      const failed = checks.checks.filter((check) =>
        isFailedGitCheckStatus(check.status),
      ).length;
      return failed > 0
        ? `Checks finished: ${checks.state}, ${failed} of ${total} failed on ${head}`
        : `Checks finished: ${checks.state}, ${total} ${total === 1 ? "check" : "checks"} on ${head}`;
    }
    case "timeout":
      return `Timed out after ${seconds(timeoutMs)} s: ${checks.state} on ${head}`;
    case "pull_request_not_open":
      return input.notOpen!;
    case "rate_limited":
      return `Stopped early: ${providerName} rate limit (${input.rateLimitRemaining ?? 0} left)`;
    case "no_checks":
      return `No checks appeared on ${head} within ${NO_CHECKS_GRACE_SECONDS} s`;
    case "checks_truncated":
      return `Stopped: more checks on ${head} than one verdict covers`;
    case "current_status":
      return `Current checks: ${checks.state} on ${head}`;
  }
}

/**
 * The tool's JSON result, built ONE way for every mode, so a background
 * wait's artifact can never drift from what the same wait returns in a turn.
 */
async function pullRequestCheckPayload(input: {
  resolved: ResolvedWatchProvider;
  number: number;
  outcome: WatchOutcome<PullRequestCheckSnapshot>;
  mode: ObservationMode;
  timeoutSeconds: number;
  pollIntervalSeconds: number;
}) {
  const { resolved, number, outcome } = input;
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
  return {
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
      mode: input.mode,
      stopReason: outcome.stopReason,
      polls: outcome.polls,
      elapsedSeconds: seconds(outcome.elapsedMs),
      timeoutSeconds: input.timeoutSeconds,
      pollIntervalSeconds: input.pollIntervalSeconds,
      ...(outcome.rateLimitRemaining !== undefined
        ? { rateLimitRemaining: outcome.rateLimitRemaining }
        : {}),
    },
  };
}

/** One pull request's head and its checks; a PR that is not open stops the wait. */
function observePullRequest(
  provider: GitHostingProvider,
  number: number,
  providerName: string,
): () => Promise<CheckObservation<PullRequestCheckSnapshot>> {
  return async () => {
    const detail = await provider.pullRequestDetail(number);
    if (!detail)
      throw new Error(`${providerName} returned no pull request #${number}.`);
    if (!detail.headSha)
      throw new Error(
        `${providerName} pull request #${number} has no head commit SHA.`,
      );
    const checks = await provider.refChecks(detail.headSha);
    const rateLimitRemaining = provider.rateLimit?.()?.remaining;
    return {
      snapshot: { detail, checks, checksFinished: checksAreFinished(checks) },
      headSha: detail.headSha,
      checks,
      ...(detail.state !== "open"
        ? { stopReason: "pull_request_not_open" as const }
        : {}),
      ...(rateLimitRemaining !== undefined ? { rateLimitRemaining } : {}),
    };
  };
}

export function startCheckWatch(): CheckWatch {
  return { startedAt: Date.now(), polls: 0, bare: null };
}

/**
 * One observation and the stop rules over it: an outcome when the watch ends
 * here, otherwise the observation it continues past.
 */
export async function pollCheckWatch<Snapshot>(
  watch: CheckWatch,
  input: {
    observe: () => Promise<CheckObservation<Snapshot>>;
    wait: boolean;
    timeoutMs: number;
  },
): Promise<
  | { outcome: WatchOutcome<Snapshot> }
  | { outcome?: undefined; observation: CheckObservation<Snapshot> }
> {
  const polledAt = Date.now();
  const observation = await input.observe();
  const { checks, headSha, rateLimitRemaining } = observation;
  watch.polls += 1;
  const elapsedMs = Date.now() - watch.startedAt;
  const stop = (stopReason: StopReason) => ({
    outcome: {
      snapshot: observation.snapshot,
      stopReason,
      polls: watch.polls,
      elapsedMs,
      ...(rateLimitRemaining !== undefined ? { rateLimitRemaining } : {}),
    },
  });

  if (!input.wait) return stop("current_status");
  if (observation.stopReason) return stop(observation.stopReason);
  if (checks.truncated === true) return stop("checks_truncated");
  if (checksAreFinished(checks)) return stop("checks_finished");
  if (checks.state === "none") {
    if (watch.bare?.headSha !== headSha)
      watch.bare = { headSha, since: polledAt };
    if (Date.now() - watch.bare.since >= NO_CHECKS_GRACE_SECONDS * 1_000)
      return stop("no_checks");
  } else watch.bare = null;
  if (
    rateLimitRemaining !== undefined &&
    rateLimitRemaining < MIN_RATE_LIMIT_REMAINING
  )
    return stop("rate_limited");
  if (elapsedMs >= input.timeoutMs) return stop("timeout");
  return { observation };
}

/**
 * The next sleep, capped by what is left of the timeout from the watch's own
 * start. Zero once it is spent: the poll after it then ends with `timeout`.
 */
export function nextSleepMs(
  watch: CheckWatch,
  timeoutMs: number,
  pollIntervalMs: number,
  now = Date.now(),
): number {
  return Math.max(
    0,
    Math.min(pollIntervalMs, timeoutMs - (now - watch.startedAt)),
  );
}

/**
 * Poll, sleep, poll … until a stop rule ends the watch. `sleepFirst` continues
 * a watch whose last poll ran elsewhere (the background job after the call's
 * first observation) at the sleep that poll would have taken.
 */
export async function continueCheckWatch<Snapshot>(
  watch: CheckWatch,
  input: {
    observe: () => Promise<CheckObservation<Snapshot>>;
    wait: boolean;
    timeoutMs: number;
    pollIntervalMs: number;
    signal: AbortSignal | undefined;
    sleepFirst: boolean;
    onWaiting?: (observation: CheckObservation<Snapshot>) => void;
  },
): Promise<WatchOutcome<Snapshot>> {
  if (input.sleepFirst)
    await abortableSleep(
      nextSleepMs(watch, input.timeoutMs, input.pollIntervalMs),
      input.signal,
    );
  while (true) {
    throwIfAborted(input.signal);
    const step = await pollCheckWatch(watch, input);
    if (step.outcome) return step.outcome;
    input.onWaiting?.(step.observation);
    await abortableSleep(
      nextSleepMs(watch, input.timeoutMs, input.pollIntervalMs),
      input.signal,
    );
  }
}

function seconds(ms: number): number {
  return Math.round(ms / 100) / 10;
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

export function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  throw signal.reason instanceof Error
    ? signal.reason
    : new Error("Pull-request check watch was cancelled.");
}

export function abortableSleep(ms: number, signal: AbortSignal | undefined) {
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
