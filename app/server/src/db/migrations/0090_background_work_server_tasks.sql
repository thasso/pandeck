-- Background work PA's own server runs (`server-task`): a pull-request check
-- watch first, ref-check waits, image pulls and merge-when-ready next.
--
-- SQLite cannot alter a CHECK, so the table is rebuilt once with exactly three
-- constraints widened and everything else unchanged — every column in its
-- current order (0054, then 0059's description/command, 0067's intent, 0076's
-- stop_origin), every default, reference, UNIQUE and other CHECK, and the six
-- indexes under their old names:
--
--   - backend also accepts 'server-task';
--   - kind also accepts 'check-watch', 'image-pull' and 'merge-when-ready', so
--     the pieces that add the last two need no second rebuild;
--   - a 'server-task' row is hostless, like a 'host-process' one: it has no
--     retained provider epoch to belong to.
--
-- Rows are copied verbatim, revisions and tombstones included, so no
-- projection changes. Foreign keys stay ON: nothing references this table, and
-- the copy checks each row's session and host references as it is inserted.
CREATE TABLE background_work_items_next (
  id TEXT PRIMARY KEY,
  owner_session_id TEXT NOT NULL REFERENCES session_index(id),
  host_id TEXT REFERENCES background_hosts(id),
  backend TEXT NOT NULL CHECK (backend IN ('claude-query', 'host-process', 'server-task')),
  kind TEXT NOT NULL CHECK (kind IN (
    'shell', 'monitor-command', 'monitor-websocket',
    'check-watch', 'image-pull', 'merge-when-ready'
  )),
  label TEXT NOT NULL CHECK (length(trim(label)) > 0),
  source_request_id TEXT NOT NULL,
  provenance TEXT NOT NULL CHECK (provenance IN (
    'reserved', 'observed-adopted', 'observed-over-cap'
  )),

  provider_task_id TEXT,
  provider_task_type TEXT,

  state TEXT NOT NULL CHECK (state IN (
    'pending-launch', 'running',
    'completed', 'failed', 'not-started', 'stopped', 'lost'
  )),
  stop_state TEXT NOT NULL DEFAULT 'none' CHECK (stop_state IN (
    'none', 'requested', 'awaiting-binding', 'unconfirmed'
  )),
  stop_reason TEXT,
  stop_requested_at_ms INTEGER,
  stop_attempts INTEGER NOT NULL DEFAULT 0 CHECK (stop_attempts >= 0),
  stop_last_attempt_at_ms INTEGER,
  stop_ack_deadline_at_ms INTEGER,
  stop_source_request_id TEXT,
  stop_evidence TEXT,
  drain_reason TEXT,

  lifetime_ms INTEGER NOT NULL CHECK (lifetime_ms > 0),
  deadline_at_ms INTEGER NOT NULL,
  settings_generation INTEGER NOT NULL CHECK (settings_generation >= 0),
  boot_epoch TEXT NOT NULL,

  exit_code INTEGER,
  outcome_summary TEXT,
  terminal_reason TEXT,

  evidence_artifact_id TEXT,
  evidence_original_bytes INTEGER CHECK (
    evidence_original_bytes IS NULL OR evidence_original_bytes >= 0
  ),
  evidence_captured_bytes INTEGER CHECK (
    evidence_captured_bytes IS NULL OR evidence_captured_bytes >= 0
  ),
  evidence_truncated INTEGER NOT NULL DEFAULT 0 CHECK (evidence_truncated IN (0, 1)),
  evidence_text INTEGER NOT NULL DEFAULT 0 CHECK (evidence_text IN (0, 1)),
  evidence_refusal_reason TEXT,

  last_event_id TEXT,
  last_event_seq INTEGER CHECK (last_event_seq IS NULL OR last_event_seq >= 0),

  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  started_at_ms INTEGER,
  terminal_at_ms INTEGER,

  revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
  is_member INTEGER NOT NULL DEFAULT 1 CHECK (is_member IN (0, 1)),
  deleted_at_ms INTEGER,

  description TEXT,
  command TEXT,
  command_truncated INTEGER NOT NULL DEFAULT 0
    CHECK (command_truncated IN (0, 1)),
  intent TEXT NOT NULL DEFAULT 'awaited'
    CHECK (intent IN ('awaited', 'service')),
  stop_origin TEXT CHECK (stop_origin IN ('requester', 'deadline', 'system')),

  UNIQUE (owner_session_id, source_request_id),
  CHECK (
    (is_member = 0 AND deleted_at_ms IS NOT NULL)
    OR (is_member = 1 AND deleted_at_ms IS NULL)
  ),
  CHECK (
    (state IN ('pending-launch', 'running') AND terminal_at_ms IS NULL)
    OR
    (state IN ('completed', 'failed', 'not-started', 'stopped', 'lost')
      AND terminal_at_ms IS NOT NULL AND stop_state <> 'unconfirmed')
  ),
  CHECK (state <> 'running' OR started_at_ms IS NOT NULL),
  CHECK (stop_state = 'none' OR stop_requested_at_ms IS NOT NULL),
  CHECK (
    (backend = 'claude-query' AND host_id IS NOT NULL)
    OR (backend IN ('host-process', 'server-task') AND host_id IS NULL)
  ),
  CHECK (provider_task_id IS NULL OR host_id IS NOT NULL),
  CHECK (provider_task_type IS NULL OR provider_task_id IS NOT NULL),
  CHECK (
    evidence_original_bytes IS NULL
    OR evidence_captured_bytes IS NULL
    OR evidence_captured_bytes <= evidence_original_bytes
  ),
  CHECK (
    evidence_truncated = 0
    OR (evidence_captured_bytes IS NOT NULL AND evidence_original_bytes IS NOT NULL)
  )
);

INSERT INTO background_work_items_next (
  id, owner_session_id, host_id, backend, kind, label, source_request_id,
  provenance, provider_task_id, provider_task_type, state, stop_state,
  stop_reason, stop_requested_at_ms, stop_attempts, stop_last_attempt_at_ms,
  stop_ack_deadline_at_ms, stop_source_request_id, stop_evidence, drain_reason,
  lifetime_ms, deadline_at_ms, settings_generation, boot_epoch, exit_code,
  outcome_summary, terminal_reason, evidence_artifact_id,
  evidence_original_bytes, evidence_captured_bytes, evidence_truncated,
  evidence_text, evidence_refusal_reason, last_event_id, last_event_seq,
  created_at_ms, updated_at_ms, started_at_ms, terminal_at_ms, revision,
  is_member, deleted_at_ms, description, command, command_truncated, intent,
  stop_origin
)
SELECT
  id, owner_session_id, host_id, backend, kind, label, source_request_id,
  provenance, provider_task_id, provider_task_type, state, stop_state,
  stop_reason, stop_requested_at_ms, stop_attempts, stop_last_attempt_at_ms,
  stop_ack_deadline_at_ms, stop_source_request_id, stop_evidence, drain_reason,
  lifetime_ms, deadline_at_ms, settings_generation, boot_epoch, exit_code,
  outcome_summary, terminal_reason, evidence_artifact_id,
  evidence_original_bytes, evidence_captured_bytes, evidence_truncated,
  evidence_text, evidence_refusal_reason, last_event_id, last_event_seq,
  created_at_ms, updated_at_ms, started_at_ms, terminal_at_ms, revision,
  is_member, deleted_at_ms, description, command, command_truncated, intent,
  stop_origin
FROM background_work_items;

DROP TABLE background_work_items;
ALTER TABLE background_work_items_next RENAME TO background_work_items;

CREATE INDEX background_work_items_registry_idx
  ON background_work_items(created_at_ms DESC, id)
  WHERE is_member = 1;

CREATE INDEX background_work_items_owner_active_idx
  ON background_work_items(owner_session_id, state)
  WHERE is_member = 1 AND state IN ('pending-launch', 'running');

CREATE INDEX background_work_items_owner_idx
  ON background_work_items(owner_session_id, created_at_ms DESC)
  WHERE is_member = 1;

CREATE INDEX background_work_items_host_idx
  ON background_work_items(host_id)
  WHERE is_member = 1 AND host_id IS NOT NULL;

CREATE INDEX background_work_items_boot_idx
  ON background_work_items(boot_epoch)
  WHERE is_member = 1 AND state IN ('pending-launch', 'running');

CREATE UNIQUE INDEX background_work_items_provider_binding_idx
  ON background_work_items(host_id, provider_task_id)
  WHERE provider_task_id IS NOT NULL;
