/**
 * The worktree side of a REVIEW: the adapter into the domain-neutral review shape
 * (`../review/`) and the submit sheet with this domain's wording.
 *
 * Deliberately free of the `diff/` stack: the lazy worktree page consumes the
 * pending-id projection while `App.tsx` owns only the submit sheet. Importing
 * `diff/` here would pull Pierre + Shiki into the main bundle.
 */
import type {
  SessionListItem,
  WorktreeComment,
  WorktreeRecord,
} from "@assistant/shared";
import {
  SendCommentsSheet,
  type SendCommentsSession,
  type SendCommentsTarget,
} from "../review/SendCommentsSheet.tsx";
import { useRoutePrimaryAction } from "../shell/RoutePrimaryAction.tsx";
import {
  firstLineOf,
  pendingReviewThreadIds,
  type ReviewThreadView,
} from "../review/reviewThread.ts";

/**
 * Project worktree threads into the domain-neutral review shape. A worktree
 * anchor is `path:line` on the additions side, and `attachedSessionId` is this
 * domain's record of having been handed to an agent — which is what "pending"
 * reads.
 */
export function worktreeReviewThreads(
  comments: WorktreeComment[],
  onOpenLocation?: (path: string) => void,
): ReviewThreadView[] {
  const roots = comments.filter((comment) => !comment.parentId);
  return roots.map((root) => {
    const orphaned = root.anchorState === "orphaned" || !root.current;
    return {
      id: root.id,
      state: root.resolvedAt === undefined ? "open" : "resolved",
      orphaned,
      moved: root.anchorState === "moved",
      firstLine: firstLineOf(root.body),
      anchorLabel: root.current
        ? `${root.current.path}:${root.current.line}`
        : `${root.anchor?.path ?? "?"} · gone`,
      author: root.author.kind === "agent" ? "agent" : "you",
      replies: comments.filter((comment) => comment.parentId === root.id)
        .length,
      sent: root.attachedSessionId != null,
      ...(onOpenLocation && root.current
        ? { locate: () => onOpenLocation(root.current!.path) }
        : {}),
    };
  });
}

/** The review in progress on this worktree: open comments never handed over. */
export function pendingWorktreeReviewIds(
  comments: WorktreeComment[] | undefined,
): string[] {
  return pendingReviewThreadIds(worktreeReviewThreads(comments ?? []));
}

/**
 * Submitting a worktree review. ONE component, because every route-level submit
 * uses the same wording — a new
 * session here stages an editable draft on the new-session page, which is what
 * the labels have to say.
 */
export function WorktreeReviewSubmitSheet({
  worktree,
  commentIds,
  sessions,
  onClose,
  onSubmit,
}: {
  worktree: WorktreeRecord;
  commentIds: string[];
  sessions: SessionListItem[];
  onClose: () => void;
  onSubmit: (commentIds: string[], target: SendCommentsTarget) => void;
}) {
  // Read here rather than taken as a prop, for the same reason the Knowledge
  // sheet does: every way in owes the reader the action the slot displaced.
  const primary = useRoutePrimaryAction();
  return (
    <SendCommentsSheet
      count={commentIds.length}
      sessions={worktreeSendSessions(worktree, sessions)}
      newLabel="New session in this worktree"
      newDetail="Continue on the new-session page to pick the model and edit the prompt"
      newSubmitLabel="Continue to session draft"
      onClose={onClose}
      onSend={(target) => onSubmit(commentIds, target)}
      {...(primary
        ? { startWithout: { label: primary.label, onRun: primary.onRun } }
        : {})}
    />
  );
}

/** Sessions already executing in this worktree are the natural targets. */
function worktreeSendSessions(
  worktree: WorktreeRecord,
  sessions: SessionListItem[],
): SendCommentsSession[] {
  return sessions
    .filter(
      (session) =>
        worktree.sessionIds.includes(session.id) && !session.archived,
    )
    .map((session) => ({
      id: session.id,
      title: session.title || session.id,
      linked: true,
    }));
}
