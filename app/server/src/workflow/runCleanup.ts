/**
 * Explicit cleanup for a cancelled Workflow Run.
 *
 * Cancellation remains the safe, reversible stop: it preserves history and
 * resources. This service is the separate irreversible follow-up. It can first
 * discard the owned checkout/branch and archive the sessions, then deletes the
 * cancelled run and its cascading step/event history. Any checkout refusal
 * leaves the run intact so the user can repair the blocker and retry.
 */
import { sessionStore } from "../db/sessionStore.ts";
import {
  deleteCancelledRun,
  getRun,
  listSteps,
  type WorkflowRunRow,
} from "../db/workflowStore.ts";
import {
  getWorktree,
  sessionIdsForWorktree,
  type WorktreeRow,
} from "../db/worktreeStore.ts";
import { removeWorktreeAndSettleSessions } from "../worktreeRemoval.ts";
import { broadcastWorkflowRuns } from "../workflowRuns.ts";

export interface DeleteCancelledWorkflowRunOptions {
  deleteWorktree: boolean;
  archiveSessions: boolean;
}

interface RunCleanupOperations {
  getRun(runId: number): WorkflowRunRow | null;
  getWorktree(worktreeId: string): WorktreeRow | undefined;
  workflowSessionIds(runId: number): string[];
  worktreeSessionIds(worktreeId: string): string[];
  removeWorktree(worktreeId: string): Promise<string | undefined>;
  archiveSessions(sessionIds: readonly string[]): Promise<void>;
  deleteRun(runId: number): void;
  broadcastRuns(): void;
}

const defaultOperations: RunCleanupOperations = {
  getRun,
  getWorktree,
  workflowSessionIds: (runId) => [
    ...new Set(
      listSteps(runId).flatMap((step) =>
        step.executor?.kind === "session" ? [step.executor.id] : [],
      ),
    ),
  ],
  worktreeSessionIds: sessionIdsForWorktree,
  removeWorktree: (worktreeId) =>
    removeWorktreeAndSettleSessions(worktreeId, {
      deleteBranch: true,
      force: true,
    }),
  archiveSessions: async (sessionIds) => {
    for (const sessionId of sessionIds)
      sessionStore.setArchived(sessionId, true);
    if (sessionIds.length === 0) return;
    const { hub } = await import("../hub.ts");
    await hub.broadcastSessions();
  },
  deleteRun: deleteCancelledRun,
  broadcastRuns: broadcastWorkflowRuns,
};

/**
 * Delete one cancelled run, optionally cleaning up the resources it created.
 * The options are explicit booleans because omission must never turn into
 * accidental checkout deletion or session archival at this irreversible seam.
 */
export async function deleteCancelledWorkflowRun(
  runId: number,
  options: DeleteCancelledWorkflowRunOptions,
  operations: RunCleanupOperations = defaultOperations,
): Promise<void> {
  const run = operations.getRun(runId);
  if (!run) throw new Error(`workflow run ${runId} does not exist`);
  if (run.lifecycle !== "cancelled")
    throw new Error(
      `workflow run ${runId} is ${run.lifecycle}; only a cancelled run can be deleted`,
    );

  const sessionIds = new Set(operations.workflowSessionIds(runId));
  if (run.worktreeId) {
    if (options.archiveSessions)
      for (const sessionId of operations.worktreeSessionIds(run.worktreeId))
        sessionIds.add(sessionId);

    if (options.deleteWorktree) {
      const worktree = operations.getWorktree(run.worktreeId);
      // A previously removed checkout is already clean. A retained cleanup oid
      // means only branch deletion failed, and the ordinary removal service is
      // precisely the identity-bound retry path for it.
      if (
        worktree &&
        (worktree.status === "active" || Boolean(worktree.branchCleanupOid))
      ) {
        const refusal = await operations.removeWorktree(run.worktreeId);
        if (refusal) throw new Error(refusal);
      }
    }
  }

  if (options.archiveSessions)
    await operations.archiveSessions([...sessionIds]);
  operations.deleteRun(runId);
  operations.broadcastRuns();
}
