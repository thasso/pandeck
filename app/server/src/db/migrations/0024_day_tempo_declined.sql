-- Task 144: a first-class user-facing DECLINE for a Tempo proposal — a
-- deliberate "don't log this" terminal decision, distinct from `cancelled`
-- (proactive invalidation of a dropped/superseded row). SQLite cannot alter a
-- CHECK constraint in place, so rebuild the table widening `status` to include
-- `declined`. No foreign keys reference this table, so no FK-off marker is
-- needed; the copy preserves every existing row and its status.
CREATE TABLE day_tempo_proposals_new (
  id TEXT PRIMARY KEY,
  date TEXT NOT NULL,
  issue_key TEXT NOT NULL,
  start_time TEXT,
  duration_seconds INTEGER NOT NULL,
  activity_key TEXT,
  description TEXT,
  evidence_json TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL CHECK (status IN (
    'proposed', 'user-edited', 'dropped', 'pending-approval',
    'executing', 'executed', 'partial', 'failed', 'cancelled', 'declined'
  )),
  proposal_entry_id TEXT,
  result_entry_id TEXT,
  result_worklog_id TEXT,
  updated_at_ms INTEGER NOT NULL
);

INSERT INTO day_tempo_proposals_new
  SELECT id, date, issue_key, start_time, duration_seconds, activity_key, description,
         evidence_json, status, proposal_entry_id, result_entry_id, result_worklog_id, updated_at_ms
  FROM day_tempo_proposals;

DROP TABLE day_tempo_proposals;
ALTER TABLE day_tempo_proposals_new RENAME TO day_tempo_proposals;

CREATE INDEX day_tempo_proposals_date_idx ON day_tempo_proposals (date, updated_at_ms);
