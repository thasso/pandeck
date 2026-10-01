-- Commit-completion tracking for tasks: when the commit workflow includes a
-- completed task in a commit, it records the hash + time here (distinct from a
-- workflow's own commit-step state, which lives in the workflow blob).
ALTER TABLE tasks ADD COLUMN commit_hash TEXT;
ALTER TABLE tasks ADD COLUMN committed_at_ms INTEGER;
