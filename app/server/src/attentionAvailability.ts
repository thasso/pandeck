/**
 * Whether a session's human-blocking attention can be KNOWN right now.
 *
 * While a card store's legacy import has not finished, its read-only answers
 * degrade to empty so the list and views stay readable (`pendingApprovals.ts`,
 * `pullRequestCards.ts`). Empty is not "nothing pending" there, so every
 * decision that ACTS on attention — settling a session or a cluster, removing
 * a worktree that settles its sessions, archiving settled sessions — asks this
 * first and treats unknown as blocking. The projections themselves are not
 * faked: a made-up pending approval would put wrong badges in the UI.
 */
import { approvalStoreUnavailable } from "./pendingApprovals.ts";
import { pullRequestCardStoreUnavailable } from "./pullRequestCards.ts";

/**
 * Why attention cannot be ruled out, as a settle-reason fragment ("it is still
 * running." style), or `undefined` when both stores can be read.
 */
export function attentionUnknownReason(): string | undefined {
  if (approvalStoreUnavailable())
    return "the approval store is unavailable, so a pending approval cannot be ruled out.";
  if (pullRequestCardStoreUnavailable())
    return "the pull-request card store is unavailable, so a pending Task pick cannot be ruled out.";
  return undefined;
}
