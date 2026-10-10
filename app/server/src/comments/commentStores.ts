import type { CommentTarget, WorktreeReviewSet } from "@assistant/shared";
import type { CommentStore } from "./commentStore.ts";
import {
  worktreeCommentStore,
  worktreeReviewSetsForTarget,
} from "./worktreeCommentStore.ts";

/** The single domain dispatcher; chat/session comments never reach the server. */
export function commentReviewSetsFor(
  target: CommentTarget,
): WorktreeReviewSet[] | undefined {
  return target.kind === "worktree"
    ? worktreeReviewSetsForTarget(target)
    : undefined;
}

export function commentStoreFor(target: CommentTarget): CommentStore {
  switch (target.kind) {
    case "worktree":
      return worktreeCommentStore;
    case "session":
      throw new Error("Session comments are browser-local.");
  }
}
