-- Durable, provider-neutral session-owned background work (Task-482).
--
-- One `background_work_items` row IS the object: PA id, owning session, backend
-- and kind, bounded label, legal state, frozen deadline/settings generation and
-- bounded outcome/evidence metadata. Vendor task ids, OS process ids, paths,
-- environment, credentials and raw output are deliberately absent — the only
-- provider handle stored is the nullable authoritative binding, and it is
-- scoped to its host epoch rather than treated as globally stable.
--
-- `background_hosts` is the OPTIONAL Claude-only retained query epoch. It is
-- created lazily when the first background item on the current query is
-- admitted or unexpectedly observed, so an ordinary transient query never
-- writes a row here. At most one live epoch per owner session (the partial
-- unique index below), reused by every later child of that owner.
--
-- Owner-slot capacity is DERIVED, never a second bookkeeping table: a session
-- holds a slot exactly while it has one nonterminal item or a live host epoch,
-- so it cannot leak. A launch that never happened gives the slot back through
-- the store's explicit `failLaunch` or pre-launch owner Stop — the only two
-- paths that may conclude nothing ran — while an ordinary runtime
-- terminalization releases no reservation.
--
-- Revisions come from sequences('background_work_revision') and are stamped by
-- backgroundWorkStore inside the same transaction as each write; `is_member` +
-- `deleted_at_ms` are the state-sync tombstone seam (Task-490 owns the deletion
-- that uses it). `boot_epoch` is what makes restart honest: no row written by a
-- previous server process may claim to still be executing.

CREATE TABLE background_hosts (
  id TEXT PRIMARY KEY,
  owner_session_id TEXT NOT NULL REFERENCES session_index(id),
  -- Only Claude retains a host today; pi work is supervised per process.
  backend TEXT NOT NULL CHECK (backend IN ('claude-query')),
  -- PA-generated correlation for one retained query instance. Never a vendor id.
  epoch_key TEXT NOT NULL,
  boot_epoch TEXT NOT NULL,
  -- How the epoch came to exist, mirroring the item vocabulary. An
  -- `observed-over-cap` epoch was seen executing when no owner slot was left:
  -- it is counted, never evicted, and never a slot its owner may reuse.
  provenance TEXT NOT NULL CHECK (provenance IN (
    'reserved', 'observed-adopted', 'observed-over-cap'
  )),

  state TEXT NOT NULL CHECK (state IN (
    'creating', 'live', 'draining', 'closed', 'stopped', 'lost'
  )),
  stop_all_requested_at_ms INTEGER,
  stop_all_reason TEXT,

  empty_grace_ms INTEGER NOT NULL CHECK (empty_grace_ms >= 0),
  settings_generation INTEGER NOT NULL CHECK (settings_generation >= 0),

  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  closed_at_ms INTEGER,
  terminal_reason TEXT,

  revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),

  CHECK (
    (state IN ('creating', 'live', 'draining') AND closed_at_ms IS NULL)
    OR
    (state IN ('closed', 'stopped', 'lost') AND closed_at_ms IS NOT NULL)
  ),
  CHECK (
    stop_all_requested_at_ms IS NOT NULL OR stop_all_reason IS NULL
  )
);

CREATE UNIQUE INDEX background_hosts_epoch_key_idx
  ON background_hosts(epoch_key);

-- One live retained epoch per owner session; later children reuse it.
CREATE UNIQUE INDEX background_hosts_one_live_per_owner_idx
  ON background_hosts(owner_session_id)
  WHERE state IN ('creating', 'live', 'draining');

CREATE INDEX background_hosts_boot_idx
  ON background_hosts(boot_epoch)
  WHERE state IN ('creating', 'live', 'draining');

CREATE TABLE background_work_items (
  id TEXT PRIMARY KEY,
  owner_session_id TEXT NOT NULL REFERENCES session_index(id),
  host_id TEXT REFERENCES background_hosts(id),
  backend TEXT NOT NULL CHECK (backend IN ('claude-query', 'host-process')),
  kind TEXT NOT NULL CHECK (kind IN (
    'shell', 'monitor-command', 'monitor-websocket'
  )),
  -- Bounded, human-readable; never the full command line or a host path.
  label TEXT NOT NULL CHECK (length(trim(label)) > 0),
  -- The caller's request identity (a tool_use_id or PA request id): repeating
  -- it reserves nothing new, so a retried admission is idempotent.
  source_request_id TEXT NOT NULL,
  -- `reserved` is the only normal path. `observed-adopted` / `observed-over-cap`
  -- are degraded reconciliation outcomes for work already executing without a
  -- reservation; the latter is counted and never admits more work.
  provenance TEXT NOT NULL CHECK (provenance IN (
    'reserved', 'observed-adopted', 'observed-over-cap'
  )),

  -- Authoritatively bound provider handle, scoped to its host epoch.
  provider_task_id TEXT,
  provider_task_type TEXT,

  state TEXT NOT NULL CHECK (state IN (
    'pending-launch', 'running',
    'completed', 'failed', 'not-started', 'stopped', 'lost'
  )),
  -- Stop is REQUEST metadata on a still-nonterminal row, never a fabricated
  -- terminal state: `unconfirmed` may still be answered by later evidence or a
  -- new explicit attempt.
  stop_state TEXT NOT NULL DEFAULT 'none' CHECK (stop_state IN (
    'none', 'requested', 'awaiting-binding', 'unconfirmed'
  )),
  stop_reason TEXT,
  stop_requested_at_ms INTEGER,
  stop_attempts INTEGER NOT NULL DEFAULT 0 CHECK (stop_attempts >= 0),
  stop_last_attempt_at_ms INTEGER,
  stop_ack_deadline_at_ms INTEGER,
  -- Idempotency key of the Stop request itself: a repeat records no attempt.
  stop_source_request_id TEXT,
  -- Bounded evidence for an unanswered Stop; never a signal, pid or log.
  stop_evidence TEXT,
  -- Reserved by a planned deployment drain; boot reconciliation honours it
  -- instead of overwriting it with an unclean loss.
  drain_reason TEXT,

  lifetime_ms INTEGER NOT NULL CHECK (lifetime_ms > 0),
  deadline_at_ms INTEGER NOT NULL,
  settings_generation INTEGER NOT NULL CHECK (settings_generation >= 0),
  boot_epoch TEXT NOT NULL,

  -- Bounded completion facts. No output body, path, environment or exit signal
  -- detail beyond the code the harness reported.
  exit_code INTEGER,
  outcome_summary TEXT,
  terminal_reason TEXT,

  -- Immutable evidence IDENTITY only: the artifact itself lives in the
  -- authenticated artifact mechanism and never in this row.
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

  -- Out-of-order and duplicate provider evidence guard.
  last_event_id TEXT,
  last_event_seq INTEGER CHECK (last_event_seq IS NULL OR last_event_seq >= 0),

  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  started_at_ms INTEGER,
  terminal_at_ms INTEGER,

  revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
  is_member INTEGER NOT NULL DEFAULT 1 CHECK (is_member IN (0, 1)),
  deleted_at_ms INTEGER,

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
  -- Claude background work ALWAYS belongs to a retained epoch: it is the query
  -- that executes it and the only scope in which its handle means anything, so
  -- a hostless `claude-query` row could never bind or be stopped.
  CHECK (
    (backend = 'claude-query' AND host_id IS NOT NULL)
    OR (backend = 'host-process' AND host_id IS NULL)
  ),
  CHECK (provider_task_id IS NULL OR host_id IS NOT NULL),
  CHECK (provider_task_type IS NULL OR provider_task_id IS NOT NULL),
  -- Evidence facts have to be internally coherent: we cannot have captured
  -- more than existed, and a size without an artifact describes nothing.
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

-- The registry read: newest first over live rows.
CREATE INDEX background_work_items_registry_idx
  ON background_work_items(created_at_ms DESC, id)
  WHERE is_member = 1;

-- Owner activity + derived owner-slot capacity, both restricted to live work.
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

-- One authoritative provider binding per host epoch. Vendor ids are only ever
-- unique WITHIN their epoch, which is exactly what this expresses.
CREATE UNIQUE INDEX background_work_items_provider_binding_idx
  ON background_work_items(host_id, provider_task_id)
  WHERE provider_task_id IS NOT NULL;
