-- Append-only, chronological comments on a Task: the auditable activity trace
-- (Task 116). Users (web) and agents (task_comment tool) leave context,
-- decisions, updates, and follow-ups directly on a Task.
--
-- No FK on task_id: tasks soft-delete (tasks.deleted_at_ms) and never hard
-- DELETE, mirroring worktree_comments. Comments are hard-deleted only when a
-- Task is permanently deleted (tasks.ts#deleteTask -> removeForTask); archive
-- keeps them. author_kind includes 'system' for a future lifecycle-event
-- extension; no producer emits it yet.

CREATE TABLE task_comments (
  id                TEXT PRIMARY KEY,           -- randomUUID
  task_id           INTEGER NOT NULL,           -- no FK: tasks soft-delete
  author_kind       TEXT NOT NULL CHECK (author_kind IN ('user','agent','system')),
  author_name       TEXT NOT NULL,
  author_session_id TEXT,                       -- originating agent session, when applicable
  body              TEXT NOT NULL,
  created_at_ms     INTEGER NOT NULL
);

CREATE INDEX task_comments_task_idx ON task_comments(task_id, created_at_ms);
