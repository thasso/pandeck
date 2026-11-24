-- Task-1485 sub-PR 5: which run the session's recorded failure belongs to
-- (docs/session-runtime-switching.md "Continue on another model"). A "Continue
-- on" offer is attached only while the row's failure is that run's, so a late
-- or retried report of an older run's failure never lands on a newer one. Set
-- with last_error_* from the run's error status; NULL for a failure no run
-- owns (a pending selection's hold), once cleared, and on every older row.
ALTER TABLE session_index ADD COLUMN last_error_run_id TEXT;
