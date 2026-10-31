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
 *
 * The answer names the side with the root, and the presence read runs on that
 * side's Worker, not the server's filesystem (`docs/workers.md`).
 */
import { checkoutFilesOn } from "./checkoutFileAccess.ts";
import { getWorktree } from "./db/worktreeStore.ts";
import { sessionCheckoutSide, type CheckoutSide } from "./workers/placement.ts";
import { checkoutSideOf } from "./worktrees/knowledgeCheckout.ts";
import { mainWorktreeId } from "./worktrees/worktreeResolve.ts";

export interface PullRequestCardRepoTarget {
  /** The checkout recorded on the card's context when it was created. */
  repoRoot: string;
  /** The worktree it was published from, when it was published from one. */
  worktreeId?: string;
  /** The session the card belongs to; a card without a worktree is its path. */
  sessionId: string;
}

/** A card's checkout: the root and the side its git and reads run on. */
export interface PullRequestCardCheckout {
  side: CheckoutSide;
  repoRoot: string;
}

/**
 * The side of the checkout recorded on a card: its worktree's, else its
 * session's, since a card without a worktree was published from its session's
 * path.
 */
export function pullRequestCardSide(
  target: Pick<PullRequestCardRepoTarget, "worktreeId" | "sessionId">,
): CheckoutSide {
  return target.worktreeId
    ? checkoutSideOf({ id: target.worktreeId })
    : sessionCheckoutSide(target.sessionId);
}

/**
 * The checkout that stands for this card's repository now. Used for provider
 * resolution, for the per-pull-request mutation identity, and for matching a
 * card to a pull request — they must agree, or a merge would reach a provider
 * through one repository and project onto cards keyed to another.
 *
 * With {@link pullRequestCardSide}, the one place a card's side is derived:
 * the recorded side, and the main checkout's once it falls back to that. The
 * presence read runs on the recorded side; a Worker failure rejects rather
 * than choosing a root.
 */
export async function pullRequestCardCheckout(
  target: PullRequestCardRepoTarget,
): Promise<PullRequestCardCheckout> {
  const recorded = pullRequestCardSide(target);
  if (
    await checkoutFilesOn(recorded).pathExists(target.repoRoot, target.repoRoot)
  )
    return { side: recorded, repoRoot: target.repoRoot };
  const row = target.worktreeId ? getWorktree(target.worktreeId) : undefined;
  if (row)
    return {
      side: checkoutSideOf({ id: mainWorktreeId(row.projectId) }),
      repoRoot: row.mainRepoRoot,
    };
  return { side: recorded, repoRoot: target.repoRoot };
}
