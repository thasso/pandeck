import type { BackgroundWorkState } from "@assistant/shared";
import type { WorktreeRow } from "../../db/worktreeStore.ts";
import { backgroundWorkStore } from "../../db/backgroundWorkStore.ts";
import {
  ManagedFinishRefusedError,
  WorktreeBusyError,
} from "../../managedFinishRefusal.ts";
import { jsonResult, type ToolCallContext } from "../../mcp/tool.ts";
import { repositoryKeyFromUrl } from "../../pullRequestIdentity.ts";
import {
  launchServerTask,
  type ServerTaskBudget,
  type ServerTaskStarted,
} from "../../serverTasks.ts";
import {
  abortableSleep,
  checkWaitBounds,
  MIN_RATE_LIMIT_REMAINING,
  nextSleepMs,
  pollCheckWatch,
  startCheckWatch,
  throwIfAborted,
  type PullRequestReadiness,
} from "../pullRequestCheckWatch.ts";
import type {
  ManagedPullRequestTarget,
  WorktreeFinishPullRequestOperations,
  WorktreeFinishPullRequestParams,
  managedMergeCore,
} from "./worktreeFinishPullRequest.ts";

export interface FrozenMergeTarget {
  provider: string;
  repositoryKey: string | undefined;
  repository: string;
  number: number;
  headSha: string;
  headBranch: string;
  baseBranch: string;
  row: Pick<WorktreeRow, "id" | "path" | "branch" | "baseBranch" | "projectId">;
}

function sameRow(
  row: WorktreeRow | undefined,
  frozen: FrozenMergeTarget,
): boolean {
  return Boolean(
    row &&
    row.status === "active" &&
    row.id === frozen.row.id &&
    row.path === frozen.row.path &&
    row.branch === frozen.row.branch &&
    row.baseBranch === frozen.row.baseBranch &&
    row.projectId === frozen.row.projectId,
  );
}

export function assertFrozenMergeTarget(
  target: ManagedPullRequestTarget,
  frozen: FrozenMergeTarget,
): void {
  const changed = (
    kind: ConstructorParameters<typeof ManagedFinishRefusedError>[0],
  ) => {
    throw new ManagedFinishRefusedError(
      kind,
      `The managed pull request changed while waiting; nothing was merged.`,
      {
        number: target.number,
        headSha: target.headSha,
        headBranch: target.headBranch,
        baseBranch: target.baseBranch,
      },
    );
  };
  if (target.number !== frozen.number) changed("other-number");
  if (target.headSha.toLowerCase() !== frozen.headSha.toLowerCase())
    changed("head-moved");
  if (
    target.headBranch !== frozen.headBranch ||
    target.baseBranch !== frozen.baseBranch
  )
    changed("branches-changed");
  if (
    target.hosted.provider.kind !== frozen.provider ||
    repositoryKeyFromUrl(target.hosted.provider.repoWebUrl) !==
      frozen.repositoryKey ||
    `${target.hosted.repository.owner}/${target.hosted.repository.repo}` !==
      frozen.repository
  )
    changed("repository-changed");
  if (!sameRow(target.row, frozen)) changed("worktree-changed");
}

type Step =
  | { kind: "ready" | "wait" | "rate_limited"; waitingFor: string[] }
  | { kind: "end"; reason: string; waitingFor: string[] };

/** Terminal facts precede timeout, timeout precedes readiness, rate limits apply only to waiting. */
function step(input: {
  frozen: FrozenMergeTarget;
  readiness?: PullRequestReadiness | undefined;
  refusal?: ManagedFinishRefusedError;
  pollReason?: string | undefined;
  busy?: boolean;
  now: number;
  deadline: number;
  remaining?: number | undefined;
}): Step {
  const { frozen, readiness, refusal, pollReason } = input;
  const detail = readiness?.detail;
  const blockers = readiness?.mergeBlockers ?? [];
  const waitingFor = [...blockers, ...(input.busy ? ["worktree_busy"] : [])];
  const end = (reason: string): Step => ({ kind: "end", reason, waitingFor });
  if (
    (refusal &&
      [
        "other-number",
        "ambiguous",
        "branches-changed",
        "default-branch-changed",
        "repository-changed",
        "worktree-changed",
      ].includes(refusal.kind)) ||
    (detail &&
      (detail.number !== frozen.number ||
        detail.headBranch !== frozen.headBranch ||
        detail.baseBranch !== frozen.baseBranch))
  )
    return end("pull_request_changed");
  if (
    refusal?.kind === "head-moved" ||
    (detail && detail.headSha.toLowerCase() !== frozen.headSha.toLowerCase())
  )
    return end("head_moved");
  if (
    refusal?.kind === "not-open" ||
    refusal?.kind === "no-pull-request" ||
    pollReason === "pull_request_not_open" ||
    (detail && (detail.state !== "open" || detail.merged))
  )
    return end("pull_request_not_open");
  for (const reason of ["checks_truncated", "no_checks"])
    if (pollReason === reason) return end(reason);
  for (const [blocker, reason] of [
    ["checks_failed", "checks_failed"],
    ["changes_requested", "changes_requested"],
    ["draft", "draft"],
    ["provider_not_mergeable", "not_mergeable"],
    ["checks_inconclusive", "checks_inconclusive"],
  ]) {
    if (
      blockers.includes(blocker!) ||
      (blocker === "draft" && refusal?.kind === "draft") ||
      (blocker === "provider_not_mergeable" && refusal?.kind === "conflict")
    )
      return end(reason!);
  }
  if (input.now >= input.deadline || pollReason === "timeout")
    return end("timeout");
  if (readiness?.canMergeNow && !input.busy)
    return { kind: "ready", waitingFor };
  if (
    (input.remaining !== undefined &&
      input.remaining < MIN_RATE_LIMIT_REMAINING) ||
    pollReason === "rate_limited"
  )
    return { kind: "rate_limited", waitingFor };
  return { kind: "wait", waitingFor };
}

class MergeWhenReadyTimeoutError extends Error {}

interface Dependencies {
  core: typeof managedMergeCore;
  launch?: typeof launchServerTask;
  now?: () => number;
  sleep?: typeof abortableSleep;
  itemState?: (id: string) => BackgroundWorkState | undefined;
}

/** Claims belong to calls, never jobs. WATCHING is only an index into durable nonterminal rows. */
export function createMergeWhenReadyRunner(deps: Dependencies) {
  const {
    finishManagedMerge,
    requireMergeableLocalState,
    requireMergeCapabilities,
    requiredLinkedCardTask,
    resolveManagedTarget,
    validateRequest,
    requireCurrentReadiness,
  } = deps.core;
  const starting = new Map<string, { toolCallId?: string }>();
  const watching = new Map<string, { taskId: string; toolCallId?: string }>();
  const launch = deps.launch ?? launchServerTask;
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? abortableSleep;
  const itemState =
    deps.itemState ?? ((id) => backgroundWorkStore.getItem(id)?.state);
  const held = (id: string) =>
    ["pending-launch", "running"].includes(itemState(id) ?? "");

  return async function runWhenReady(
    params: WorktreeFinishPullRequestParams,
    ctx: ToolCallContext,
    operations: WorktreeFinishPullRequestOperations,
  ) {
    const id = params.worktreeId?.trim();
    const prior = starting.get(id);
    if (prior)
      throw new Error(
        prior.toolCallId === ctx.toolCallId
          ? "This merge-when-ready call is still starting; retry shortly."
          : "A merge-when-ready call for this worktree is starting; wait for it.",
      );
    const active = watching.get(id);
    if (active && held(active.taskId)) {
      if (ctx.toolCallId && active.toolCallId === ctx.toolCallId)
        return jsonResult({
          action: "merge",
          status: "waiting",
          taskId: active.taskId,
          state: itemState(active.taskId),
          message:
            "The same merge-when-ready task is still running; its result will arrive on completion.",
        });
      throw new Error(
        `A merge-when-ready task ${active.taskId} already watches this worktree; stop it or wait for its result.`,
      );
    }
    watching.delete(id);
    const claim = { toolCallId: ctx.toolCallId };
    starting.set(id, claim);
    try {
      const request = validateRequest(params);
      const row = await operations.resolve(id);
      if (!row || row.status !== "active")
        throw new Error("That active managed worktree is not available.");
      const target = await resolveManagedTarget(row, operations, ctx.signal);
      if (target.draft)
        throw new Error(
          `Pull request #${target.number} is a draft; call worktree_ready_pull_request before merging.`,
        );
      await requireMergeableLocalState(
        row,
        target.headSha,
        operations,
        target.target,
        ctx.signal,
      );
      requireMergeCapabilities(
        target.capabilities,
        request.method!,
        target.number,
      );
      if (request.markTaskDone) requiredLinkedCardTask(target);
      const frozen: FrozenMergeTarget = {
        provider: target.hosted.provider.kind,
        repositoryKey: repositoryKeyFromUrl(target.hosted.provider.repoWebUrl),
        repository: `${target.hosted.repository.owner}/${target.hosted.repository.repo}`,
        number: target.number,
        headSha: target.headSha,
        headBranch: target.headBranch,
        baseBranch: target.baseBranch,
        row: {
          id: row.id,
          path: row.path,
          branch: row.branch,
          baseBranch: row.baseBranch,
          projectId: row.projectId,
        },
      };
      const bounds = checkWaitBounds(
        frozen.provider === "github" ? "GitHub" : "Forgejo",
        params,
      );
      const watch = startCheckWatch();
      watch.startedAt = now();
      type Provider = ManagedPullRequestTarget["hosted"]["provider"];
      const poll = async (provider: Provider, timeoutMs: number) => {
        const result = await pollCheckWatch(watch, {
          wait: true,
          timeoutMs,
          observe: async () => {
            const snapshot = await operations.readiness(
              provider,
              frozen.number,
            );
            const remaining = provider.rateLimit?.()?.remaining;
            return {
              snapshot,
              headSha: snapshot.detail.headSha,
              checks: snapshot.checks,
              ...(snapshot.detail.state !== "open" || snapshot.detail.merged
                ? { stopReason: "pull_request_not_open" as const }
                : {}),
              ...(remaining !== undefined
                ? { rateLimitRemaining: remaining }
                : {}),
            };
          },
        });
        if (result.outcome)
          return {
            readiness: result.outcome.snapshot,
            pollReason: result.outcome.stopReason,
            remaining: result.outcome.rateLimitRemaining,
          };
        return {
          readiness: result.observation.snapshot,
          pollReason: undefined,
          remaining: result.observation.rateLimitRemaining,
        };
      };
      let observation = await poll(target.hosted.provider, bounds.timeoutMs);
      let decision = step({
        frozen,
        ...observation,
        now: now(),
        deadline: watch.startedAt + bounds.timeoutMs,
      });
      if (decision.kind === "end") {
        requireCurrentReadiness(observation.readiness, target);
        throw new ManagedFinishRefusedError(
          "not-ready",
          `Pull request #${target.number} is not ready to merge: ${decision.reason}. Nothing was merged.`,
          observation.readiness.detail,
          observation.readiness,
        );
      }
      if (decision.kind === "ready") {
        try {
          const payload = await finishManagedMerge(
            request,
            { sessionId: ctx.session.sessionId, toolCallId: ctx.toolCallId },
            operations,
            { signal: ctx.signal, frozen },
          );
          return {
            ...jsonResult(payload),
            ...(payload.status === "approval-pending"
              ? { terminate: true }
              : {}),
          };
        } catch (error) {
          if (error instanceof ManagedFinishRefusedError) {
            decision = step({
              frozen,
              refusal: error,
              readiness: error.readiness,
              remaining: observation.remaining,
              now: now(),
              deadline: Infinity,
            });
            if (decision.kind === "end") throw error;
          } else if (error instanceof WorktreeBusyError)
            decision = step({
              frozen,
              ...observation,
              busy: true,
              now: now(),
              deadline: watch.startedAt + bounds.timeoutMs,
            });
          else throw error;
        }
      }
      const run = async (budget: ServerTaskBudget) => {
        const deadline = watch.startedAt + budget.timeoutMs;
        const metadata = (
          endedBy: string,
          observedBy: "poll" | "final-check",
          waitingFor?: string[],
        ) => ({
          mode: "background",
          endedBy,
          observedBy,
          polls: watch.polls,
          elapsedSeconds: Math.round((now() - watch.startedAt) / 1000),
          timeoutSeconds: budget.timeoutMs / 1000,
          ...(waitingFor ? { waitingFor } : {}),
        });
        const notMerged = (
          reason: string,
          observedBy: "poll" | "final-check",
          refusal?: ManagedFinishRefusedError,
          waitingFor?: string[],
        ) => {
          const readiness = refusal?.readiness ?? observation.readiness;
          const observed = refusal?.observed ?? readiness.detail;
          const detail =
            reason === "head_moved"
              ? `head moved from ${frozen.headSha.slice(0, 7)} to ${observed.headSha?.slice(0, 7) ?? "unknown"}`
              : reason === "timeout"
                ? `timed out after ${budget.timeoutMs / 1000} s waiting for ${waitingFor?.join(", ") || "readiness"}`
                : reason.replaceAll("_", " ");
          const message = `Not merged: ${detail}${refusal ? `; ${refusal.message}` : ""}`;
          return {
            payload: {
              action: "merge",
              status: "not-merged",
              merged: false,
              provider: frozen.provider,
              number: frozen.number,
              url: target.url,
              head: { ref: frozen.headBranch, sha: frozen.headSha },
              observedHeadSha: observed?.headSha,
              observed,
              base: { ref: frozen.baseBranch },
              method: request.method,
              deleteRemoteBranch: request.deleteRemoteBranch,
              markTaskDone: request.markTaskDone,
              removeWorktree: request.removeWorktree,
              mergeBlockers: readiness.mergeBlockers,
              checks: {
                state: readiness.checks.state,
                total: readiness.checks.total,
                failedChecks: readiness.checks.checks
                  .filter((check) => check.status === "failure")
                  .slice(0, 20),
              },
              review: readiness.review,
              whenReady: metadata(reason, observedBy, waitingFor),
              message,
            },
            summary: message,
          };
        };
        throwIfAborted(budget.signal);
        const current = await operations.resolve(id);
        if (!sameRow(current, frozen))
          return notMerged("worktree_unavailable", "poll");
        const push = await operations.target(current!, budget.signal);
        const hosted = await operations.hosting(push, budget.signal);
        if (
          !hosted ||
          hosted.provider.kind !== frozen.provider ||
          repositoryKeyFromUrl(hosted.provider.repoWebUrl) !==
            frozen.repositoryKey ||
          `${hosted.repository.owner}/${hosted.repository.repo}` !==
            frozen.repository
        )
          return notMerged("pull_request_changed", "poll");
        while (true) {
          await sleep(
            nextSleepMs(watch, budget.timeoutMs, bounds.pollIntervalMs, now()),
            budget.signal,
          );
          throwIfAborted(budget.signal);
          if (!sameRow(await operations.resolve(id), frozen))
            return notMerged("worktree_unavailable", "poll");
          observation = await poll(hosted.provider, budget.timeoutMs);
          decision = step({ frozen, ...observation, now: now(), deadline });
          if (decision.kind === "end")
            return notMerged(
              decision.reason,
              "poll",
              undefined,
              decision.waitingFor,
            );
          if (decision.kind === "rate_limited")
            return notMerged(
              "rate_limited",
              "poll",
              undefined,
              decision.waitingFor,
            );
          if (decision.kind === "ready") {
            try {
              const payload = await finishManagedMerge(
                request,
                { sessionId: ctx.session.sessionId },
                operations,
                {
                  signal: budget.signal,
                  frozen,
                  exemptBackgroundItem: {
                    itemId: budget.itemId,
                    ownerSessionId: ctx.session.sessionId,
                  },
                  beforeOutwardStep: () => {
                    if (now() >= deadline)
                      throw new MergeWhenReadyTimeoutError();
                    budget.commit();
                  },
                },
              );
              const message =
                payload.status === "approval-pending" && payload.autoApproved
                  ? `${payload.message} A session grant covered this card; its executor runs at the next idle edge.`
                  : payload.message;
              return {
                payload: {
                  ...payload,
                  message,
                  whenReady: metadata("ready", "final-check"),
                },
                summary:
                  payload.status === "approval-pending"
                    ? `Approval card created for #${frozen.number} into ${frozen.baseBranch}${payload.autoApproved ? "; covered by session grant" : ""}`
                    : message,
              };
            } catch (error) {
              if (error instanceof MergeWhenReadyTimeoutError)
                return notMerged("timeout", "final-check");
              if (error instanceof ManagedFinishRefusedError) {
                decision = step({
                  frozen,
                  refusal: error,
                  readiness: error.readiness,
                  remaining: observation.remaining,
                  now: now(),
                  deadline,
                });
                if (decision.kind === "end")
                  return notMerged(
                    decision.reason,
                    "final-check",
                    error,
                    decision.waitingFor,
                  );
              } else if (error instanceof WorktreeBusyError)
                decision = step({
                  frozen,
                  ...observation,
                  busy: true,
                  now: now(),
                  deadline,
                });
              else throw error;
            }
          }
          if (decision.kind === "end")
            return notMerged(
              decision.reason,
              "final-check",
              undefined,
              decision.waitingFor,
            );
          if (decision.kind === "rate_limited")
            return notMerged(
              "rate_limited",
              "final-check",
              undefined,
              decision.waitingFor,
            );
        }
      };
      const started: ServerTaskStarted = await launch({
        ctx,
        kind: "merge-when-ready",
        label: `Merge when ready ${frozen.repository}#${frozen.number}`,
        command: `worktree_finish_pull_request ${id} #${frozen.number} ${request.method}`,
        sourceTool: "worktree_finish_pull_request",
        requestedTimeoutMs: bounds.timeoutMs,
        run,
      });
      watching.set(id, { taskId: started.taskId, toolCallId: ctx.toolCallId });
      const ended = !["pending-launch", "running"].includes(started.state);
      return jsonResult({
        action: "merge",
        status: ended ? "ended" : "waiting",
        ...started,
        provider: frozen.provider,
        number: frozen.number,
        url: target.url,
        head: { ref: frozen.headBranch, sha: frozen.headSha },
        base: { ref: frozen.baseBranch },
        method: request.method,
        deleteRemoteBranch: request.deleteRemoteBranch,
        markTaskDone: request.markTaskDone,
        removeWorktree: request.removeWorktree,
        waitingFor: decision.waitingFor,
        timeoutSeconds: bounds.timeoutSeconds,
        message: `${ended ? "The task ended; its result is on that task." : "Waiting in the background; the result will arrive on completion."}${request.removeWorktree && ctx.session.cwd === row.path ? " If the merge removes this worktree, this session is settled; the result stays on the background task." : ""}`,
      });
    } finally {
      if (starting.get(id) === claim) starting.delete(id);
    }
  };
}
