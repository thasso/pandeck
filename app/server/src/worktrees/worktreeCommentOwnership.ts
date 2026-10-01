import { gitOptional } from "../gitExec.ts";
import {
  listWorktrees,
  type WorktreeCommentRow,
  type WorktreeRow,
} from "../db/worktreeStore.ts";

type CommentOwner = Pick<
  WorktreeCommentRow,
  "ownerWorktreeId" | "ownerBranch" | "ownerSource"
>;

interface MergeStateLike {
  phase?: string;
  startedAt?: number;
}

/**
 * Capture whose branch a synthetic-main root reviews while that identity is
 * still knowable. Failure or ambiguity deliberately produces no owner: comment
 * creation must never depend on this best-effort read-only classification.
 */
export async function captureMainCommentOwner(
  mainRow: WorktreeRow,
  anchorCommit: string | null,
): Promise<CommentOwner | undefined> {
  try {
    const candidates = listWorktrees({ projectId: mainRow.projectId }).filter(
      (candidate) => candidate.mainRepoRoot === mainRow.mainRepoRoot,
    );

    const inFlight = candidates
      .map((candidate) => ({ candidate, state: mergeState(candidate) }))
      .filter(
        ({ state }) =>
          state?.phase === "merging" ||
          state?.phase === "conflicts" ||
          state?.phase === "agent_resolving",
      )
      .sort(
        (left, right) =>
          (right.state?.startedAt ?? 0) - (left.state?.startedAt ?? 0),
      );
    const merging = inFlight[0]?.candidate;
    if (merging)
      return {
        ownerWorktreeId: merging.id,
        ownerBranch: merging.branch,
        ownerSource: "merge-in-flight",
      };

    if (!anchorCommit) return undefined;
    const refs = await gitOptional(
      [
        "for-each-ref",
        "--format=%(refname:short)",
        "--contains",
        anchorCommit,
        "refs/heads",
      ],
      mainRow.mainRepoRoot,
    );
    if (refs.code !== 0) return undefined;
    const containingBranches = new Set(
      refs.stdout
        .split("\n")
        .map((branch) => branch.trim())
        .filter(Boolean),
    );
    const exclusive = candidates.filter(
      (candidate) =>
        containingBranches.has(candidate.branch) &&
        !containingBranches.has(candidate.baseBranch),
    );
    if (exclusive.length !== 1) return undefined;
    const owner = exclusive[0]!;
    return {
      ownerWorktreeId: owner.id,
      ownerBranch: owner.branch,
      ownerSource: "branch-exclusive",
    };
  } catch {
    return undefined;
  }
}

function mergeState(row: WorktreeRow): MergeStateLike | undefined {
  if (!row.mergeStateJson) return undefined;
  try {
    return JSON.parse(row.mergeStateJson) as MergeStateLike;
  } catch {
    return undefined;
  }
}
