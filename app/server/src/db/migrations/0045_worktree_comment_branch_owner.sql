ALTER TABLE worktree_comments ADD COLUMN owner_worktree_id TEXT;
ALTER TABLE worktree_comments ADD COLUMN owner_branch TEXT;
ALTER TABLE worktree_comments ADD COLUMN owner_source TEXT
  CHECK (owner_source IN ('merge-in-flight', 'branch-exclusive'));
CREATE INDEX worktree_comments_owner_idx
  ON worktree_comments(owner_worktree_id) WHERE owner_worktree_id IS NOT NULL;
