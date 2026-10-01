-- Daily Scanner v2 Tempo logging assistant (Task 138, plan Decision #7 / phase 6).
-- The persisted proposal is a serialized state machine: exactly ONE transition
-- may win (pending-approval -> executing -> executed/partial/failed, OR
-- pending-approval -> cancelled), enforced by status-guarded UPDATEs. Durable
-- linkage lives here too: the row id IS the Tempo `clientId`, plus the
-- persisted proposal/result entry ids and the returned worklog id, so
-- reconciliation against real Tempo worklogs is deterministic.
CREATE TABLE day_tempo_proposals (
  -- The stable row id, passed as the Tempo item clientId.
  id TEXT PRIMARY KEY,
  date TEXT NOT NULL,
  issue_key TEXT NOT NULL,
  start_time TEXT,
  duration_seconds INTEGER NOT NULL,
  activity_key TEXT,
  description TEXT,
  -- Compact JSON of evidence refs (pa:// links / source ids) — never bodies.
  evidence_json TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL CHECK (status IN (
    'proposed', 'user-edited', 'dropped', 'pending-approval',
    'executing', 'executed', 'partial', 'failed', 'cancelled'
  )),
  proposal_entry_id TEXT,
  result_entry_id TEXT,
  result_worklog_id TEXT,
  updated_at_ms INTEGER NOT NULL
);

CREATE INDEX day_tempo_proposals_date_idx ON day_tempo_proposals (date, updated_at_ms);
