import {
  ArchiveX,
  GitMerge,
  MessageSquarePlus,
  SendHorizontal,
  Trash2,
} from "lucide-react";
import type { WorktreeRecord } from "@assistant/shared";
import type { InspectorAction } from "../shell/Inspector.tsx";

/**
 * Inspector actions for a worktree. The main checkout (`isMain`) is read +
 * session only: Merge back, Remove and Retire stay listed there, disabled with
 * the reason, so every worktree offers the same actions in the same places.
 *
 * Ordering is the panel's, not each caller's: what you do to the WORK
 * (delivery: commit, push, sync, PR) sits between starting a session and the
 * irreversible lifecycle acts, because delivery no longer owns an actions list
 * of its own.
 */
export function worktreeInspectorActions(
  worktree: WorktreeRecord,
  handlers: {
    onStartSession: (id: string) => void;
    onMerge: (id: string) => void;
    onRemove: (id: string) => void;
    onRetire: () => void;
    /** A retirement is running; only its own action busies (R5). */
    retireBusy?: boolean;
    onSubmitReview?: () => void;
    pendingReviewCount?: number;
    /** The delivery actions from `useWorktreeDelivery`, already state-filtered. */
    deliveryActions?: InspectorAction[];
  },
): InspectorAction[] {
  const pendingReviewCount = Math.max(0, handlers.pendingReviewCount ?? 0);
  return [
    {
      key: "start-session",
      primary: true,
      icon: <MessageSquarePlus size={14} />,
      // The object the panel is about is the worktree: the label says the ACT,
      // not where it lands.
      label: "Start session",
      onRun: () => handlers.onStartSession(worktree.id),
    },
    ...(handlers.deliveryActions ?? []),
    // Always listed; on the main checkout, which IS the base, disabled.
    ...[
      {
        key: "merge",
        icon: <GitMerge size={14} />,
        label: "Merge back…",
        onRun: () => handlers.onMerge(worktree.id),
      },
      {
        key: "remove",
        icon: <Trash2 size={14} />,
        label: "Remove worktree…",
        onRun: () => handlers.onRemove(worktree.id),
      },
      {
        // Retire is the END of a branch's life, and a different act from
        // Remove: it refreshes the merge target, VERIFIES this branch is
        // delivered into it, settles the sessions working here and only then
        // deletes the checkout and the branch. Remove does none of that
        // verification — it never fetches — so the two are not one action
        // with a flag, and neither replaces the other.
        key: "retire",
        icon: <ArchiveX size={14} />,
        label: "Retire worktree…",
        busy: handlers.retireBusy ?? false,
        onRun: () => handlers.onRetire(),
      },
    ].map((action) =>
      worktree.isMain
        ? {
            ...action,
            disabled: true,
            disabledReason: "Not for the main checkout",
          }
        : action,
    ),
    // Only while there is something unsent: the batch is DERIVED from the
    // comments no session has been handed, so with nothing pending this action
    // would send nothing at all.
    ...(handlers.onSubmitReview && pendingReviewCount > 0
      ? [
          {
            key: "submit-review",
            icon: <SendHorizontal size={14} />,
            label: "Submit review",
            onRun: handlers.onSubmitReview,
            hint: `${pendingReviewCount} comment${pendingReviewCount === 1 ? "" : "s"}`,
            commentActuation: true,
          },
        ]
      : []),
  ];
}
