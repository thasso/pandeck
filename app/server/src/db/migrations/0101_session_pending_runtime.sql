-- A started session's pending runtime selection (Task-1485): the model,
-- effort and account its next turn starts on, as JSON
-- `{ model: { provider, id }, thinkingLevel, account }`. NULL means no change
-- is pending, which is every existing session. Applied and cleared when the
-- next turn is admitted (`docs/session-runtime-switching.md`).
ALTER TABLE session_index ADD COLUMN pending_runtime TEXT;
