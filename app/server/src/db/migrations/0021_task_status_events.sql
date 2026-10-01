-- Durable Task status-change provenance (Daily Scanner v2, Task 133).
-- The tasks row records who created a Task but not who later changed its
-- status; the day scanner must distinguish user progress on scanner-created
-- Tasks (genuine activity) from its own or other agents' projection updates.
CREATE TABLE task_status_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id INTEGER NOT NULL,
  from_status TEXT NOT NULL,
  to_status TEXT NOT NULL,
  actor_kind TEXT NOT NULL CHECK (actor_kind IN ('user', 'agent', 'system')),
  -- Optional stable actor id: a session id for agents, a subsystem name for system actors.
  actor_id TEXT,
  at_ms INTEGER NOT NULL
);

CREATE INDEX task_status_events_task_idx ON task_status_events (task_id, at_ms);
CREATE INDEX task_status_events_window_idx ON task_status_events (at_ms);
