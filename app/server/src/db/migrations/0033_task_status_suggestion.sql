-- The done-proposal generalizes into a STATUS SUGGESTION: an agent may say a
-- Task is finished (`done`) or hand it back unfinished (`todo`), and the user
-- answers. The old columns held one implicit `done` claim, so they are renamed
-- rather than duplicated and every existing claim becomes a `done` suggestion.
-- `status_suggestion_reason` is the one short line the agent may attach.
ALTER TABLE tasks RENAME COLUMN done_proposed_at_ms TO status_suggestion_at_ms;
ALTER TABLE tasks RENAME COLUMN done_proposed_by TO status_suggestion_by;
ALTER TABLE tasks ADD COLUMN status_suggestion_to TEXT;
ALTER TABLE tasks ADD COLUMN status_suggestion_reason TEXT;
UPDATE tasks SET status_suggestion_to = 'done'
  WHERE status_suggestion_at_ms IS NOT NULL;
