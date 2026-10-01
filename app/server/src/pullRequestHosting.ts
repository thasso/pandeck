/**
 * Which checkout a live PR card speaks for, once its own is gone.
 *
 * A card's `repoRoot` is the spawned worktree the pull request was published
 * from, and removing that worktree is the ORDINARY end of a delivery — the card
 * outlives it, because the pull request lives on the provider. Every later use
 * of that path then answers nothing: `hostingProviderForRepo` resolves no
 * provider, so the watcher froze the card in `open` for good and a Workflow Run
 * parked on its merge decision could never be superseded — an inbox item that
 * could be neither answered nor settled — while `repoLockKey` degraded to the
 * deleted path itself, which matches no other checkout of the repository.
 *
 * ONE rule answers all of it: the recorded checkout while it exists, and the
 * main checkout it was forked from once it does not. The worktree row survives
 * removal and remembers that root, and since every worktree of a repository
 * shares one git directory, it carries the same remotes — including the named
 * push remote a managed delivery recorded — and the same lock identity. Nothing
 * changes for a card whose worktree is still there.
 */
import { existsSync } from "node:fs";
import { getWorktree } from "./db/worktreeStore.ts";

export interface PullRequestCardRepoTarget {
  /** The checkout recorded on the card's context when it was created. */
  repoRoot: string;
  /** The worktree it was published from, when it was published from one. */
  worktreeId?: string;
}

/**
 * The checkout that stands for this card's repository now. Used for provider
 * resolution, for the per-pull-request mutation identity, and for matching a
 * card to a pull request — they must agree, or a merge would reach a provider
 * through one repository and project onto cards keyed to another.
 */
export function pullRequestCardRepoRoot(
  target: PullRequestCardRepoTarget,
): string {
  if (existsSync(target.repoRoot)) return target.repoRoot;
  const main = target.worktreeId
    ? getWorktree(target.worktreeId)?.mainRepoRoot
    : undefined;
  return main ?? target.repoRoot;
}
