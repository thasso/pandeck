/** Managed worktree lifecycle tools for coding agents. */
import {
  defineAgentTool,
  jsonResult,
  type ToolSession,
} from "../../mcp/tool.ts";
import { worktreeIdForSession } from "../../db/worktreeStore.ts";
import { getSettings } from "../../settings.ts";
import { readTask } from "../../tasks.ts";
import { reserveWorktreeForMutation } from "../../session/sessionRunLease.ts";
import { openPullRequestCards } from "../../pullRequestCards.ts";
import { gitOptional, gitOptionalExit } from "../../gitExec.ts";
import { removeWorktreeAndSettleSessions } from "../../worktreeRemoval.ts";
import {
  createWorktree,
  hasUnmergedCommits,
  WorktreeBranchCleanupError,
  listWorktreeRecords,
} from "../../worktrees/worktrees.ts";
import {
  isMainWorktreeId,
  resolveWorktreeRow,
} from "../../worktrees/worktreeResolve.ts";
import { changeWorktreeBase } from "../../worktrees/worktreeBase.ts";
import { computeWorktreeStatus } from "../../worktrees/worktreeStatus.ts";
import {
  generateWorktreeSuffix,
  sanitizeWorktreeSuffix,
  taskWorktreeName,
} from "../../worktrees/worktreeNaming.ts";

function callingProjectId(session: ToolSession): Promise<string> {
  const worktreeId = worktreeIdForSession(session.sessionId);
  if (!worktreeId)
    throw new Error(
      "This session is not linked to a worktree; supply projectId to choose a project.",
    );
  return resolveWorktreeRow(worktreeId).then((row) => {
    if (!row)
      throw new Error(
        "This session's worktree is no longer available; supply projectId to choose a project.",
      );
    return row.projectId;
  });
}

async function localBranchExists(row: {
  branch: string;
  mainRepoRoot: string;
}): Promise<boolean> {
  const result = await gitOptionalExit(
    ["show-ref", "--verify", "--quiet", `refs/heads/${row.branch}`],
    row.mainRepoRoot,
  );
  return result.code === 0;
}

/** The force-overridden containment loss, with unknown kept distinct from zero. */
async function unmergedCommitLoss(
  row: Parameters<typeof hasUnmergedCommits>[0],
): Promise<number | "unknown"> {
  try {
    if (!(await hasUnmergedCommits(row))) return 0;
    const result = await gitOptional(
      ["rev-list", "--count", `${row.baseBranch}..${row.branch}`],
      row.mainRepoRoot,
    );
    if (result.code !== 0) return "unknown";
    const count = Number(result.stdout.trim());
    return Number.isSafeInteger(count) && count >= 0 ? count : "unknown";
  } catch {
    // A missing/uninspectable base is exactly when force can still delete a
    // branch but cannot honestly count the work it discards.
    return "unknown";
  }
}

const createSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    projectId: {
      type: "string",
      description:
        "Project to create in. Omit to use this session's worktree project; any registered project may be named.",
    },
    baseBranch: {
      type: "string",
      description:
        "Local branch to fork from and merge back into. Remote refs, tags and commit SHAs are refused.",
    },
    name: {
      type: "string",
      description:
        "Short branch/folder suffix. It is sanitized; an absent or unusable name is generated.",
    },
    taskId: {
      type: "string",
      description:
        "Optional Task id to link. Its branch starts with the Task's primary Jira key, or t<taskId> when no Jira issue is linked.",
    },
  },
} as const;

const worktreeCreate = defineAgentTool<{
  projectId?: string;
  baseBranch?: string;
  name?: string;
  taskId?: string;
}>({
  name: "worktree_create",
  label: "Create managed worktree",
  description:
    "Create and register a managed git worktree, visible in the app and usable as a commit target. The returned path is where to cd; this does not relink the calling session.",
  parameters: createSchema as unknown as Record<string, unknown>,
  async execute(params, ctx) {
    const projectId = params.projectId ?? (await callingProjectId(ctx.session));
    const requested = params.name
      ? sanitizeWorktreeSuffix(params.name)
      : undefined;
    const suffix =
      requested ??
      (await generateWorktreeSuffix(
        params.name ?? "Agent-created worktree",
        getSettings().worktrees.namingAgent,
      ));
    const task = params.taskId ? readTask(params.taskId) : undefined;
    const name = params.taskId
      ? taskWorktreeName(task ?? { id: params.taskId }, suffix)
      : suffix;
    const record = await createWorktree({
      projectId,
      name,
      ...(params.baseBranch !== undefined
        ? { baseBranch: params.baseBranch }
        : {}),
      ...(params.taskId !== undefined ? { taskId: params.taskId } : {}),
      ...(ctx.signal !== undefined ? { signal: ctx.signal } : {}),
      onSubmodules: () =>
        ctx.progress?.(
          jsonResult({
            status: "submodules",
            message: "Checking out submodules; this may take a few minutes.",
          }),
        ),
    });
    return jsonResult({
      id: record.id,
      path: record.path,
      branch: record.branch,
      baseBranch: record.baseBranch,
      baseCommit: record.baseCommit,
      projectId: record.projectId,
    });
  },
});

const statusSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    worktreeId: { type: "string", description: "Worktree id for live detail." },
    projectId: {
      type: "string",
      description: "Filter a list to one project; omitted lists every project.",
    },
    limit: {
      type: "number",
      minimum: 1,
      maximum: 100,
      description: "Maximum list entries (default 50).",
    },
  },
} as const;

const worktreeStatus = defineAgentTool<{
  worktreeId?: string;
  projectId?: string;
  limit?: number;
}>({
  name: "worktree_status",
  label: "Inspect managed worktrees",
  description:
    "List managed worktrees across projects (without expensive live git scans), or provide worktreeId for detail including live dirty, ahead/behind, merged and upstream status.",
  parameters: statusSchema as unknown as Record<string, unknown>,
  async execute(params) {
    if (params.worktreeId) {
      const row = await resolveWorktreeRow(params.worktreeId);
      if (!row || row.status !== "active") throw new Error("Unknown worktree.");
      return jsonResult({
        worktree: (await listWorktreeRecords(row.projectId)).find(
          (record) => record.id === row.id,
        ),
        status: await computeWorktreeStatus(row),
      });
    }
    const limit = Math.min(Math.max(params.limit ?? 50, 1), 100);
    const records = await listWorktreeRecords(params.projectId);
    return jsonResult({
      worktrees: records.slice(0, limit),
      ...(records.length > limit ? { truncated: true } : {}),
    });
  },
});

const setBaseSchema = {
  type: "object",
  additionalProperties: false,
  required: ["worktreeId", "baseBranch"],
  properties: {
    worktreeId: {
      type: "string",
      minLength: 1,
      description:
        "Active registered spawned worktree id. Synthetic main ids and paths are refused.",
    },
    baseBranch: {
      type: "string",
      minLength: 1,
      maxLength: 255,
      description:
        "Existing local branch to record as the merge-back and pull-request target. Remote refs, tags, unrelated histories and commit SHAs are refused.",
    },
  },
} as const;

const worktreeSetBase = defineAgentTool<{
  worktreeId: string;
  baseBranch: string;
}>({
  name: "worktree_set_base",
  label: "Set managed worktree base",
  description:
    "Change an active registered spawned worktree's recorded merge-back and future pull-request base to an existing local branch. The server records its common ancestor with the managed branch for whole-branch diffs. This changes PA metadata only: it does not rebase commits, push, or retarget an existing provider pull request. The result warns about open managed pull requests that still use their old base. It refuses synthetic main, a branch targeting itself, unrelated history, an in-progress merge, and a worktree another session may still be changing.",
  parameters: setBaseSchema as unknown as Record<string, unknown>,
  async execute(params, ctx) {
    const worktreeId = params.worktreeId?.trim();
    const baseBranch = params.baseBranch?.trim();
    if (!worktreeId) throw new Error("worktreeId is required.");
    if (!baseBranch) throw new Error("baseBranch is required.");
    if (isMainWorktreeId(worktreeId))
      throw new Error("The main checkout has no separate merge-back target.");

    const initial = await resolveWorktreeRow(worktreeId);
    if (!initial || initial.status !== "active")
      throw new Error("That active managed worktree is not available.");
    const release = reserveWorktreeForMutation(
      initial.id,
      ctx.session.sessionId,
      "The recorded base of this worktree is being changed.",
    );
    if (!release)
      throw new Error(
        "Another session is running or starting in this worktree. Wait until it is idle before changing the base.",
      );
    try {
      // Read warnings before the metadata mutation. A card-store read failure
      // must not turn a successful retarget into a thrown tool call.
      const openPullRequests = openPullRequestCards()
        .filter((card) => card.worktreeId === initial.id)
        .map((card) => ({
          provider: card.provider,
          number: card.number,
          url: card.url,
          baseBranch: card.baseBranch,
        }));
      const result = await changeWorktreeBase(
        initial.id,
        baseBranch,
        ctx.signal,
      );
      return jsonResult({
        ...result,
        ...(openPullRequests.length > 0
          ? {
              openPullRequests: openPullRequests.slice(0, 8),
              ...(openPullRequests.length > 8
                ? { openPullRequestsTruncated: true }
                : {}),
              warnings: [
                `${openPullRequests.length} open managed pull request${openPullRequests.length === 1 ? "" : "s"} still use${openPullRequests.length === 1 ? "s" : ""} the provider base recorded on the existing card${openPullRequests.length === 1 ? "" : "s"}. This metadata change did not retarget them; do not create another pull request until you inspect and settle the existing one${openPullRequests.length === 1 ? "" : "s"}.`,
              ],
            }
          : {}),
      });
    } finally {
      release();
    }
  },
});

const removeSchema = {
  type: "object",
  additionalProperties: false,
  required: ["worktreeId"],
  properties: {
    worktreeId: {
      type: "string",
      description: "Managed worktree id to remove.",
    },
    force: {
      type: "boolean",
      default: false,
      description:
        "Discard dirty files, unmerged work or an in-progress merge. It never overrides a live session mid-turn or a run starting; wait for those instead of retrying with force.",
    },
    reason: {
      type: "string",
      description: "Optional reason for this cleanup decision.",
    },
  },
} as const;

const worktreeRemove = defineAgentTool<{
  worktreeId: string;
  force?: boolean;
  reason?: string;
}>({
  name: "worktree_remove",
  label: "Remove managed worktree",
  description:
    "Remove any managed worktree and delete its branch. Force can discard data-loss guards, but cannot override a live session mid-turn or a run that is starting; wait for those concurrency guards instead.",
  parameters: removeSchema as unknown as Record<string, unknown>,
  async execute(params) {
    const row = await resolveWorktreeRow(params.worktreeId);
    if (!row) throw new Error("Unknown worktree.");
    const branchExisted = await localBranchExists(row);
    const status = params.force
      ? await computeWorktreeStatus(row, { force: true })
      : undefined;
    // Containment is independent of whether the checkout folder still exists
    // and recognizes squash/rebase delivery. It is the same guard force
    // overrides, so do not infer loss from the working-tree status scan.
    const unmergedCommits =
      params.force && branchExisted ? await unmergedCommitLoss(row) : 0;
    let branchCleanupError: WorktreeBranchCleanupError | undefined;
    let refusal: string | undefined;
    try {
      refusal = await removeWorktreeAndSettleSessions(row.id, {
        ...(params.force !== undefined ? { force: params.force } : {}),
        deleteBranch: true,
      });
    } catch (err) {
      if (err instanceof WorktreeBranchCleanupError) branchCleanupError = err;
      else throw err;
    }
    if (refusal) throw new Error(refusal);
    // A cleanup error can itself mean Git could not inspect the branch. Do not
    // probe it again and turn durable checkout removal into a thrown tool call.
    const branchDeleted = branchCleanupError
      ? null
      : branchExisted && !(await localBranchExists(row));
    const dirtyFiles = (status?.filesChanged ?? 0) + (status?.untracked ?? 0);
    const discarded =
      params.force &&
      (dirtyFiles > 0 || unmergedCommits === "unknown" || unmergedCommits > 0)
        ? { dirtyFiles, unmergedCommits }
        : undefined;
    return jsonResult({
      removed: true,
      worktreeId: row.id,
      branch: row.branch,
      branchDeleted,
      ...(params.reason ? { reason: params.reason } : {}),
      ...(discarded ? { discarded } : {}),
      ...(branchCleanupError
        ? {
            branchCleanupPending: true,
            branchCleanupError: branchCleanupError.message,
          }
        : {}),
    });
  },
});

export const worktreeTools = [
  worktreeCreate,
  worktreeStatus,
  worktreeSetBase,
  worktreeRemove,
];
