-- Daily Scanner v2 synthesis application journal (Task 136, plan Decision #2).
-- Applying structured synthesis output spans KB Git + SQLite + the session log,
-- which cannot be one transaction. The journal makes application idempotent and
-- recoverable: run-level state drives resume/reconciliation, and a UNIQUE
-- candidate->Task mapping guarantees a Task is never created twice for one
-- minutes candidate (resume-not-duplicate after a crash mid-apply).

CREATE TABLE day_synthesis_runs (
  run_id TEXT PRIMARY KEY,
  date TEXT NOT NULL,
  -- preflight -> applying -> applied (terminal). A non-terminal row at startup is reconciled.
  state TEXT NOT NULL CHECK (state IN ('preflight', 'applying', 'applied')),
  -- The single run-id-tagged KB commit hash, set when the KB portion lands.
  kb_commit TEXT,
  at_ms INTEGER NOT NULL
);

CREATE INDEX day_synthesis_runs_date_idx ON day_synthesis_runs (date, at_ms);

-- THE candidate->Task uniqueness guarantee. One row per candidate ever; the
-- Task id is stable across re-runs, so re-proposing a candidate reuses its Task.
CREATE TABLE day_synthesis_candidate_tasks (
  candidate_id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  at_ms INTEGER NOT NULL
);
