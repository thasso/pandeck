-- What boot learned about a turn the previous process died inside, next to
-- `interrupted_run_at_ms` (0056) and written and cleared with it.
--
-- The timestamp alone told the user THAT a turn was cut, not what to do about
-- it. Whether the cut turn's prompt reached the agent's own history decides it:
-- kept, a plain "continue" resumes the work; lost, the prompt must be sent
-- again. Boot reads that from the harness's native history, together with why
-- the process ended, and stores the verdict here as JSON
-- (`{ cause?, promptKept?, modelSteps? }`) so the list never re-reads it.
ALTER TABLE session_index ADD COLUMN interrupted_run_json TEXT;
