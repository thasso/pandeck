-- Schedules (docs/schedules.md): a prompt sent at a wall-clock time, once or
-- repeating, and the occurrences the schedule clock claims from it.
--
-- A Schedule is a state-sync domain: every write stamps `revision` from the
-- `schedule_revision` sequence. A deleted Schedule stays as a tombstone
-- (`deleted_at_ms`) carrying the revision of its delete, so a resubscribing
-- client learns of it; maintenance purges tombstones after 30 days.
--
-- The target is an open union: `target_kind` names it, and an existing-session
-- target keeps its session in `target_session_id`. A later kind adds its own
-- columns rather than rebuilding this table.
CREATE TABLE schedules (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  prompt TEXT NOT NULL,
  enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
  timing_json TEXT NOT NULL,
  target_kind TEXT NOT NULL,
  target_session_id TEXT,
  created_by_json TEXT NOT NULL,
  controlled_by_json TEXT NOT NULL,
  cardless INTEGER NOT NULL DEFAULT 0 CHECK (cardless IN (0, 1)),
  next_due_at_ms INTEGER,
  done_at_ms INTEGER,
  revision INTEGER NOT NULL DEFAULT 0,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  deleted_at_ms INTEGER,
  CHECK (target_kind <> 'session' OR target_session_id IS NOT NULL)
);

CREATE INDEX schedules_next_due
  ON schedules (enabled, next_due_at_ms)
  WHERE deleted_at_ms IS NULL;
CREATE INDEX schedules_target_session
  ON schedules (target_session_id)
  WHERE deleted_at_ms IS NULL;
CREATE INDEX schedules_revision ON schedules (revision);

-- One due time of a Schedule and what became of it. `claimed` is the one open
-- state (the occurrence is owed) and the only one without `ended_at_ms`.
-- Claiming copies the prompt, name, zone and target here (the frozen input):
-- delivery reads only this copy, never the Schedule. A `missed` row recorded
-- without a claim has no `claimed_at_ms`. `attempted_at_ms` marks a delivery
-- attempt, for crash recovery.
CREATE TABLE schedule_occurrences (
  id TEXT PRIMARY KEY,
  schedule_id TEXT NOT NULL REFERENCES schedules (id) ON DELETE CASCADE,
  due_at_ms INTEGER NOT NULL,
  claimed_at_ms INTEGER,
  state TEXT NOT NULL CHECK (state IN (
    'claimed', 'delivered', 'started', 'superseded', 'withdrawn', 'failed',
    'missed'
  )),
  prompt TEXT NOT NULL,
  name TEXT NOT NULL,
  time_zone TEXT NOT NULL,
  target_kind TEXT NOT NULL,
  target_session_id TEXT,
  attempted_at_ms INTEGER,
  session_id TEXT,
  error TEXT,
  ended_at_ms INTEGER,
  UNIQUE (schedule_id, due_at_ms),
  CHECK ((state = 'claimed') = (ended_at_ms IS NULL)),
  CHECK (state = 'missed' OR claimed_at_ms IS NOT NULL)
);

CREATE INDEX schedule_occurrences_target_state
  ON schedule_occurrences (target_session_id, state);
CREATE INDEX schedule_occurrences_schedule_state
  ON schedule_occurrences (schedule_id, state);
