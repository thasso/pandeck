-- Session-start prompt conditions (Task 287): the conditional persona-prompt
-- sections and eager tool tiers a session was assembled with, frozen the first
-- time its prompt is built. Its own table rather than a session_index column
-- because pi mints the session id and builds the prompt inside session
-- creation, BEFORE the metadata row is upserted.

CREATE TABLE session_prompt_conditions (
  session_id TEXT PRIMARY KEY,
  conditions_json TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL
);
