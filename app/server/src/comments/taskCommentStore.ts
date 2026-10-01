import type { CommentTarget, CommentThread } from "@assistant/shared";
import { addTaskComment, listTaskComments } from "../taskComments.ts";
import { userAuthorName } from "../userProfile.ts";
import type { CommentStore } from "./commentStore.ts";
import { unsupportedCommentMutation } from "./commentStore.ts";

function taskTarget(
  target: CommentTarget,
): Extract<CommentTarget, { kind: "task" }> {
  if (target.kind !== "task")
    throw new Error("Task comments need a Task target.");
  return target;
}

export const taskCommentStoreAdapter: CommentStore = {
  async list(target) {
    const { taskId } = taskTarget(target);
    return listTaskComments(taskId).map((comment): CommentThread => ({
      id: comment.id,
      target: { kind: "task", taskId },
      status: "open",
      root: {
        id: comment.id,
        author: comment.author,
        body: comment.body,
        createdAt: comment.createdAt,
      },
      replies: [],
      handoffSessionIds: [],
      createdAt: comment.createdAt,
      updatedAt: comment.createdAt,
    }));
  },
  async add({ target, body, selectors }) {
    const { taskId } = taskTarget(target);
    if (selectors) throw new Error("Task comments are unanchored.");
    const comment = addTaskComment({
      taskId,
      authorKind: "user",
      authorName: userAuthorName(),
      body,
    });
    return { target, threadIds: [comment.id] };
  },
  async reply({ target }) {
    return unsupportedCommentMutation(target, "Replying");
  },
  async resolve({ target }) {
    return unsupportedCommentMutation(target, "Resolving");
  },
  async edit({ target }) {
    return unsupportedCommentMutation(target, "Editing");
  },
  async delete({ target }) {
    return unsupportedCommentMutation(target, "Deleting");
  },
  async attach({ target }) {
    return unsupportedCommentMutation(target, "Attaching");
  },
};
