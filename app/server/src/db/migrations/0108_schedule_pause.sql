-- Pause all for Schedules (docs/schedules.md, Pause all): one row, written by
-- the transaction that settles every due Schedule under the state before the
-- switch. No seed row: the row's presence marks that the pause intent once
-- kept in settings/app.json (`schedules.paused`) was imported. The first read
-- inserts it from that file; after that the file is never read for it again.
CREATE TABLE schedule_pause (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  paused INTEGER NOT NULL CHECK (paused IN (0, 1))
);
