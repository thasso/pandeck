-- The agent definition a session was spawned from (docs/agent-definitions.md).
--
-- Frozen at spawn, like session_skills: the first insert wins for the session's
-- life, a fork copies its parent's row, and a resume reads this row rather than
-- the agents library, so editing or deleting a definition affects new spawns
-- only. Kept outside session_index because pi freezes it inside creation,
-- before that session's metadata row exists.

CREATE TABLE session_agent (
  session_id TEXT PRIMARY KEY,
  definition_json TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL
);
