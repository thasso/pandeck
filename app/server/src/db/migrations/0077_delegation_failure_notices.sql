-- Server-generated notices to a coordinator whose delegated work stopped on a
-- failure (`delegationFailureNotice.ts`).
--
-- One row per (incident, coordinator): the incident is the failed run of the
-- child, or the peer prompt whose delivery gave up, so a duplicate event or a
-- restart cannot announce one failure twice. A row is written in the same
-- synchronous step that records the failure, before any listener runs, and is
-- retired when the notice turn is admitted to the coordinator's log (or dropped
-- when either session is deleted or archived first).
--
-- Only identities and safe structured facts: the category is a fixed
-- vocabulary and the reset time is stored only when the harness reported it as
-- a structured field. No provider message, prompt, tool output or credential is
-- stored here.
--
-- The table starts empty: no historical failure is announced by this build.
CREATE TABLE delegation_failure_notices (
  id TEXT PRIMARY KEY,
  incident_key TEXT NOT NULL,
  child_session_id TEXT NOT NULL,
  coordinator_session_id TEXT NOT NULL,
  route TEXT NOT NULL CHECK (route IN ('spawn', 'request')),
  category TEXT NOT NULL,
  reset_at_ms INTEGER,
  request_ids_json TEXT NOT NULL DEFAULT '[]',
  chain_id TEXT,
  conversation_id TEXT,
  hop INTEGER,
  failed_at_ms INTEGER NOT NULL,
  created_at_ms INTEGER NOT NULL,
  delivered_at_ms INTEGER,
  dropped_at_ms INTEGER,
  drop_reason TEXT,
  UNIQUE (incident_key, coordinator_session_id)
);

CREATE INDEX delegation_failure_notices_pending_idx
  ON delegation_failure_notices (coordinator_session_id, created_at_ms)
  WHERE delivered_at_ms IS NULL AND dropped_at_ms IS NULL;

CREATE INDEX delegation_failure_notices_child_pending_idx
  ON delegation_failure_notices (child_session_id)
  WHERE delivered_at_ms IS NULL AND dropped_at_ms IS NULL;
