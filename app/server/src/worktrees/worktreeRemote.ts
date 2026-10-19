import type { WorktreeRow } from "../db/worktreeStore.ts";
import { gitOptional } from "../gitExec.ts";

export async function remoteNames(row: WorktreeRow): Promise<string[]> {
  return (await gitOptional(["remote"], row.path)).stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

/** The remote that carries the base branch, if the repository has one. */
export async function baseBranchRemote(
  row: WorktreeRow,
): Promise<string | undefined> {
  const configured = (
    await gitOptional(
      ["config", "--get", `branch.${row.baseBranch}.remote`],
      row.path,
    )
  ).stdout.trim();
  if (configured) return configured;
  const remotes = await remoteNames(row);
  if (remotes.includes("origin")) return "origin";
  if (remotes.length > 1) {
    // Never guess the authoritative base in a multi-remote repository.
    throw new Error(
      `Cannot rebase: "${row.baseBranch}" has no configured remote and this repository has several (${remotes.join(", ")}). Set branch.${row.baseBranch}.remote to say which one is the truth.`,
    );
  }
  return remotes[0];
}
