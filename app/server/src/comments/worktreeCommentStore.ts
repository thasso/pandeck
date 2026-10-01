import type {
  CommentAuthor,
  CommentItem,
  CommentTarget,
  CommentThread,
  WorktreeComment,
} from "@assistant/shared";
import {
  addWorktreeComment,
  deleteWorktreeComment,
  listWorktreeComments,
  listWorktreeReviewSets,
  markCommentsAttached,
  resolveWorktreeComment,
} from "../worktrees/worktreeComments.ts";
import { userAuthorName } from "../userProfile.ts";
import type { CommentStore } from "./commentStore.ts";
import { unsupportedCommentMutation } from "./commentStore.ts";

function worktreeTarget(
  target: CommentTarget,
): Extract<CommentTarget, { kind: "worktree" }> {
  if (target.kind !== "worktree")
    throw new Error("Worktree comments need a worktree target.");
  return target;
}

function authorOf(
  value: WorktreeComment["author"],
  userName: string,
): CommentAuthor {
  return value.kind === "agent"
    ? {
        kind: "agent",
        name: "agent",
        sessionId: value.sessionId,
        ...(value.model ? { model: value.model } : {}),
        ...(value.thinkingLevel ? { thinkingLevel: value.thinkingLevel } : {}),
      }
    : { kind: "user", name: userName };
}

function itemOf(value: WorktreeComment, userName: string): CommentItem {
  return {
    id: value.id,
    author: authorOf(value.author, userName),
    body: value.body,
    ...(value.parentId ? { parentId: value.parentId } : {}),
    createdAt: value.createdAt,
  };
}

function project(rows: WorktreeComment[]): CommentThread[] {
  // A worktree comment stores only that the user wrote it, so the name is the
  // CURRENT display name, resolved once per projection.
  const userName = userAuthorName();
  const replies = new Map<string, WorktreeComment[]>();
  for (const row of rows) {
    if (!row.parentId) continue;
    const list = replies.get(row.parentId) ?? [];
    list.push(row);
    replies.set(row.parentId, list);
  }
  return rows
    .filter((row) => !row.parentId)
    .map((root) => ({
      id: root.id,
      target: {
        kind: "worktree" as const,
        worktreeId: root.worktreeId,
        path: root.anchor?.path ?? root.current?.path ?? "",
        side: root.anchor?.side ?? "new",
        revision: root.anchor?.commit ?? "",
      },
      status:
        root.resolvedAt === undefined
          ? ("open" as const)
          : ("resolved" as const),
      root: itemOf(root, userName),
      replies: (replies.get(root.id) ?? []).map((reply) =>
        itemOf(reply, userName),
      ),
      ...(root.severity ? { severity: root.severity } : {}),
      ...(root.reviewSetId ? { reviewSetId: root.reviewSetId } : {}),
      ...(root.anchor?.selectors ? { selectors: root.anchor.selectors } : {}),
      ...(root.anchorState ? { anchorState: root.anchorState } : {}),
      ...(root.anchor
        ? {
            original: {
              path: root.anchor.path,
              lineStart: root.anchor.line,
              lineEnd: root.anchor.line,
            },
          }
        : {}),
      ...(root.current
        ? {
            current: {
              path: root.current.path,
              lineStart: root.current.line,
              lineEnd: root.current.line,
            },
          }
        : {}),
      ...(root.resolvedAt ? { resolvedAt: root.resolvedAt } : {}),
      ...(root.resolvedBy
        ? {
            resolvedBy:
              root.resolvedBy === "user"
                ? ({ kind: "user", name: userName } as const)
                : ({
                    kind: "agent",
                    name: "agent",
                    sessionId: root.resolvedBy,
                  } as const),
          }
        : {}),
      handoffSessionIds: root.attachedSessionId ? [root.attachedSessionId] : [],
      createdAt: root.createdAt,
      updatedAt: root.updatedAt,
    }));
}

export function worktreeReviewSetsForTarget(target: CommentTarget) {
  return listWorktreeReviewSets(worktreeTarget(target).worktreeId);
}

export const worktreeCommentStore: CommentStore = {
  async list(target) {
    return project(
      await listWorktreeComments(worktreeTarget(target).worktreeId),
    );
  },
  async add({ target, body, selectors }) {
    const wt = worktreeTarget(target);
    const line = Number(selectors?.block?.id);
    if (!Number.isInteger(line) || line < 1)
      throw new Error("Worktree comment selectors need a line block.");
    const comment = await addWorktreeComment({
      worktreeId: wt.worktreeId,
      body,
      author: { kind: "user" },
      anchor: {
        path: wt.path,
        side: wt.side,
        line,
        ...(selectors?.position ? { selectors } : {}),
        ...(wt.revision ? { ref: wt.revision } : {}),
      },
    });
    return { target, threadIds: [comment.id] };
  },
  async reply({ target, threadId, body }) {
    const wt = worktreeTarget(target);
    await addWorktreeComment({
      worktreeId: wt.worktreeId,
      body,
      author: { kind: "user" },
      parentId: threadId,
    });
    return { target, threadIds: [threadId] };
  },
  async resolve({ target, threadId, resolved }) {
    worktreeTarget(target);
    resolveWorktreeComment(threadId, resolved, "user");
    return { target, threadIds: [threadId] };
  },
  async edit({ target }) {
    return unsupportedCommentMutation(target, "Editing");
  },
  async delete({ target, threadId }) {
    worktreeTarget(target);
    deleteWorktreeComment(threadId);
    return { target, threadIds: [threadId] };
  },
  async attach({ target, threadIds, sessionId }) {
    worktreeTarget(target);
    markCommentsAttached(threadIds, sessionId);
    return { target, threadIds };
  },
};
