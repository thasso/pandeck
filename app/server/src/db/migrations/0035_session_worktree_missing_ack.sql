-- Acknowledgement that a session whose `in_worktree` worktree is GONE may run
-- in the app working directory anyway (Task 321).
--
-- Its own table rather than a session_index column, like
-- session_prompt_conditions: a session id can exist (with edges, and a
-- transcript) before or without a metadata row, and the acknowledgement must
-- still be recordable for it. The acknowledged worktree id is stored, not a
-- flag: a session later relinked to another worktree that also disappears must
-- ask again rather than inherit the old answer.

CREATE TABLE session_worktree_ack (
  session_id TEXT PRIMARY KEY,
  worktree_id TEXT NOT NULL,
  acknowledged_at_ms INTEGER NOT NULL
);
