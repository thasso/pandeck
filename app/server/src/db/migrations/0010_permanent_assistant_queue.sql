CREATE TABLE permanent_assistant_state (
  singleton_id INTEGER PRIMARY KEY CHECK (singleton_id = 1),
  session_id TEXT,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL
);

CREATE TABLE permanent_assistant_queue (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  dedupe_key TEXT NOT NULL UNIQUE,
  source TEXT NOT NULL CHECK (source IN ('web','slack')),
  source_metadata_json TEXT NOT NULL DEFAULT '{}',
  text TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','working','completed','failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  created_at_ms INTEGER NOT NULL,
  started_at_ms INTEGER,
  completed_at_ms INTEGER
);

CREATE INDEX permanent_assistant_queue_status_idx
  ON permanent_assistant_queue(status, id);
