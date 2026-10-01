-- Workflow Runs (docs/agent-workflows.md, Task 364).
--
-- A Workflow Run is one durable attempt to produce an outcome for a Task: the
-- object that knows what step comes next, what evidence exists for which
-- commit, and where the user must decide, across sessions, restarts, and long
-- external waits. Three tables, and deliberately no fourth: commit ranges,
-- assessments, and PR identity live in step results as bounded metadata and
-- durable references, so there is no artifact/assignment/attempt/budget table
-- and no mutable run JSON blob (the legacy `workflows` table from 0002 is
-- exactly the shape this must not become).
--
-- The schema is GENERIC on purpose. A step is a kind plus a typed payload, and
-- no column here is named after implementers, reviewers, Git, or pull requests:
-- the recipe owns that meaning in payloads and registered result contracts. The
-- generality test is binding — a core field named `reviewer` would mean the
-- core is too specific.
--
-- Purely additive: three new tables and their indexes, no change to any
-- existing table or row.

CREATE TABLE workflow_runs (
  id               INTEGER PRIMARY KEY,   -- allocated from sequences('workflow_run')
  task_id          INTEGER NOT NULL,      -- tasks(id); no FK, tasks hard-delete (like task_comments)
  project_id       TEXT,                  -- projects(id) slug at start time, when the Task had one
  recipe_id        TEXT NOT NULL,         -- which recipe drives the run
  recipe_version   INTEGER NOT NULL,      -- version of that recipe's decision function
  worktree_id      TEXT,                  -- the worktree the run OWNS, once provisioned
  branch           TEXT,
  lifecycle        TEXT NOT NULL CHECK (lifecycle IN ('active','paused','completed','cancelled')),
  lifecycle_reason TEXT,                  -- every pause states its reason
  max_iterations   INTEGER NOT NULL,      -- plain limit columns, not a budget ledger
  max_sessions     INTEGER NOT NULL,
  created_at_ms    INTEGER NOT NULL,
  updated_at_ms    INTEGER NOT NULL,
  ended_at_ms      INTEGER                -- set when lifecycle became terminal
);

-- A Task may have several runs; its card lists them newest first.
CREATE INDEX workflow_runs_task_idx ON workflow_runs(task_id, id DESC);
-- Boot reconciliation reads exactly the non-terminal runs.
CREATE INDEX workflow_runs_lifecycle_idx ON workflow_runs(lifecycle);

-- Append-only step history. Rows are never deleted and a terminal row is never
-- rewritten: a revision or a semantic retry APPENDS a successor pointing back
-- through `predecessor_id`, so there is no mutable loop counter anywhere.
CREATE TABLE workflow_steps (
  id                  INTEGER PRIMARY KEY,  -- sequences('workflow_step'); monotonic, so id IS append order
  run_id              INTEGER NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,
  kind                TEXT NOT NULL CHECK (kind IN ('agent','host-operation','wait','user-decision')),
  payload_json        TEXT NOT NULL,        -- the assignment; the recipe owns its shape
  status              TEXT NOT NULL,        -- pending|running|completed|blocked|failed|cancelled
  executor_kind       TEXT,                 -- 'session' | 'operation'
  executor_id         TEXT,                 -- session id, or registered operation id
  attempt             INTEGER NOT NULL DEFAULT 0,  -- executor attempts while this step is OPEN
  predecessor_id      INTEGER,
  result_status       TEXT,                 -- completed|blocked|failed, as the executor reported it
  result_summary      TEXT,                 -- bounded prose
  result_contract_id  TEXT,                 -- registered contract the payload was validated against
  result_payload_json TEXT,                 -- bounded metadata + durable references only
  result_at_ms        INTEGER,
  created_at_ms       INTEGER NOT NULL,
  updated_at_ms       INTEGER NOT NULL,
  started_at_ms       INTEGER,
  ended_at_ms         INTEGER,
  -- A causal chain may not cross runs: a step's predecessor must be a step of
  -- the SAME run, or a run's history would be internally inconsistent (its
  -- steps pointing at evidence that is not in it). The composite key makes that
  -- structural rather than a convention the store has to remember; the UNIQUE
  -- is what lets the pair be a foreign key at all. Steps are never deleted in
  -- production — the CASCADE exists so a test teardown can clear the table.
  UNIQUE (id, run_id),
  FOREIGN KEY (predecessor_id, run_id)
    REFERENCES workflow_steps(id, run_id) ON DELETE CASCADE
);

-- `status` and the executor/result vocabularies are left unconstrained at the
-- SQL layer for the same reason `session_index.agent_type` is: they grow with
-- the runtime, and the TypeScript unions in @assistant/shared own them. Only
-- the two vocabularies the architecture FIXES (run lifecycle, step kind) are
-- CHECK-constrained, because widening either is an architectural decision.

CREATE INDEX workflow_steps_run_idx ON workflow_steps(run_id, id);

-- "A session executes at most one active step assignment at a time" — an
-- architecture invariant, so it is a CONSTRAINT, not an index that merely makes
-- the question cheap to ask. A partial UNIQUE index enforces it atomically
-- across ALL runs: two admitted steps racing for the same session cannot both
-- become `running`, whichever transaction commits second fails. Only sessions
-- are constrained: a registered host operation is a stateless service, and two
-- runs committing in their own worktrees at once is ordinary.
CREATE UNIQUE INDEX workflow_steps_active_session_idx
  ON workflow_steps(executor_id)
  WHERE executor_kind = 'session' AND status IN ('pending','running');

-- Append-only transition log with actor provenance: who or what caused each
-- change. Never updated, never deleted while its run exists.
CREATE TABLE workflow_events (
  id            INTEGER PRIMARY KEY,  -- sequences('workflow_event')
  run_id        INTEGER NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,
  step_id       INTEGER,
  event_type    TEXT NOT NULL,        -- run-created, step-completed, result-submitted, …
  actor_kind    TEXT NOT NULL,        -- user|agent|system|external
  actor_id      TEXT,
  detail_json   TEXT,                 -- bounded structured detail (before/after, reason)
  created_at_ms INTEGER NOT NULL,
  -- A run's history may only refer to its OWN steps, for the same reason a
  -- causal chain may not cross runs: an event naming a step that is not in the
  -- run makes that run's log unreadable. Keyed on the same (id, run_id) pair as
  -- the predecessor relation. A run-scoped event leaves `step_id` NULL, which
  -- satisfies the composite key.
  FOREIGN KEY (step_id, run_id)
    REFERENCES workflow_steps(id, run_id) ON DELETE CASCADE
);

CREATE INDEX workflow_events_run_idx ON workflow_events(run_id, id);
