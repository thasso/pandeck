/**
 * The local checkout of a pull request, as the Pull Requests view's two menu
 * actions drive it.
 *
 * Both act through `POST /api/pull-requests/checkout` — create or update the
 * local worktree standing on this pull request's head branch — and differ only
 * in what they do with the answer. **Create worktree** stops there and says
 * what it did. **Review** goes on to the STAGED new-session composer with a
 * review prompt prefilled; that hand-off is the host's (`App.tsx` owns
 * staging), and what is here is the request and the busy flag the row wears
 * (R5).
 *
 * Rules they share with `usePullRequestMergeCleanup`:
 *
 *  - every field is bound to ONE pull request's four-component identity, so
 *    navigating A → B never shows B something A's attempt established;
 *  - the act converges: a create whose answer was lost is found by the next
 *    attempt as the existing checkout and merely brought up to date, so the
 *    control stays a retry and a failure says exactly that.
 *
 * Where the answer lands follows the inspector's rule for a row act
 * (`worktree/WorktreeDelivery.tsx`): a menu row has no durable inline failure
 * surface — on a wide layout the menu closed when the row was chosen, and the
 * dock's row is a button, not a place a failure can wait to be found — so its
 * outcome, good or bad, travels as a toast NAMING the pull request. The review's success is the one silent case: the navigation
 * is the confirmation, and a toast over the composer would announce what the
 * user is already looking at. Only when its surface is GONE by the time the
 * answer lands does the review speak instead of navigating, with the hand-off
 * as the toast's action, which is the case `docs/messaging.md` reserves a
 * toast for.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type {
  PullRequestCheckoutOutcome,
  PullRequestInventoryItem,
} from "@assistant/shared";
import { pullRequestRowId } from "../../lib/pullRequestInbox.ts";
import { checkoutPullRequestFromView } from "../../lib/pullRequestsApi.ts";
import { showToast, TOAST_DWELL_MS } from "../../lib/toast.ts";

/**
 * What Review hands back once a pull request's checkout exists: the item the
 * row was on, the SERVER's worktree id, and what the checkout actually did —
 * so the host can describe it instead of assuming a create.
 */
export type PullRequestReviewHandoff = (
  item: PullRequestInventoryItem,
  worktreeId: string,
  outcome: PullRequestCheckoutOutcome,
) => void;

export interface PullRequestCheckoutAction {
  /** Check the pull request out, then settle the answer. */
  start: () => void;
  /** The checkout is running; the initiating row busies on it (R5). */
  busy: boolean;
}

/** A checkout that exists and stands on the pull request's head branch. */
type PullRequestCheckoutReady = Exclude<
  PullRequestCheckoutOutcome,
  { status: "refused" }
>;

interface CheckoutState {
  /** The pull request this state is ABOUT, as `pullRequestRowId` writes it. */
  key: string;
  busy: boolean;
}

const NOTHING: CheckoutState = { key: "", busy: false };

/**
 * The request and the busy flag, shared by both actions. `onReady` receives
 * every non-refused outcome; a refusal and a transport failure are stated on
 * the toast here, because the two actions say the same thing about them.
 */
function usePullRequestCheckout({
  item,
  onReady,
}: {
  item: PullRequestInventoryItem | null;
  onReady: (
    item: PullRequestInventoryItem,
    outcome: PullRequestCheckoutReady,
  ) => void;
}): PullRequestCheckoutAction {
  const [state, setState] = useState<CheckoutState>(NOTHING);
  const key = item ? pullRequestRowId(item) : undefined;
  // The identity guard, in one place: state that is not about THIS pull request
  // is not this pull request's state.
  const mine = key !== undefined && state.key === key ? state : NOTHING;

  const start = useCallback(() => {
    if (!item || !key) return;
    setState({ key, busy: true });
    void (async () => {
      try {
        const answer = await checkoutPullRequestFromView({
          projectId: item.projectId,
          provider: item.provider,
          repositoryKey: item.repositoryKey,
          number: item.number,
        });
        setState({ key, busy: false });
        if (answer.outcome.status === "refused") {
          showToast(`#${item.number}: ${answer.outcome.reason}`, {
            tone: "error",
            durationMs: TOAST_DWELL_MS,
          });
          return;
        }
        onReady(item, answer.outcome);
      } catch (err) {
        // A refusal the server ANSWERED and a response that never came back are
        // told apart by nothing here, deliberately: both leave the checkout in
        // a state the next attempt reads for itself, and the sentence says so
        // rather than claiming which of the two this was.
        setState({ key, busy: false });
        showToast(
          `The checkout for #${item.number} did not complete: ${
            err instanceof Error ? err.message : String(err)
          } Trying again picks up a checkout that was created.`,
          { tone: "error", durationMs: TOAST_DWELL_MS },
        );
      }
    })();
  }, [item, key, onReady]);

  return { start, busy: mine.busy };
}

/**
 * Review: the checkout, then the hand-off to the staged composer.
 */
export function usePullRequestReview({
  item,
  onReady,
}: {
  item: PullRequestInventoryItem | null;
  /**
   * The checkout exists and stands on this pull request's head branch. The
   * worktree id is the SERVER's, from the outcome — never one this surface had
   * lying around — and `outcome` travels with it so the host describes what
   * actually happened rather than what it hoped for.
   */
  onReady: PullRequestReviewHandoff;
}): PullRequestCheckoutAction {
  /**
   * Whether the surface this act belongs to is still on screen. A checkout
   * takes seconds and the panel is keyed by the pull request, so moving to
   * another one — or out of the section — unmounts it mid-flight. NAVIGATING
   * then would yank the reader into a composer for something they have left.
   */
  const live = useRef(true);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);
  return usePullRequestCheckout({
    item,
    onReady: useCallback(
      (target, outcome) => {
        if (!live.current) {
          showToast(
            `#${target.number}: the checkout of ${outcome.branch} is ready.`,
            {
              tone: "success",
              durationMs: TOAST_DWELL_MS,
              action: {
                label: "Review it",
                onClick: () => onReady(target, outcome.worktreeId, outcome),
              },
            },
          );
          return;
        }
        onReady(target, outcome.worktreeId, outcome);
      },
      [onReady],
    ),
  });
}

/**
 * Create worktree: the checkout alone. What it did is said in the server's
 * terms — created, brought to the head, or already there — with the next step
 * as the toast's action, and the inventory is refetched so the page's local
 * join shows the checkout it now has.
 */
export function usePullRequestWorktree({
  item,
  onDone,
  onStartSession,
}: {
  item: PullRequestInventoryItem | null;
  /** Something changed on the server — refetch the projection that shows it. */
  onDone: () => void;
  onStartSession: (worktreeId: string) => void;
}): PullRequestCheckoutAction {
  return usePullRequestCheckout({
    item,
    onReady: useCallback(
      (target, outcome) => {
        onDone();
        showToast(`#${target.number}: ${checkoutSentence(outcome)}`, {
          tone: "success",
          durationMs: TOAST_DWELL_MS,
          action: {
            label: "Start session",
            onClick: () => onStartSession(outcome.worktreeId),
          },
        });
      },
      [onDone, onStartSession],
    ),
  });
}

/** What the checkout DID, never what was asked for. */
function checkoutSentence(outcome: PullRequestCheckoutReady): string {
  switch (outcome.status) {
    case "created":
      return `created the checkout of ${outcome.branch}.`;
    case "updated":
      return `brought the checkout of ${outcome.branch} to the pull request's head.`;
    case "already-current":
      return `the checkout of ${outcome.branch} is already at the pull request's head.`;
  }
}
