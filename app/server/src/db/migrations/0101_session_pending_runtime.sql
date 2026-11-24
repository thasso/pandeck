-- A started session's pending runtime selection (Task-1485): the model,
-- effort and account its next turn starts on, as JSON
-- `{ model: { provider, id }, thinkingLevel, account }`. NULL means no change
-- is pending, which is every existing session. Applied and cleared when the
-- next turn is admitted (`docs/session-runtime-switching.md`).
ALTER TABLE session_index ADD COLUMN pending_runtime TEXT;

-- A HELD input: a send that a pending selection refused and that cannot wait
-- in the queue (a library skill invocation, Task-1023). It keeps the user's
-- exact text, in order, beside the queue: shown on every device with Put back
-- and Discard, kept until they choose, and never dispatched (`promptQueue.ts`).
-- Every existing row is an ordinary queued message.
ALTER TABLE session_prompt_queue
  ADD COLUMN kind TEXT NOT NULL DEFAULT 'queued' CHECK (kind IN ('queued', 'held'));
