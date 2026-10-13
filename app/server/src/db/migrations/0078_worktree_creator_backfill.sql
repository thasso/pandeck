-- `worktree_create` records its caller as the worktree's creator
-- (`session —created_worktree→ worktree`). Worktrees created before that edge
-- existed get it from the boot-time backfill
-- (`worktrees/worktreeCreatorBackfill.ts`), which reads each candidate
-- session's own log for the call and its result. One row once it has run,
-- with what it found; until then it is retried on the next start.
CREATE TABLE worktree_creator_backfill (
  id              INTEGER PRIMARY KEY CHECK (id = 1),
  completed_at_ms INTEGER NOT NULL,
  summary_json    TEXT NOT NULL
);
