/** Checked delivery mutations for registered spawned worktrees. */
import type {
  CommitDisplay,
  PullRequestCard,
  PushDisplay,
  TaskSummary,
} from "@assistant/shared";
import {
  getWorktree,
  taskIdsForWorktree,
  type WorktreeRow,
} from "../../db/worktreeStore.ts";
import {
  defineAgentTool,
  jsonResult,
  type AgentTool,
  type ToolCallContext,
} from "../../mcp/tool.ts";
import { gitOptional } from "../../gitExec.ts";
import {
  runCommitWorkflow,
  toCommitDisplay,
  type CommitWorkflowOptions,
  type CommitWorkflowResult,
} from "../../commitWorkflow.ts";
import {
  runPushWorkflow,
  toPushDisplay,
  type PushWorkflowOptions,
  type PushWorkflowResult,
  type ResolvedPushTarget,
} from "../../pushWorkflow.ts";
import { reserveWorktreeForMutation } from "../../session/sessionRunLease.ts";
import { invalidateWorktreeStatus } from "../../worktrees/worktreeStatus.ts";
import { isMainWorktreeId } from "../../worktrees/worktreeResolve.ts";
import type { GitHostingProvider } from "../../gitHosting.ts";
import {
  assertManagedProviderRepository,
  readManagedLocalState,
  readManagedRemoteHead,
  resolveManagedHosting,
  resolveManagedPushTarget,
  type ManagedHostingTarget,
  type ManagedWorktreeLocalState,
} from "./managedDeliveryTargets.ts";
import {
  createWorktreeFinishPullRequestTool,
  createWorktreeReadyPullRequestTool,
} from "./worktreeFinishPullRequest.ts";
import {
  beginPullRequestCard,
  finalizePullRequestCard,
  type BeginPullRequestCardInput,
  type BeginPullRequestCardResult,
} from "../../prWorkflow.ts";
import {
  patchPullRequestCard,
  pullRequestCardById,
  pullRequestCardRecord,
  pullRequestCardsForWorktree,
} from "../../pullRequestCards.ts";
import { scheduleImmediatePoll } from "../../pullRequestWatcher.ts";
import { readTask, taskSummaryOf } from "../../tasks.ts";
import { invalidateWorktreeHosting } from "../../worktrees/worktreeHosting.ts";
import {
  MAX_PULL_REQUEST_TITLE_CHARS,
  normalizeExplicitPullRequestTitle,
} from "../../pullRequestTitle.ts";

const MAX_CONTEXT_CHARS = 4_000;
const BUSY_COMMIT_REFUSAL =
  "Another session is running or starting in this worktree. Wait until it is idle before committing.";
const BUSY_PUSH_REFUSAL =
  "Another session is running or starting in this worktree. Wait until it is idle before pushing.";
const BUSY_PULL_REQUEST_REFUSAL =
  "Another session is running or starting in this worktree. Wait until it is idle before creating its pull request.";
const MAX_TASK_CANDIDATES = 8;
const MAX_RESULT_WARNINGS = 10;
const MAX_WARNING_CHARS = 1_000;

export interface WorktreeCommitOperations {
  resolve(worktreeId: string): Promise<WorktreeRow | undefined>;
  reserve(
    worktreeId: string,
    callerSessionId: string,
    reason: string,
  ): (() => void) | undefined;
  checkedOutBranch(row: WorktreeRow, signal?: AbortSignal): Promise<string>;
  runCommit(options: CommitWorkflowOptions): Promise<CommitWorkflowResult>;
  invalidate(worktreeId: string): void;
}

const defaultOperations: WorktreeCommitOperations = {
  resolve: async (worktreeId) => getWorktree(worktreeId),
  reserve: reserveWorktreeForMutation,
  // Deliberately NOT the full local-state read: a worktree whose branch has no
  // commit yet still has a branch to check, and committing is what gives it one.
  async checkedOutBranch(row, signal) {
    const result = await gitOptional(
      ["symbolic-ref", "--quiet", "--short", "HEAD"],
      row.path,
      signal,
    );
    return result.code === 0 ? result.stdout.trim() : "";
  },
  runCommit: runCommitWorkflow,
  invalidate: invalidateWorktreeStatus,
};

export interface WorktreePushOperations {
  resolve(worktreeId: string): Promise<WorktreeRow | undefined>;
  reserve(
    worktreeId: string,
    callerSessionId: string,
    reason: string,
  ): (() => void) | undefined;
  localState(
    row: WorktreeRow,
    signal?: AbortSignal,
  ): Promise<ManagedWorktreeLocalState>;
  target(row: WorktreeRow, signal?: AbortSignal): Promise<ResolvedPushTarget>;
  remoteHead(
    target: ResolvedPushTarget,
    branch: string,
    signal?: AbortSignal,
  ): Promise<string | undefined>;
  runPush(options: PushWorkflowOptions): Promise<PushWorkflowResult>;
  invalidate(worktreeId: string): void;
}

const defaultPushOperations: WorktreePushOperations = {
  resolve: async (worktreeId) => getWorktree(worktreeId),
  reserve: reserveWorktreeForMutation,
  localState: readManagedLocalState,
  target: resolveManagedPushTarget,
  remoteHead: readManagedRemoteHead,
  runPush: runPushWorkflow,
  invalidate: invalidateWorktreeStatus,
};

interface ManagedPullRequestRecoveryInput {
  row: WorktreeRow;
  callerSessionId: string;
  remote: string;
  acceptedHeadSha: string;
  provider: GitHostingProvider;
  taskId?: string;
  title?: string;
  onProgress?: (message: string) => void;
}

export interface WorktreePullRequestOperations {
  resolve(worktreeId: string): Promise<WorktreeRow | undefined>;
  reserve(
    worktreeId: string,
    callerSessionId: string,
    reason: string,
  ): (() => void) | undefined;
  localState(
    row: WorktreeRow,
    signal?: AbortSignal,
  ): Promise<ManagedWorktreeLocalState>;
  target(row: WorktreeRow, signal?: AbortSignal): Promise<ResolvedPushTarget>;
  remoteHead(
    target: ResolvedPushTarget,
    branch: string,
    signal?: AbortSignal,
  ): Promise<string | undefined>;
  hosting(
    target: ResolvedPushTarget,
    signal?: AbortSignal,
  ): Promise<ManagedHostingTarget | undefined>;
  taskIds(worktreeId: string): string[];
  task(taskId: string): TaskSummary | undefined;
  recover(
    input: ManagedPullRequestRecoveryInput,
  ): Promise<BeginPullRequestCardResult | undefined>;
  begin(input: BeginPullRequestCardInput): Promise<BeginPullRequestCardResult>;
  card(cardId: string): PullRequestCard | undefined;
  invalidate(worktreeId: string): void;
  schedulePoll(cardId: string): void;
}

export const defaultPullRequestOperations: WorktreePullRequestOperations = {
  resolve: defaultPushOperations.resolve,
  reserve: defaultPushOperations.reserve,
  localState: defaultPushOperations.localState,
  target: defaultPushOperations.target,
  remoteHead: defaultPushOperations.remoteHead,
  hosting: resolveManagedHosting,
  taskIds: taskIdsForWorktree,
  task(taskId) {
    const task = readTask(taskId);
    return task ? taskSummaryOf(task) : undefined;
  },
  async recover(input) {
    const card = pullRequestCardsForWorktree(input.row.id)
      .filter(
        (candidate) =>
          // A managed card is timeline-owned. Reusing another session's card
          // would return an id that cannot appear at this caller's tool anchor;
          // provider PR adoption may therefore project the same PR into another
          // caller timeline, as repeated `/pr` already does. Provider mutations
          // remain serialized across cards by pullRequestMerge.ts.
          candidate.sessionId === input.callerSessionId &&
          candidate.headBranch === input.row.branch &&
          candidate.baseBranch === input.row.baseBranch &&
          candidate.status !== "failed",
      )
      .sort((left, right) => right.createdAt - left.createdAt)
      .find((candidate) => {
        const context = pullRequestCardRecord(candidate.id)?.context;
        return (
          context?.acceptedHeadSha?.toLowerCase() ===
            input.acceptedHeadSha.toLowerCase() &&
          context.remote === input.remote
        );
      });
    if (!card) return undefined;
    if (card.linkedTask?.id !== input.taskId)
      throw new Error(
        `The existing managed pull-request card is linked to ${card.linkedTask ? `Task-${card.linkedTask.id}` : "no Task"}, not ${input.taskId ? `Task-${input.taskId}` : "the requested no-Task context"}.`,
      );
    if (card.status === "creating") {
      const context = pullRequestCardRecord(card.id)?.context;
      assertMatchingManagedPullRequestTitleIntent(
        context?.explicitTitle,
        input.title,
      );
      const finalized = await finalizePullRequestCard(card.id, input.taskId, {
        ...(input.onProgress ? { onProgress: input.onProgress } : {}),
        provider: input.provider,
      });
      return {
        status:
          finalized.status === "failed"
            ? "failed"
            : finalized.reused
              ? "reused"
              : "created",
        cardId: finalized.id,
        summary:
          finalized.status === "failed"
            ? (finalized.error ?? "Pull request creation failed.")
            : finalized.reused
              ? `Pull request #${finalized.number} reused (${finalized.status}).`
              : `Pull request #${finalized.number} created.`,
      };
    }
    if (
      !card.provider ||
      card.provider !== input.provider.kind ||
      card.number === undefined
    )
      throw new Error(
        "The existing managed pull-request card does not match the derived provider target.",
      );
    const detail = await input.provider.pullRequestDetail(card.number);
    if (
      !detail ||
      detail.headBranch !== input.row.branch ||
      detail.baseBranch !== input.row.baseBranch ||
      detail.headSha.toLowerCase() !== input.acceptedHeadSha.toLowerCase()
    )
      throw new Error(
        `Existing pull request #${card.number} no longer matches the checked managed branch/base/HEAD and was not reused.`,
      );
    const status = detail.merged ? "merged" : detail.state;
    patchPullRequestCard(
      card.id,
      {
        status,
        reused: true,
        draft: detail.draft ? true : undefined,
        ...(status === "open"
          ? {}
          : {
              warnings: [
                ...card.warnings.filter(
                  (warning) => !warning.startsWith("Existing pull request #"),
                ),
                `Existing pull request #${card.number} is ${status}; no new pull request was created for the branch's latest commits.`,
              ],
            }),
      },
      { observedHeadSha: detail.headSha },
    );
    return {
      status: "reused",
      cardId: card.id,
      summary: `Pull request #${card.number} reused (${status}).`,
    };
  },
  begin: beginPullRequestCard,
  card: pullRequestCardById,
  invalidate(worktreeId) {
    invalidateWorktreeStatus(worktreeId);
    invalidateWorktreeHosting(worktreeId);
  },
  schedulePoll: scheduleImmediatePoll,
};

const commitSchema = {
  type: "object",
  additionalProperties: false,
  required: ["worktreeId"],
  properties: {
    worktreeId: {
      type: "string",
      minLength: 1,
      description:
        "Active registered spawned worktree id. Synthetic main ids and paths are refused.",
    },
    context: {
      type: "string",
      maxLength: MAX_CONTEXT_CHARS,
      description:
        "Optional brief intent/context for checked message generation; it does not choose the message or files.",
    },
    stagedOnly: {
      type: "boolean",
      default: false,
      description:
        "Commit only what is already in the index. Stage your own paths with `git add` first; unstaged and untracked changes stay in the working tree, are not reviewed, and are not committed. Default false stages the complete change set.",
    },
  },
} as const;

const pushSchema = {
  type: "object",
  additionalProperties: false,
  required: ["worktreeId"],
  properties: {
    worktreeId: {
      type: "string",
      minLength: 1,
      description:
        "Active registered spawned worktree id. Synthetic main ids and paths are refused.",
    },
    forceWithLease: {
      type: "boolean",
      default: false,
      description:
        "Use only after intentionally rebasing or amending this same managed branch. The server re-reads the current remote oid and uses an exact force-with-lease; a mismatch must be investigated, not retried blindly.",
    },
  },
} as const;

const pullRequestSchema = {
  type: "object",
  additionalProperties: false,
  required: ["worktreeId"],
  properties: {
    worktreeId: {
      type: "string",
      minLength: 1,
      description:
        "Active registered spawned worktree id. The server derives its checkout, repository, remote, head branch, base branch, and accepted HEAD.",
    },
    taskId: {
      type: "string",
      minLength: 1,
      description:
        "Exact Task id linked to the target worktree. Required only when that worktree has several valid Task links.",
    },
    context: {
      type: "string",
      maxLength: MAX_CONTEXT_CHARS,
      description:
        "Optional bounded intent for the configured pull-request authoring agent; it does not supply the body.",
    },
    title: {
      type: "string",
      minLength: 1,
      maxLength: MAX_PULL_REQUEST_TITLE_CHARS,
      description: `Optional exact title for a newly created pull request. Outer whitespace is trimmed; the remainder must be nonblank, one line, and at most ${MAX_PULL_REQUEST_TITLE_CHARS} characters. Existing pull requests are adopted without renaming.`,
    },
    draft: {
      type: "boolean",
      default: false,
      description:
        "Create the checked pull request as a draft. Defaults to false.",
    },
  },
} as const;

/** Build the tool around injectable seams so authorization/release paths are testable. */
export function createWorktreeCommitTool(
  operations: WorktreeCommitOperations = defaultOperations,
): AgentTool<WorktreeCommitParams> & AgentTool {
  return defineAgentTool<WorktreeCommitParams>({
    name: "worktree_commit",
    label: "Commit managed worktree",
    description:
      "Create a normal checked commit in an active registered spawned worktree: the complete change set by default, or with stagedOnly only the index you staged yourself. Uses the same safety review and generated message as /commit, never forces blockers, and refuses a worktree another session may still be changing.",
    parameters: commitSchema as unknown as Record<string, unknown>,
    async execute(params, ctx) {
      return executeWorktreeCommit(params, ctx, operations);
    },
  });
}

type WorktreeCommitParams = {
  worktreeId: string;
  context?: string;
  stagedOnly?: boolean;
};

async function executeWorktreeCommit(
  params: WorktreeCommitParams,
  ctx: ToolCallContext,
  operations: WorktreeCommitOperations,
) {
  const worktreeId = params.worktreeId?.trim();
  if (!worktreeId) throw new Error("worktreeId is required.");
  if (isMainWorktreeId(worktreeId))
    throw new Error("The main checkout is not an agent commit target.");
  const context = params.context?.trim();
  if (context && context.length > MAX_CONTEXT_CHARS)
    throw new Error(`context exceeds ${MAX_CONTEXT_CHARS} characters.`);

  const initial = await operations.resolve(worktreeId);
  if (!initial || initial.status !== "active")
    throw new Error("That active managed worktree is not available.");

  const release = operations.reserve(
    initial.id,
    ctx.session.sessionId,
    "A checked agent commit is in progress in this worktree.",
  );
  if (!release) throw new Error(BUSY_COMMIT_REFUSAL);
  try {
    // Resolve again under the reservation: removal may have won the race while
    // the first asynchronous lookup was in flight.
    const row = await operations.resolve(worktreeId);
    if (
      !row ||
      row.status !== "active" ||
      row.id !== initial.id ||
      row.path !== initial.path ||
      row.branch !== initial.branch
    )
      throw new Error("The managed worktree changed or was removed.");

    const actualBranch = await operations.checkedOutBranch(row, ctx.signal);
    if (actualBranch !== row.branch)
      throw new Error(
        `The worktree is registered for branch ${row.branch}, but ${actualBranch || "a detached HEAD"} is checked out.`,
      );

    const result = await operations.runCommit({
      source: "tool",
      force: false,
      cwd: row.path,
      expectedBranch: row.branch,
      ...(ctx.session.sessionManager !== undefined
        ? { sessionManager: ctx.session.sessionManager }
        : {}),
      sessionKind: ctx.session.agentType,
      sessionId: ctx.session.sessionId,
      stagedOnly: params.stagedOnly === true,
      ...(context ? { additionalContext: context } : {}),
      ...(ctx.signal !== undefined ? { signal: ctx.signal } : {}),
      onProgress: (message) =>
        ctx.progress?.(jsonResult({ status: "running", message })),
    });
    if (result.status === "failed")
      throw new Error(result.error ?? "The checked commit failed.");
    const display: CommitDisplay = toCommitDisplay(result);
    return jsonResult(display);
  } finally {
    release();
    operations.invalidate(initial.id);
  }
}

/** Build the checked publication tool around injectable authorization seams. */
export function createWorktreePushTool(
  operations: WorktreePushOperations = defaultPushOperations,
): AgentTool<{ worktreeId: string; forceWithLease?: boolean }> & AgentTool {
  return defineAgentTool<{ worktreeId: string; forceWithLease?: boolean }>({
    name: "worktree_push",
    label: "Push managed worktree",
    description:
      "Publish the complete committed HEAD of a clean active registered spawned worktree to its derived remote and same-named branch. Ordinary push and exact-oid force-with-lease after an intentional rebase/amend are pre-authorized; never accepts a path, remote, ref, raw force, or lease oid. A lease mismatch or unexpected divergence must be inspected rather than retried blindly.",
    parameters: pushSchema as unknown as Record<string, unknown>,
    async execute(params, ctx) {
      return executeWorktreePush(params, ctx, operations);
    },
  });
}

async function executeWorktreePush(
  params: { worktreeId: string; forceWithLease?: boolean },
  ctx: ToolCallContext,
  operations: WorktreePushOperations,
) {
  const worktreeId = params.worktreeId?.trim();
  if (!worktreeId) throw new Error("worktreeId is required.");
  if (isMainWorktreeId(worktreeId))
    throw new Error("The main checkout is not an agent push target.");

  const initial = await operations.resolve(worktreeId);
  if (!initial || initial.status !== "active")
    throw new Error("That active managed worktree is not available.");

  const release = operations.reserve(
    initial.id,
    ctx.session.sessionId,
    "A checked agent push is in progress in this worktree.",
  );
  if (!release) throw new Error(BUSY_PUSH_REFUSAL);
  try {
    const row = await operations.resolve(worktreeId);
    if (
      !row ||
      row.status !== "active" ||
      row.id !== initial.id ||
      row.path !== initial.path ||
      row.branch !== initial.branch
    )
      throw new Error("The managed worktree changed or was removed.");

    const local = await operations.localState(row, ctx.signal);
    if (local.branch !== row.branch)
      throw new Error(
        `The worktree is registered for branch ${row.branch}, but ${local.branch || "a detached HEAD"} is checked out.`,
      );
    if (!local.head)
      throw new Error("The managed branch HEAD could not be read.");
    if (!local.clean)
      throw new Error(
        "The worktree has staged, modified, or non-ignored untracked changes. Call worktree_commit before pushing; ignored build output is allowed.",
      );

    const target = await operations.target(row, ctx.signal);
    let expectedRemoteHead: string | undefined;
    if (params.forceWithLease === true) {
      if (!target.upstream)
        throw new Error(
          "Force-with-lease requires an existing upstream and remote branch. Use ordinary worktree_push for the first push.",
        );
      if (
        target.upstream.remote !== target.remote ||
        target.upstream.branch !== row.branch
      )
        throw new Error(
          `The registered branch must track ${target.remote}/${row.branch} before force-with-lease; it currently tracks ${target.upstream.remote}/${target.upstream.branch}.`,
        );
      expectedRemoteHead = await operations.remoteHead(
        target,
        row.branch,
        ctx.signal,
      );
      if (!expectedRemoteHead)
        throw new Error(
          "The tracked remote branch does not exist. Use ordinary worktree_push rather than force-with-lease for a first push.",
        );
    }

    const result = await operations.runPush({
      cwd: row.path,
      force: false,
      remote: target.remote,
      expectedBranch: row.branch,
      expectedHead: local.head,
      requireClean: true,
      ...(expectedRemoteHead
        ? { explicitLease: { expectedRemoteOid: expectedRemoteHead } }
        : {}),
      ...(ctx.signal !== undefined ? { signal: ctx.signal } : {}),
      onProgress: (message) =>
        ctx.progress?.(jsonResult({ status: "running", message })),
    });
    if (result.status === "failed") {
      const detail =
        result.error || result.output || "The checked push failed.";
      const guidance = params.forceWithLease
        ? " Investigate the remote head before any retry."
        : /non-fast-forward|fetch first/i.test(detail)
          ? " Inspect why the branch diverged; use forceWithLease only after an intentional rebase or amend of this same branch."
          : "";
      throw new Error(`${detail}${guidance}`);
    }
    const display: PushDisplay = {
      ...toPushDisplay(result),
      localHead: local.head,
      ...(expectedRemoteHead ? { expectedRemoteHead } : {}),
    };
    return jsonResult(display);
  } finally {
    release();
    operations.invalidate(initial.id);
  }
}

function boundedWarnings(warnings: string[]): string[] {
  return warnings.slice(0, MAX_RESULT_WARNINGS).map((warning) => {
    const trimmed = warning.trim();
    return trimmed.length <= MAX_WARNING_CHARS
      ? trimmed
      : `${trimmed.slice(0, MAX_WARNING_CHARS - 1)}…`;
  });
}

export function assertMatchingManagedPullRequestTitleIntent(
  storedTitle: string | undefined,
  requestedTitle: string | undefined,
): void {
  if (storedTitle === requestedTitle) return;
  const describe = (title: string | undefined) =>
    title === undefined
      ? "an agent-generated title"
      : `explicit title ${JSON.stringify(title)}`;
  throw new Error(
    `The existing managed pull-request card reserved ${describe(storedTitle)}, but this retry requested ${describe(requestedTitle)}. Retry with the original title intent or start a distinct delivery attempt.`,
  );
}

function taskForManagedPullRequest(
  params: { taskId?: string },
  worktreeId: string,
  operations: WorktreePullRequestOperations,
): TaskSummary | undefined {
  const linkedIds = [...new Set(operations.taskIds(worktreeId))];
  const requested = params.taskId?.trim();
  if (requested) {
    const task = operations.task(requested);
    if (!task) throw new Error(`Task-${requested} does not exist.`);
    if (!linkedIds.includes(requested))
      throw new Error(
        `Task-${requested} is not linked to this managed worktree. Use one of its exact linked Task ids.`,
      );
    return task;
  }

  const candidates = linkedIds.flatMap((id) => {
    const task = operations.task(id);
    return task ? [task] : [];
  });
  if (candidates.length <= 1) return candidates[0];
  const shown = candidates
    .slice(0, MAX_TASK_CANDIDATES)
    .map((task) => `Task-${task.id}: ${task.title}`)
    .join("; ");
  const remainder = candidates.length - MAX_TASK_CANDIDATES;
  throw new Error(
    `This worktree has several linked Tasks. Retry with an exact taskId: ${shown}${remainder > 0 ? `; and ${remainder} more` : ""}.`,
  );
}

/** Build checked canonical PR creation around injectable managed-target seams. */
export function createWorktreePullRequestTool(
  operations: WorktreePullRequestOperations = defaultPullRequestOperations,
): AgentTool<{
  worktreeId: string;
  taskId?: string;
  context?: string;
  title?: string;
  draft?: boolean;
}> &
  AgentTool {
  return defineAgentTool<{
    worktreeId: string;
    taskId?: string;
    context?: string;
    title?: string;
    draft?: boolean;
  }>({
    name: "worktree_create_pull_request",
    label: "Create managed pull request",
    description:
      "Create or strictly adopt the canonical live pull-request card for a clean, fully pushed active registered spawned worktree. The server derives and verifies the target repository, same-named upstream, remote HEAD, head/base branches, body, and linked Task. The configured PR agent writes the default title; an optional title overrides it only for a new PR. Existing PRs are adopted without renaming. Default and non-default bases are pre-authorized. Use after worktree_commit and worktree_push, never generic provider PR creation. This creates but never merges.",
    parameters: pullRequestSchema as unknown as Record<string, unknown>,
    async execute(params, ctx) {
      return executeWorktreePullRequest(params, ctx, operations);
    },
  });
}

async function executeWorktreePullRequest(
  params: {
    worktreeId: string;
    taskId?: string;
    context?: string;
    title?: string;
    draft?: boolean;
  },
  ctx: ToolCallContext,
  operations: WorktreePullRequestOperations,
) {
  const worktreeId = params.worktreeId?.trim();
  if (!worktreeId) throw new Error("worktreeId is required.");
  if (isMainWorktreeId(worktreeId))
    throw new Error("The main checkout is not an agent pull-request target.");
  const additionalContext = params.context?.trim();
  if (additionalContext && additionalContext.length > MAX_CONTEXT_CHARS)
    throw new Error(`context exceeds ${MAX_CONTEXT_CHARS} characters.`);
  const explicitTitle =
    params.title === undefined
      ? undefined
      : normalizeExplicitPullRequestTitle(params.title);

  const initial = await operations.resolve(worktreeId);
  if (!initial || initial.status !== "active")
    throw new Error("That active managed worktree is not available.");

  const release = operations.reserve(
    initial.id,
    ctx.session.sessionId,
    "A checked agent pull-request creation is in progress in this worktree.",
  );
  if (!release) throw new Error(BUSY_PULL_REQUEST_REFUSAL);
  try {
    const row = await operations.resolve(worktreeId);
    if (
      !row ||
      row.status !== "active" ||
      row.id !== initial.id ||
      row.path !== initial.path ||
      row.branch !== initial.branch ||
      row.baseBranch !== initial.baseBranch ||
      row.projectId !== initial.projectId
    )
      throw new Error("The managed worktree target changed or was removed.");

    const local = await operations.localState(row, ctx.signal);
    if (local.branch !== row.branch)
      throw new Error(
        `The worktree is registered for branch ${row.branch}, but ${local.branch || "a detached HEAD"} is checked out.`,
      );
    if (!local.head)
      throw new Error("The managed branch HEAD could not be read.");
    if (!local.clean)
      throw new Error(
        "The worktree has staged, modified, or non-ignored untracked changes. Call worktree_commit before creating its pull request.",
      );

    const target = await operations.target(row, ctx.signal);
    if (!target.upstream)
      throw new Error(
        "The managed branch has no upstream. Call ordinary worktree_push before creating its pull request.",
      );
    if (
      target.upstream.remote !== target.remote ||
      target.upstream.branch !== row.branch
    )
      throw new Error(
        `The managed branch must track ${target.remote}/${row.branch}; it currently tracks ${target.upstream.remote}/${target.upstream.branch}. Call worktree_push to publish the registered branch to its derived same-named target.`,
      );
    const remoteHead = await operations.remoteHead(
      target,
      row.branch,
      ctx.signal,
    );
    if (!remoteHead)
      throw new Error(
        "The tracked remote branch does not exist. Call ordinary worktree_push before creating its pull request.",
      );
    if (remoteHead.toLowerCase() !== local.head.toLowerCase())
      throw new Error(
        `The remote branch head ${remoteHead} does not equal local HEAD ${local.head}. Call ordinary worktree_push for unpublished commits; after an intentional rebase or amend, use worktree_push with forceWithLease and investigate any lease mismatch.`,
      );

    const hosted = await operations.hosting(target, ctx.signal);
    if (!hosted)
      throw new Error(
        `No git hosting provider is configured for the derived push remote "${target.remote}".`,
      );
    assertManagedProviderRepository(
      hosted,
      target.remote,
      "no pull request was created.",
    );

    const linkedTask = taskForManagedPullRequest(params, row.id, operations);
    const onProgress = (message: string) =>
      ctx.progress?.(jsonResult({ status: "running", message }));
    ctx.signal?.throwIfAborted();
    // Once authoring/provider creation starts it is intentionally convergent,
    // not cancellable: a provider write may already have landed and must be
    // observed/adopted before the mutation reservation can be released.
    const recovered = await operations.recover({
      row,
      callerSessionId: ctx.session.sessionId,
      remote: target.remote,
      acceptedHeadSha: local.head,
      provider: hosted.provider,
      ...(linkedTask ? { taskId: linkedTask.id } : {}),
      ...(explicitTitle !== undefined ? { title: explicitTitle } : {}),
      onProgress,
    });
    const result =
      recovered ??
      (await operations.begin({
        repoRoot: row.path,
        sessionKind: ctx.session.agentType,
        sessionId: ctx.session.sessionId,
        sourceToolCallId: ctx.toolCallId,
        args: {
          draft: params.draft === true,
          force: false,
          forceCommit: false,
          base: row.baseBranch,
          additionalContext: additionalContext ?? "",
        },
        ...(linkedTask ? { taskId: linkedTask.id } : {}),
        ...(explicitTitle !== undefined ? { title: explicitTitle } : {}),
        trustedTarget: {
          worktree: row,
          remote: target.remote,
          acceptedHeadSha: local.head,
          provider: hosted.provider,
        },
        onProgress,
      }));
    if (result.status === "failed") throw new Error(result.summary);
    if (result.status === "choosing-task")
      throw new Error(
        "Checked managed pull-request creation unexpectedly requested a human Task choice.",
      );

    const card = operations.card(result.cardId);
    if (!card || !card.provider || card.number === undefined || !card.url)
      throw new Error(
        "The pull-request service did not produce a usable canonical live card.",
      );
    operations.invalidate(row.id);
    if (card.status === "open") operations.schedulePoll(card.id);
    const warnings = boundedWarnings(card.warnings);
    return jsonResult({
      cardId: card.id,
      status: result.status,
      pullRequestState: card.status,
      provider: card.provider,
      number: card.number,
      url: card.url,
      head: card.headBranch,
      base: card.baseBranch,
      acceptedHeadSha: local.head,
      draft: Boolean(card.draft),
      ...(card.linkedTask
        ? {
            linkedTask: {
              id: card.linkedTask.id,
              title: card.linkedTask.title,
            },
          }
        : {}),
      warnings,
      // Safety state is derived before projection bounds; authoring chatter
      // must never hide that a landed PR no longer contains acceptedHeadSha.
      partial: card.warnings.some((warning) =>
        warning.startsWith("STALE-HEAD WARNING:"),
      ),
    });
  } finally {
    try {
      operations.invalidate(initial.id);
    } finally {
      release();
    }
  }
}

export const worktreeDeliveryTools = [
  createWorktreeCommitTool(),
  createWorktreePushTool(),
  createWorktreePullRequestTool(),
  createWorktreeReadyPullRequestTool(),
  createWorktreeFinishPullRequestTool(),
];
