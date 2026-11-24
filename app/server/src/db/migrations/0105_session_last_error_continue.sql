-- Task-1485 sub-PR 5: the "Continue on <model>" offer a turn's terminal
-- quota or rate-limit failure carries when same-kind failover cannot recover
-- it (docs/session-runtime-switching.md "Continue on another model"). JSON:
-- the models, in the user's order, another engine can continue it on. Written
-- only beside the failure it belongs to; cleared with that failure (a run
-- start or a Dismiss). NULL for every other failure and every older row.
ALTER TABLE session_index ADD COLUMN last_error_continue_json TEXT;
