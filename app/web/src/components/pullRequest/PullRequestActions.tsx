/**
 * @component PullRequestActionsProvider
 * @purpose ONE owner for the acts on the pull request the route shows — review,
 * create/update the worktree, merge & clean up — read by every surface that
 * offers them: the object panel's Actions list and the detail page's inline
 * buttons.
 * @useWhen Wrapping the app shell, so the page and the panel both sit under it.
 * @avoidWhen Acting on a pull request from a `/pr` card or a worktree page —
 * those are card- and worktree-bound and have their own flows.
 * @intent Two surfaces with their own hook instances would be two busy flags
 * and two merge dialogs for one pull request, and a refusal shown in one would
 * be invisible to the other. The flows are owned by a HOST keyed by the pull
 * request, exactly as the panel used to own them, so moving to another pull
 * request unmounts the old one mid-flight — a review checkout that lands after
 * that becomes a toast instead of a navigation (`usePullRequestReview`), and no
 * consent-bearing refusal survives into another pull request. The host is a
 * SIBLING of the shell, never its parent, so that keying remounts nothing else.
 * @related PullRequestInspector, PullRequestDetailPage,
 * usePullRequestMergeCleanup, usePullRequestCheckout
 */
import {
  createContext,
  useContext,
  useLayoutEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import type { PullRequestInventoryItem } from "@assistant/shared";
import { pullRequestRowId } from "../../lib/pullRequestInbox.ts";
import {
  usePullRequestReview,
  usePullRequestWorktree,
  type PullRequestCheckoutAction,
  type PullRequestReviewHandoff,
} from "./usePullRequestCheckout.tsx";
import { usePullRequestMergeCleanup } from "./usePullRequestMergeCleanup.tsx";

export interface PullRequestActions {
  /** The pull request these acts are bound to (`pullRequestRowId`). */
  key: string;
  /** Check the head out (if needed), then stage a review session. */
  review: PullRequestCheckoutAction;
  /** Create or update the local worktree, without a session. */
  checkout: PullRequestCheckoutAction;
  /** Merge & clean up (Clean up for a terminal pull request). */
  merge: {
    open: () => void;
    busy: boolean;
    /** The last attempt's outcome is unknown: offer "Check again" instead. */
    suspended: boolean;
  };
  startSession: (worktreeId: string) => void;
}

const PullRequestActionsContext = createContext<PullRequestActions | null>(
  null,
);

/**
 * The acts for THIS pull request, or `null` when no host serves it — which a
 * surface renders as no buttons rather than buttons that do nothing.
 */
export function usePullRequestActions(
  item: PullRequestInventoryItem | null,
): PullRequestActions | null {
  const actions = useContext(PullRequestActionsContext);
  if (!actions || !item) return null;
  return actions.key === pullRequestRowId(item) ? actions : null;
}

export function PullRequestActionsProvider({
  item,
  onReload,
  onStartSession,
  onReview,
  children,
}: {
  /** The routed pull request; `null` off a pull request route. */
  item: PullRequestInventoryItem | null;
  /** Something changed on the server — refetch the inventory that shows it. */
  onReload: () => void;
  onStartSession: (worktreeId: string) => void;
  /** The checkout exists — hand the review off to the staged composer. */
  onReview: PullRequestReviewHandoff;
  children: ReactNode;
}) {
  const [published, setPublished] = useState<PullRequestActions | null>(null);
  const key = item ? pullRequestRowId(item) : null;
  return (
    <PullRequestActionsContext.Provider
      value={published && published.key === key ? published : null}
    >
      {children}
      {item && key ? (
        <PullRequestActionsHost
          key={key}
          item={item}
          onReload={onReload}
          onStartSession={onStartSession}
          onReview={onReview}
          onPublish={setPublished}
        />
      ) : null}
    </PullRequestActionsContext.Provider>
  );
}

function PullRequestActionsHost({
  item,
  onReload,
  onStartSession,
  onReview,
  onPublish,
}: {
  item: PullRequestInventoryItem;
  onReload: () => void;
  onStartSession: (worktreeId: string) => void;
  onReview: PullRequestReviewHandoff;
  onPublish: (
    update: (current: PullRequestActions | null) => PullRequestActions | null,
  ) => void;
}) {
  const key = pullRequestRowId(item);
  const merge = usePullRequestMergeCleanup({ item, onDone: onReload });
  const review = usePullRequestReview({ item, onReady: onReview });
  const checkout = usePullRequestWorktree({
    item,
    onDone: onReload,
    onStartSession,
  });
  const actions = useMemo<PullRequestActions>(
    () => ({
      key,
      review: { start: review.start, busy: review.busy },
      checkout: { start: checkout.start, busy: checkout.busy },
      merge: {
        open: merge.open,
        busy: merge.busy,
        suspended: merge.suspended,
      },
      startSession: onStartSession,
    }),
    [
      key,
      review.start,
      review.busy,
      checkout.start,
      checkout.busy,
      merge.open,
      merge.busy,
      merge.suspended,
      onStartSession,
    ],
  );
  useLayoutEffect(() => {
    onPublish(() => actions);
  }, [actions, onPublish]);
  // Withdraw only what is OURS: the next pull request's host may already have
  // published by the time this one's cleanup runs.
  useLayoutEffect(
    () => () => onPublish((current) => (current?.key === key ? null : current)),
    [key, onPublish],
  );
  // The dialog renders here, once, whichever surface opened it.
  return <>{merge.dialog}</>;
}
