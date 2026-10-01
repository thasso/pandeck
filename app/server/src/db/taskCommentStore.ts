/**
 * The `task_comments` store (Task 116): append-only, chronological comments on a
 * Task — the auditable activity trace. Users and agents leave context, decisions,
 * updates, and follow-ups; comments are never edited or deleted individually
 * (append-only = auditable). Rows are hard-removed only when a Task is
 * permanently deleted (see {@link ../tasks.ts} `deleteTask`); archiving keeps them.
 *
 * There is no FK on `task_id`: tasks soft-delete (`tasks.deleted_at_ms`) and are
 * never hard-DELETEd, mirroring {@link ./worktreeStore.ts} `worktree_comments`.
 *
 * Writes are synchronous (node:sqlite + WAL), durable at call time. Projection
 * to the wire `TaskComment` shape lives in {@link ../taskComments.ts}.
 */
import { randomUUID } from "node:crypto";
import { getDb } from "./index.ts";

type TaskCommentAuthorKind = "user" | "agent" | "system";

export interface TaskCommentRow {
  id: string;
  taskId: number;
  authorKind: TaskCommentAuthorKind;
  authorName: string;
  authorSessionId?: string;
  body: string;
  createdAt: number;
}

interface AddTaskCommentInput {
  taskId: number;
  authorKind: TaskCommentAuthorKind;
  authorName: string;
  authorSessionId?: string;
  body: string;
}

function add(input: AddTaskCommentInput): TaskCommentRow {
  const id = randomUUID();
  const now = Date.now();
  getDb()
    .prepare(
      `
      INSERT INTO task_comments (id, task_id, author_kind, author_name, author_session_id, body, created_at_ms)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `,
    )
    .run(
      id,
      input.taskId,
      input.authorKind,
      input.authorName,
      input.authorSessionId ?? null,
      input.body,
      now,
    );
  return get(id)!;
}

function get(id: string): TaskCommentRow | undefined {
  const row = getDb()
    .prepare("SELECT * FROM task_comments WHERE id = ?")
    .get(id) as DbRow | undefined;
  return row ? fromRow(row) : undefined;
}

/**
 * All comments for a task, oldest first (chronological trace).
 *
 * `rowid` breaks the tie, not `id`: two comments appended in the same
 * millisecond share a `created_at_ms`, and `id` is a random UUID, so ordering by
 * it returns same-tick comments in an arbitrary order that changes with the
 * values. The implicit rowid is the insertion sequence, which is what a
 * chronological trace means when the clock cannot separate two entries.
 */
function listForTask(taskId: number): TaskCommentRow[] {
  const rows = getDb()
    .prepare(
      "SELECT * FROM task_comments WHERE task_id = ? ORDER BY created_at_ms, rowid",
    )
    .all(taskId) as unknown as DbRow[];
  return rows.map(fromRow);
}

/** One pass over all comments: task id → comment count, for list badges. */
function countsByTask(): Map<string, number> {
  const rows = getDb()
    .prepare(
      "SELECT task_id, COUNT(*) AS count FROM task_comments GROUP BY task_id",
    )
    .all() as unknown as Array<{ task_id: number; count: number }>;
  const map = new Map<string, number>();
  for (const row of rows) map.set(String(row.task_id), row.count);
  return map;
}

/** Comment count for ONE task, for the single-row summary a state event carries. */
function countForTask(taskId: number): number {
  const row = getDb()
    .prepare("SELECT COUNT(*) AS count FROM task_comments WHERE task_id = ?")
    .get(taskId) as { count: number };
  return row.count;
}

/** Hard-remove every comment for a task; call only on permanent Task deletion. */
function removeForTask(taskId: number): void {
  getDb().prepare("DELETE FROM task_comments WHERE task_id = ?").run(taskId);
}

interface DbRow {
  id: string;
  task_id: number;
  author_kind: TaskCommentAuthorKind;
  author_name: string;
  author_session_id: string | null;
  body: string;
  created_at_ms: number;
}

function fromRow(row: DbRow): TaskCommentRow {
  return {
    id: row.id,
    taskId: row.task_id,
    authorKind: row.author_kind,
    authorName: row.author_name,
    ...(row.author_session_id
      ? { authorSessionId: row.author_session_id }
      : {}),
    body: row.body,
    createdAt: row.created_at_ms,
  };
}

export const taskCommentStore = {
  add,
  get,
  listForTask,
  countsByTask,
  countForTask,
  removeForTask,
};
