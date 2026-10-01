/**
 * The one prompt that hands worktree review threads to a fixing agent.
 *
 * Two paths need it and must not drift apart: the user's "send these comments
 * to a session" action, and the Workflow revise/fixer assignment, which hands
 * over a whole durable review set ([Task-520](pa://task/520)). Both say the
 * same thing about what a finding IS — a claim to verify, not an order
 * (`REVIEW_RESPONSE_CONVENTION`) — so that framing lives here once, and an
 * assembled prompt that already carries this section never repeats it.
 *
 * Threads are rendered at their CURRENT anchor: the list read re-anchors first,
 * which matters most on the workflow path, where a commit lands between the
 * review and the fix.
 */
import { REVIEW_RESPONSE_CONVENTION } from "@assistant/shared";
import type { WorktreeComment } from "@assistant/shared";
import {
  listWorktreeComments,
  listWorktreeReviewSets,
} from "./worktreeComments.ts";

export interface ReviewHandoffSelection {
  worktreeId: string;
  /** Explicit thread roots — what the user picked on the review surface. */
  commentIds?: readonly string[];
  /** Every root published in one durable review set. */
  reviewSetId?: string;
}

/**
 * The handoff section for `selection`, or `undefined` when it selects nothing:
 * an empty section is not a degraded prompt, it is a claim about work that does
 * not exist, so callers assemble around its absence instead.
 */
export async function buildReviewHandoffPrompt(
  selection: ReviewHandoffSelection,
): Promise<string | undefined> {
  const all = await listWorktreeComments(selection.worktreeId);
  const roots = all.filter(
    (comment) => !comment.parentId && selects(selection, comment),
  );
  if (roots.length === 0) return undefined;

  const set = selection.reviewSetId
    ? listWorktreeReviewSets(selection.worktreeId).find(
        (candidate) => candidate.id === selection.reviewSetId,
      )
    : undefined;
  const sections = roots.map((root) => {
    const replies = all
      .filter((comment) => comment.parentId === root.id)
      .map(
        (reply) =>
          `  - ${reply.author.kind === "agent" ? "agent" : "user"}: ${reply.body}`,
      )
      .join("\n");
    return [
      `### ${locationOf(root)}${root.severity ? ` — [${root.severity}]` : ""} (comment id: ${root.id})`,
      "",
      root.body,
      root.resolvedAt !== undefined ? "\n(already resolved)" : "",
      replies ? `\nReplies:\n${replies}` : "",
    ]
      .filter(Boolean)
      .join("\n");
  });

  return [
    "## Review comments",
    "",
    set
      ? `Review set ${set.id}${set.verdict ? ` (${set.verdict})` : ""} published ${countLabel(roots.length)} on this worktree.${set.summary ? ` The reviewer summarized it as: ${set.summary}` : ""}`
      : `${countLabel(roots.length)} were left on this worktree.`,
    "",
    REVIEW_RESPONSE_CONVENTION,
    "",
    "Answer every thread where the user reads it: reply with `review_comment_reply`,",
    "and mark with `review_comment_resolve` only what you actually fixed — a finding",
    "you reject stays open, carrying your reasoning. Use `review_comments_list` to",
    "re-read threads with their current line anchors.",
    "",
    ...sections,
  ].join("\n");
}

function selects(
  selection: ReviewHandoffSelection,
  comment: WorktreeComment,
): boolean {
  if (selection.commentIds?.includes(comment.id)) return true;
  return (
    selection.reviewSetId !== undefined &&
    comment.reviewSetId === selection.reviewSetId
  );
}

function locationOf(root: WorktreeComment): string {
  if (root.current) return `${root.current.path}:${root.current.line}`;
  return `${root.anchor?.path ?? "?"} (orphaned)`;
}

function countLabel(count: number): string {
  return `${count} review comment${count === 1 ? "" : "s"}`;
}
