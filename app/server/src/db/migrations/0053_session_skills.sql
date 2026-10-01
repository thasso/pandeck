-- Library skill names resolved for a session at its first coding-session start.
--
-- Kept outside session_index for the same reason as prompt conditions: some
-- harnesses need to freeze session-start inputs before their metadata row exists.
-- The row is insert-only through sessionStore; the first successful freeze wins.

CREATE TABLE session_skills (
  session_id TEXT PRIMARY KEY,
  names_json TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL
);
