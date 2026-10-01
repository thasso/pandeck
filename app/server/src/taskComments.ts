/**
 * Task activity-trace comments (Task 116).
 *
 * A flat, append-only, chronological comment log per Task, backed by
 * {@link ./db/taskCommentStore.ts}. Users (web) and agents (a `task_manage`
 * operation's `comment`) leave context, decisions, updates, and follow-ups; there is no threading,
 * resolve/reopen, editing, or text anchoring — an auditable trace. Adding a
 * comment reports its touched thread id through the shared comment-event seam
 * and bumps the task-list revision so `commentCount` badges refresh.
 */
import type {
  TaskComment,
  TaskCommentAuthor,
  TaskCommentAuthorKind,
} from "@assistant/shared";
import {
  taskCommentStore,
  type TaskCommentRow,
} from "./db/taskCommentStore.ts";
import { taskStore } from "./db/taskStore.ts";
import { notifyTaskChange } from "./tasks.ts";
import { reportCommentChanges } from "./comments/commentChanges.ts";

const MAX_BODY_CHARS = 20_000;

export interface AddTaskCommentInput {
  taskId: string;
  authorKind: TaskCommentAuthorKind;
  authorName: string;
  authorSessionId?: string;
  body: string;
}

function parseId(id: string): number | undefined {
  const n = Number(id);
  return Number.isInteger(n) && n > 0 ? n : undefined;
}

/** Chronological comments for a Task (oldest first). */
export function listTaskComments(taskId: string): TaskComment[] {
  const nid = parseId(taskId);
  if (nid === undefined) return [];
  return taskCommentStore.listForTask(nid).map(toComment);
}

/**
 * Append one comment to a Task's trace, report its new id, and refresh Task-list
 * badges. Throws if the Task does not exist.
 */
export function addTaskComment(input: AddTaskCommentInput): TaskComment {
  const nid = parseId(input.taskId);
  if (nid === undefined || !taskStore.get(nid))
    throw new Error(`Task not found: ${input.taskId}`);
  const body = input.body.trim();
  if (!body) throw new Error("Comment body cannot be empty.");
  const authorName = input.authorName.trim() || input.authorKind;
  const authorSessionIdValue = input.authorSessionId?.trim() || undefined;
  const row = taskCommentStore.add({
    taskId: nid,
    authorKind: input.authorKind,
    authorName,
    ...(authorSessionIdValue !== undefined
      ? { authorSessionId: authorSessionIdValue }
      : {}),
    body: body.slice(0, MAX_BODY_CHARS),
  });
  reportCommentChanges({ kind: "task", taskId: input.taskId }, [row.id]);
  // The comment count is part of this Task's list row, so the append reports
  // the touched id through the same seam every other write uses.
  notifyTaskChange([input.taskId]);
  return toComment(row);
}

function toComment(row: TaskCommentRow): TaskComment {
  const author: TaskCommentAuthor = {
    kind: row.authorKind,
    name: row.authorName,
  };
  if (row.authorSessionId) author.sessionId = row.authorSessionId;
  return {
    id: row.id,
    taskId: String(row.taskId),
    author,
    body: row.body,
    createdAt: row.createdAt,
  };
}
