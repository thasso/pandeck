-- Worktrees: one row per git worktree spawned from a project's main checkout.
--
-- Design mirrors projects/tasks: columns = the worktree's own attributes;
-- relationships to other nodes are edges in the generic `links` table:
--   * session —in_worktree→ worktree   (the session executes in that worktree)
--   * task    —in_worktree→ worktree   (the task is implemented in that worktree)
--
-- The main checkout of a project is NOT a row here — it is derived live from the
-- project's localPaths (first path that is a git repo). Rows are spawned
-- worktrees only. `status` is a lifecycle marker; live git state (dirty,
-- ahead/behind, merged) is always computed, never persisted.

CREATE TABLE worktrees (
  id               TEXT PRIMARY KEY,          -- uuid
  project_id       TEXT NOT NULL,             -- projects.id (no FK: projects soft-delete)
  main_repo_root   TEXT NOT NULL,             -- absolute path of the main worktree at creation
  path             TEXT NOT NULL UNIQUE,      -- absolute worktree folder
  branch           TEXT NOT NULL,             -- == generated suffix
  base_branch      TEXT NOT NULL,             -- branch it was forked from (merge target)
  base_commit      TEXT NOT NULL,             -- oid of base_branch at creation
  status           TEXT NOT NULL DEFAULT 'active'
                   CHECK (status IN ('active','removed')),
  merge_state_json TEXT,                      -- last merge attempt: {strategy, startedAt, agentSessionId?, conflictPaths?}
  created_at_ms    INTEGER NOT NULL,
  updated_at_ms    INTEGER NOT NULL,
  removed_at_ms    INTEGER
);
CREATE INDEX worktrees_project_idx ON worktrees(project_id);

-- Review comments: threaded (roots carry an anchor, replies do not). The
-- creation anchor is immutable; re-anchoring recomputes only current_path/
-- current_line/anchor_state from it after new commits or working-tree edits.
CREATE TABLE worktree_comments (
  id                  TEXT PRIMARY KEY,       -- uuid
  worktree_id         TEXT NOT NULL REFERENCES worktrees(id) ON DELETE CASCADE,
  parent_id           TEXT REFERENCES worktree_comments(id) ON DELETE CASCADE,  -- NULL = thread root
  author_kind         TEXT NOT NULL CHECK (author_kind IN ('user','agent')),
  author_session_id   TEXT,                   -- set when author_kind = 'agent'
  body                TEXT NOT NULL,
  resolved_at_ms      INTEGER,
  resolved_by         TEXT,                   -- 'user' | session id
  -- Immutable creation anchor (thread roots only):
  anchor_path         TEXT,                   -- repo-relative path at creation
  anchor_side         TEXT CHECK (anchor_side IN ('old','new')),
  anchor_line         INTEGER,                -- 1-based line at creation
  anchor_commit       TEXT,                   -- worktree HEAD oid at creation
  anchor_blob         TEXT,                   -- blob oid of the content the line was read from
  anchor_dirty        INTEGER,                -- 1 = anchored to uncommitted working-tree content
  anchor_context_json TEXT,                   -- {before: string[], line: string, after: string[]}
  -- Mutable current position (recomputed by re-anchoring):
  current_path        TEXT,
  current_line        INTEGER,
  anchor_state        TEXT CHECK (anchor_state IN ('anchored','moved','orphaned')),
  attached_session_id TEXT,                   -- session the comment batch was handed to, if any
  created_at_ms       INTEGER NOT NULL,
  updated_at_ms       INTEGER NOT NULL
);
CREATE INDEX worktree_comments_wt_idx ON worktree_comments(worktree_id, parent_id);
CREATE INDEX worktree_comments_path_idx ON worktree_comments(worktree_id, current_path);

-- Per-project override for where new worktrees are created (falls back to the
-- global settings.worktrees.root).
ALTER TABLE projects ADD COLUMN worktree_root TEXT;
