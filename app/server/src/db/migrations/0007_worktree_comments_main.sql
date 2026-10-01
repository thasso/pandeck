-- Allow review comments on a project's MAIN checkout, which is a synthetic
-- worktree (`main:<projectId>`) with no `worktrees` row. The original
-- `worktree_id` FK (REFERENCES worktrees(id) ON DELETE CASCADE) blocks that.
-- Dropping it is safe and consistent:
--   * spawned worktrees soft-delete (status='removed', never hard DELETE) so
--     the CASCADE never actually fired — comments are kept on purpose;
--   * `worktrees.project_id` already carries no FK for the same soft-delete
--     reason.
-- The `parent_id` self-FK (reply cascade, used by deleteComment) is KEPT.
--
-- SQLite can't ALTER away a FK, so rebuild the table. Migrations run inside a
-- transaction (PRAGMA foreign_keys can't be toggled here), so copy roots first
-- (parent_id NULL) to keep the parent self-FK satisfied during the insert.

ALTER TABLE worktree_comments RENAME TO worktree_comments_old;

CREATE TABLE worktree_comments (
  id                  TEXT PRIMARY KEY,
  worktree_id         TEXT NOT NULL,          -- no FK: synthetic main + soft-deleted rows
  parent_id           TEXT REFERENCES worktree_comments(id) ON DELETE CASCADE,  -- NULL = thread root
  author_kind         TEXT NOT NULL CHECK (author_kind IN ('user','agent')),
  author_session_id   TEXT,
  body                TEXT NOT NULL,
  resolved_at_ms      INTEGER,
  resolved_by         TEXT,
  anchor_path         TEXT,
  anchor_side         TEXT CHECK (anchor_side IN ('old','new')),
  anchor_line         INTEGER,
  anchor_commit       TEXT,
  anchor_blob         TEXT,
  anchor_dirty        INTEGER,
  anchor_context_json TEXT,
  current_path        TEXT,
  current_line        INTEGER,
  anchor_state        TEXT CHECK (anchor_state IN ('anchored','moved','orphaned')),
  attached_session_id TEXT,
  created_at_ms       INTEGER NOT NULL,
  updated_at_ms       INTEGER NOT NULL
);

INSERT INTO worktree_comments
  SELECT * FROM worktree_comments_old ORDER BY (parent_id IS NOT NULL), created_at_ms;

DROP TABLE worktree_comments_old;

CREATE INDEX worktree_comments_wt_idx ON worktree_comments(worktree_id, parent_id);
CREATE INDEX worktree_comments_path_idx ON worktree_comments(worktree_id, current_path);
