import type { TaskSummary } from "@assistant/shared";
import { taskSummaryOf, updateTask } from "./tasks.ts";
import { getWorktree } from "./db/worktreeStore.ts";
import {
  patchPullRequestCard,
  pullRequestCardsForWorktree,
} from "./pullRequestCards.ts";
import { removeWorktreeAndSettleSessions } from "./worktreeRemoval.ts";
import {
  WorktreeBranchCleanupError,
  WorktreeDirectoryResidueError,
} from "./worktrees/worktrees.ts";

export interface ManagedMergeFollowUpInput {
  worktreeId: string;
  number: number;
  sessionId: string;
  markTaskDone?: boolean;
  removeWorktree?: boolean;
  taskId?: string;
}

export interface ManagedMergeFollowUpResult {
  task?: { id: string; status: "done" };
  worktreeRemoved?: boolean;
  warnings: string[];
}

export interface ManagedMergeFollowUpOperations {
  markDone(taskId: string, sessionId: string, number: number): TaskSummary;
  remove(worktreeId: string): Promise<string | undefined>;
  projectTask?(worktreeId: string, task: TaskSummary): void;
  isRemoved?(worktreeId: string): boolean;
}

const defaultOperations: ManagedMergeFollowUpOperations = {
  markDone(taskId, sessionId, number) {
    return taskSummaryOf(
      updateTask(taskId, {
        status: "done",
        actor: { kind: "agent", id: sessionId },
        statusReason: `PR #${number} merged; caller requested Task completion`,
      }),
    );
  },
  isRemoved: (worktreeId) => getWorktree(worktreeId)?.status === "removed",
  projectTask(worktreeId, task) {
    for (const card of pullRequestCardsForWorktree(worktreeId)) {
      if (card.linkedTask?.id === task.id)
        patchPullRequestCard(card.id, { linkedTask: task });
    }
  },
  remove: (worktreeId) =>
    removeWorktreeAndSettleSessions(worktreeId, {
      force: false,
      deleteBranch: true,
    }),
};

/** Call only AFTER a confirmed provider merge and after releasing any mutation
 * reservation. Removal takes its own stricter hold, refusing even the caller's
 * running session. Each follow-up is independent and cannot undo the merge.
 */
export async function runManagedMergeFollowUps(
  input: ManagedMergeFollowUpInput,
  operations: ManagedMergeFollowUpOperations = defaultOperations,
): Promise<ManagedMergeFollowUpResult> {
  const result: ManagedMergeFollowUpResult = { warnings: [] };
  if (input.markTaskDone) {
    try {
      if (!input.taskId) throw new Error("No unique linked Task was selected");
      const task = operations.markDone(
        input.taskId,
        input.sessionId,
        input.number,
      );
      result.task = { id: task.id, status: "done" };
      try {
        operations.projectTask?.(input.worktreeId, task);
      } catch (error) {
        result.warnings.push(
          `The Task is done, but its PR card could not be refreshed: ${errorText(error)}.`,
        );
      }
    } catch (error) {
      result.warnings.push(
        `The linked Task was not marked done: ${errorText(error)}.`,
      );
    }
  }
  if (input.removeWorktree) {
    try {
      const refusal = await operations.remove(input.worktreeId);
      result.worktreeRemoved = !refusal;
      if (refusal) result.warnings.push(`The worktree was kept: ${refusal}`);
    } catch (error) {
      // These typed failures prove the checkout is already durably removed.
      // Only branch cleanup or directory residue remains to be dealt with.
      result.worktreeRemoved =
        error instanceof WorktreeBranchCleanupError ||
        error instanceof WorktreeDirectoryResidueError ||
        operations.isRemoved?.(input.worktreeId) === true;
      result.warnings.push(
        `${result.worktreeRemoved ? "The worktree was removed, but cleanup needs attention" : "The worktree was kept"}: ${errorText(error)}.`,
      );
    }
  }
  return result;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
