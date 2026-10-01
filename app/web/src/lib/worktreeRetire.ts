/**
 * The two rules a retirement's SURFACE has to get right, in one place, because
 * more than one surface now performs one: the worktree inspector's Retire
 * (`components/worktree/useWorktreeRetire.tsx`) and the Pull Requests view's
 * Merge & clean up, whose cleanup half IS a retirement
 * (`app/server/src/worktreeRemoval.ts`, one sequence for both).
 *
 * 1. WHICH REFUSAL CONSENT MAY ANSWER. Retirement verifies delivery by fetching
 *    the base and comparing against that exact commit; `force` is the licence to
 *    skip that check and nothing else. So a `"delivery"` or `"git-guard"`
 *    refusal is escalatable and a `"sessions"` one is not — `force` never
 *    overrides a running or waiting session, and offering consent there would be
 *    a checkbox that buys nothing. `"permissions"` is the same kind of nothing:
 *    the checkout holds files another user owns (a container that wrote into the
 *    bind-mounted tree as root, typically), and no answer this app can give
 *    makes them deletable.
 * 2. WHAT THE RUN ACTUALLY DID. Force and keeping the branch both SKIP
 *    containment, so only the server knows whether the question was answered.
 *    Four outcomes, never one sentence: a checkout-only retirement claims no
 *    delivery either way; a verified deletion says so; a FORCED deletion says
 *    the check was skipped, because that is what force decided; and an unforced
 *    deletion that established nothing says only that — never that the branch
 *    was undelivered, which `deliveryVerified: false` does not mean.
 *
 * Framework-free on purpose: this is the wording two components must not drift
 * on, not a hook.
 */
import type { WorktreeRetireRefusalKind } from "@assistant/shared";

/** Whether `force` is an answer to this refusal at all. */
export function retireRefusalEscalatable(
  refusalKind: WorktreeRetireRefusalKind,
): boolean {
  return refusalKind !== "sessions" && refusalKind !== "permissions";
}

/** What a retirement answered, as far as its outcome sentence is concerned. */
export interface RetiredWorktreeFacts {
  branch: string;
  baseBranch: string;
  branchDeleted: boolean;
  deliveryVerified: boolean;
  settledSessions: number;
}

/** The ONE sentence that reports a completed retirement. */
export function retireOutcomeMessage(
  facts: RetiredWorktreeFacts,
  options: { forced: boolean },
): string {
  const outcome = !facts.branchDeleted
    ? `Removed the ${facts.branch} checkout and kept the local branch`
    : facts.deliveryVerified
      ? `Removed ${facts.branch} after verifying delivery into ${facts.baseBranch}, deleted the local branch`
      : options.forced
        ? `Removed ${facts.branch} and deleted the local branch WITHOUT verifying delivery into ${facts.baseBranch}`
        : `Removed ${facts.branch} and deleted the local branch without a confirmed delivery check against ${facts.baseBranch}`;
  return `${outcome}, settled ${facts.settledSessions} ${
    facts.settledSessions === 1 ? "session" : "sessions"
  }.`;
}
