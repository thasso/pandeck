-- Agent-authored worktree reviews are durable sets of attributed, anchored
-- findings. Existing human comments remain valid: attribution snapshots,
-- severity, and set membership are nullable.
CREATE TABLE worktree_review_sets (
  id                    TEXT PRIMARY KEY,
  worktree_id           TEXT NOT NULL,
  author_session_id     TEXT NOT NULL,
  author_model          TEXT,
  author_thinking_level TEXT,
  blind                 INTEGER NOT NULL DEFAULT 0 CHECK (blind IN (0, 1)),
  verdict               TEXT CHECK (verdict IN ('approve','approve-with-fixes','request-changes','reject')),
  summary               TEXT,
  created_at_ms         INTEGER NOT NULL,
  updated_at_ms         INTEGER NOT NULL
);
CREATE INDEX worktree_review_sets_wt_idx
  ON worktree_review_sets(worktree_id, created_at_ms);
CREATE INDEX worktree_review_sets_open_blind_idx
  ON worktree_review_sets(worktree_id, blind, verdict)
  WHERE blind = 1 AND verdict IS NULL;

ALTER TABLE worktree_comments ADD COLUMN author_model TEXT;
ALTER TABLE worktree_comments ADD COLUMN author_thinking_level TEXT;
ALTER TABLE worktree_comments ADD COLUMN severity TEXT
  CHECK (severity IN ('critical','major','minor','nit'));
ALTER TABLE worktree_comments ADD COLUMN review_set_id TEXT
  REFERENCES worktree_review_sets(id) ON DELETE SET NULL;
CREATE INDEX worktree_comments_review_set_idx
  ON worktree_comments(review_set_id) WHERE review_set_id IS NOT NULL;
