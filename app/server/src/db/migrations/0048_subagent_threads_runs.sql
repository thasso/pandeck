-- Durable PA-owned subagent threads and assignment runs (Task-493).
--
-- Threads own frozen launch configuration and one hidden session. Runs are
-- append-like rounds within a thread: terminal rows never reopen, while one
-- partial unique index prevents a second run until the previous run is both
-- terminal and quiescent. Revisions come from sequences('subagent_revision')
-- and are stamped by subagentStore inside the same transaction as each write.
-- `is_member` + `deleted_at_ms` are the Task-490 state-sync tombstone seam:
-- deletion keeps only identity/reference guards and revision metadata.

CREATE TABLE subagent_threads (
  id TEXT PRIMARY KEY,
  parent_session_id TEXT NOT NULL REFERENCES session_index(id),
  session_id TEXT NOT NULL UNIQUE REFERENCES session_index(id),
  peer_conversation_id TEXT,

  role_name TEXT,
  base_role TEXT,
  worktree_id TEXT,
  cwd TEXT,
  task_id INTEGER,
  project_id TEXT,
  worktree_relation TEXT,
  worktree_provenance_json TEXT,

  provider TEXT,
  model_id TEXT,
  credential_profile_id TEXT,
  account_source TEXT,
  degraded_pin_reason TEXT,
  default_thinking TEXT,
  hard_max_thinking TEXT,
  execution_profile_id TEXT,
  contract_id TEXT,
  contract_version INTEGER,

  usage_input_tokens INTEGER NOT NULL DEFAULT 0 CHECK (usage_input_tokens >= 0),
  usage_output_tokens INTEGER NOT NULL DEFAULT 0 CHECK (usage_output_tokens >= 0),
  usage_cache_read_tokens INTEGER NOT NULL DEFAULT 0 CHECK (usage_cache_read_tokens >= 0),
  usage_cache_write_tokens INTEGER NOT NULL DEFAULT 0 CHECK (usage_cache_write_tokens >= 0),
  usage_cost_micros INTEGER CHECK (usage_cost_micros IS NULL OR usage_cost_micros >= 0),
  usage_completion_id TEXT,

  inherited_archived_at_ms INTEGER,
  inherited_settled_at_ms INTEGER,
  created_at_ms INTEGER,
  updated_at_ms INTEGER,
  activity_at_ms INTEGER,

  revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
  is_member INTEGER NOT NULL DEFAULT 1 CHECK (is_member IN (0, 1)),
  deleted_at_ms INTEGER,

  CHECK (
    (is_member = 0 AND deleted_at_ms IS NOT NULL)
    OR
    (is_member = 1 AND deleted_at_ms IS NULL
      AND peer_conversation_id IS NOT NULL
      AND role_name IS NOT NULL AND length(trim(role_name)) > 0
      AND base_role IS NOT NULL AND length(trim(base_role)) > 0
      AND provider IS NOT NULL AND length(trim(provider)) > 0
      AND model_id IS NOT NULL AND length(trim(model_id)) > 0
      AND credential_profile_id IS NOT NULL AND length(trim(credential_profile_id)) > 0
      AND account_source IS NOT NULL AND length(trim(account_source)) > 0
      AND default_thinking IS NOT NULL AND length(trim(default_thinking)) > 0
      AND hard_max_thinking IS NOT NULL AND length(trim(hard_max_thinking)) > 0
      AND execution_profile_id IS NOT NULL AND length(trim(execution_profile_id)) > 0
      AND contract_id IS NOT NULL AND length(trim(contract_id)) > 0
      AND contract_version IS NOT NULL AND contract_version > 0
      AND created_at_ms IS NOT NULL AND updated_at_ms IS NOT NULL
      AND activity_at_ms IS NOT NULL)
  )
);

CREATE INDEX subagent_threads_parent_idx
  ON subagent_threads(parent_session_id, activity_at_ms DESC)
  WHERE is_member = 1;
CREATE INDEX subagent_threads_registry_idx
  ON subagent_threads(activity_at_ms DESC, id)
  WHERE is_member = 1;

CREATE TABLE subagent_runs (
  id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL REFERENCES subagent_threads(id),
  thread_seq INTEGER NOT NULL CHECK (thread_seq > 0),
  initiated_by TEXT CHECK (initiated_by IS NULL OR initiated_by IN ('human', 'agent')),

  triggering_peer_prompt_id TEXT,
  required_response_message_id TEXT,
  required_response_state TEXT NOT NULL DEFAULT 'none'
    CHECK (required_response_state IN ('none', 'outstanding', 'answered')),
  required_response_answer_message_id TEXT,
  optional_result_correlation_id TEXT,

  contract_id TEXT,
  contract_version INTEGER,
  actual_thinking TEXT,
  governing_lease_id TEXT,
  predecessor_turn_id TEXT,
  review_target_json TEXT,

  status TEXT NOT NULL CHECK (status IN (
    'pending', 'running', 'awaiting-parent',
    'submitted', 'unreported', 'failed', 'stopped', 'lost'
  )),
  active_phase TEXT CHECK (active_phase IS NULL OR active_phase IN (
    'pending-dispatch', 'predecessor-wait', 'provider-admitted',
    'nudge-reserved', 'nudge-admitted', 'result-accepted',
    'stop-requested', 'safe-idle', 'watchdog', 'awaiting-parent'
  )),
  execution_quiescent INTEGER NOT NULL DEFAULT 1 CHECK (execution_quiescent IN (0, 1)),

  watchdog_state TEXT NOT NULL DEFAULT 'unused'
    CHECK (watchdog_state IN ('unused', 'reserved', 'admitted', 'completed')),
  watchdog_trigger_completion_id TEXT,
  watchdog_admitted_completion_id TEXT,
  watchdog_completed_completion_id TEXT,

  accepted_reported_status TEXT,
  accepted_summary TEXT,
  accepted_payload_json TEXT,
  accepted_host_facts_json TEXT,
  result_accepted_at_ms INTEGER,

  stop_requested_at_ms INTEGER,
  stop_request_reason TEXT,
  quiescence_completion_id TEXT,
  quiescent_at_ms INTEGER,
  terminal_reason TEXT,
  terminal_verdict TEXT,

  opening_input_tokens INTEGER NOT NULL DEFAULT 0 CHECK (opening_input_tokens >= 0),
  opening_output_tokens INTEGER NOT NULL DEFAULT 0 CHECK (opening_output_tokens >= 0),
  opening_cache_read_tokens INTEGER NOT NULL DEFAULT 0 CHECK (opening_cache_read_tokens >= 0),
  opening_cache_write_tokens INTEGER NOT NULL DEFAULT 0 CHECK (opening_cache_write_tokens >= 0),
  opening_cost_micros INTEGER CHECK (opening_cost_micros IS NULL OR opening_cost_micros >= 0),
  delta_input_tokens INTEGER NOT NULL DEFAULT 0 CHECK (delta_input_tokens >= 0),
  delta_output_tokens INTEGER NOT NULL DEFAULT 0 CHECK (delta_output_tokens >= 0),
  delta_cache_read_tokens INTEGER NOT NULL DEFAULT 0 CHECK (delta_cache_read_tokens >= 0),
  delta_cache_write_tokens INTEGER NOT NULL DEFAULT 0 CHECK (delta_cache_write_tokens >= 0),
  delta_cost_micros INTEGER CHECK (delta_cost_micros IS NULL OR delta_cost_micros >= 0),
  usage_state TEXT NOT NULL DEFAULT 'current' CHECK (usage_state IN ('current', 'final')),
  usage_completeness TEXT NOT NULL DEFAULT 'partial' CHECK (usage_completeness IN ('partial', 'complete')),
  usage_completion_id TEXT,

  created_at_ms INTEGER,
  updated_at_ms INTEGER,
  terminal_at_ms INTEGER,
  result_message_id TEXT UNIQUE,

  revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
  is_member INTEGER NOT NULL DEFAULT 1 CHECK (is_member IN (0, 1)),
  deleted_at_ms INTEGER,

  UNIQUE (thread_id, thread_seq),
  CHECK (
    (is_member = 0 AND deleted_at_ms IS NOT NULL)
    OR
    (is_member = 1 AND deleted_at_ms IS NULL
      AND initiated_by IS NOT NULL
      AND contract_id IS NOT NULL AND length(trim(contract_id)) > 0
      AND contract_version IS NOT NULL AND contract_version > 0
      AND actual_thinking IS NOT NULL AND length(trim(actual_thinking)) > 0
      AND created_at_ms IS NOT NULL AND updated_at_ms IS NOT NULL)
  ),
  CHECK (
    (status IN ('pending', 'running', 'awaiting-parent') AND active_phase IS NOT NULL AND terminal_at_ms IS NULL)
    OR
    (status IN ('submitted', 'unreported', 'failed', 'stopped', 'lost') AND active_phase IS NULL AND terminal_at_ms IS NOT NULL AND execution_quiescent = 1)
  ),
  CHECK (
    status <> 'awaiting-parent'
    OR (active_phase = 'awaiting-parent' AND required_response_state = 'outstanding'
        AND required_response_message_id IS NOT NULL AND execution_quiescent = 1)
  ),
  CHECK (
    required_response_state <> 'outstanding'
    OR required_response_message_id IS NOT NULL
  ),
  CHECK (
    (result_accepted_at_ms IS NULL AND accepted_reported_status IS NULL AND accepted_summary IS NULL
      AND accepted_payload_json IS NULL AND accepted_host_facts_json IS NULL)
    OR
    (result_accepted_at_ms IS NOT NULL AND accepted_reported_status IS NOT NULL AND accepted_summary IS NOT NULL
      AND accepted_payload_json IS NOT NULL AND accepted_host_facts_json IS NOT NULL)
  ),
  CHECK (NOT (result_accepted_at_ms IS NOT NULL AND stop_requested_at_ms IS NOT NULL))
);

CREATE INDEX subagent_runs_thread_idx
  ON subagent_runs(thread_id, thread_seq DESC)
  WHERE is_member = 1;
CREATE INDEX subagent_runs_status_idx
  ON subagent_runs(status, updated_at_ms DESC)
  WHERE is_member = 1;

-- A next run cannot establish its opening usage baseline while an earlier run
-- is active OR while terminal host/provider execution is still not quiescent.
CREATE UNIQUE INDEX subagent_runs_one_live_execution_idx
  ON subagent_runs(thread_id)
  WHERE is_member = 1 AND (
    status IN ('pending', 'running', 'awaiting-parent')
    OR execution_quiescent = 0
  );
