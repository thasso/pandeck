import { pathToFileURL } from "node:url";
import { closeDb } from "./index.ts";
import {
  deleteOrphanedWorktreeComments,
  listOrphanedWorktreeComments,
  type OrphanedWorktreeComments,
} from "./worktreeStore.ts";

export interface WorktreeCommentSweepResult {
  candidates: OrphanedWorktreeComments[];
  totalComments: number;
  deletedComments: number;
  dryRun: boolean;
}

/**
 * Find comments left behind by historical worktree removals. Destruction is
 * opt-in so callers must first present the dry-run report for human review.
 */
export function sweepOrphanedWorktreeComments(
  options: { deleteComments?: boolean } = {},
): WorktreeCommentSweepResult {
  const deleteComments = options.deleteComments === true;
  const deletion = deleteComments
    ? deleteOrphanedWorktreeComments()
    : { candidates: listOrphanedWorktreeComments(), deletedComments: 0 };
  const totalComments = deletion.candidates.reduce(
    (total, candidate) => total + candidate.commentCount,
    0,
  );
  return {
    candidates: deletion.candidates,
    totalComments,
    deletedComments: deletion.deletedComments,
    dryRun: !deleteComments,
  };
}

export function formatWorktreeCommentSweep(
  result: WorktreeCommentSweepResult,
): string {
  const lines = [
    result.dryRun
      ? "Worktree comment orphan sweep (dry run; nothing was deleted)"
      : "Worktree comment orphan sweep (DELETE enabled)",
  ];
  if (result.candidates.length === 0) {
    lines.push("No orphaned worktree comments found.");
  } else {
    for (const candidate of result.candidates) {
      const branch = candidate.branch ?? "<missing worktree>";
      const removedAt =
        candidate.removedAt === null
          ? "<unknown>"
          : new Date(candidate.removedAt).toISOString();
      lines.push(
        `${candidate.worktreeId} -> (branch=${branch}, removedAt=${removedAt}, comments=${candidate.commentCount})`,
      );
    }
  }
  lines.push(`Total comments: ${result.totalComments}`);
  if (!result.dryRun) lines.push(`Deleted comments: ${result.deletedComments}`);
  else if (result.totalComments > 0)
    lines.push(
      "Review this list, then rerun with --delete only if every entry should be purged.",
    );
  return `${lines.join("\n")}\n`;
}

function main(): void {
  const args = process.argv.slice(2);
  if (args.includes("--help")) {
    process.stdout.write(
      "Usage: pnpm --filter @assistant/server worktree-comments:sweep [--delete]\n",
    );
    return;
  }
  const unknown = args.filter((arg) => arg !== "--delete");
  if (unknown.length > 0)
    throw new Error(`Unknown argument(s): ${unknown.join(", ")}`);
  const result = sweepOrphanedWorktreeComments({
    deleteComments: args.includes("--delete"),
  });
  process.stdout.write(formatWorktreeCommentSweep(result));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  } finally {
    closeDb();
  }
}
