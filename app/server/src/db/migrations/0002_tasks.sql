-- Tasks → SQLite (see docs/tasks/PLAN.md).
--
-- Design: columns = a task's own attributes; every relationship to another node
-- is an edge in the generic `links` table. Integer PKs are allocated per entity
-- type from `sequences` (contiguous +1 per type), surfaced as `Task-<n>`.

CREATE TABLE sequences (
  entity_type TEXT PRIMARY KEY,
  next_id     INTEGER NOT NULL
);

CREATE TABLE tasks (
  id              INTEGER PRIMARY KEY,   -- allocated from sequences('task')
  title           TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'todo'   CHECK (status   IN ('todo','doing','done')),
  priority        TEXT NOT NULL DEFAULT 'normal' CHECK (priority IN ('low','normal','high','urgent')),
  description     TEXT NOT NULL DEFAULT '',
  due_date        TEXT,                  -- 'YYYY-MM-DD'
  created_by      TEXT NOT NULL DEFAULT 'agent' CHECK (created_by IN ('user','agent')),
  created_at_ms   INTEGER NOT NULL,
  updated_at_ms   INTEGER NOT NULL,
  completed_at_ms INTEGER,
  archived_at_ms  INTEGER,
  deleted_at_ms   INTEGER
);

CREATE INDEX tasks_status_idx ON tasks(status) WHERE deleted_at_ms IS NULL;

CREATE TABLE workflows (
  id            INTEGER PRIMARY KEY,     -- allocated from sequences('workflow')
  state_json    TEXT NOT NULL,           -- the existing TaskWorkflow blob, intact
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  deleted_at_ms INTEGER
);

-- Generic directed, labeled, ordered graph edge. Node = (type, id); ids are text
-- so any entity (integer task ids as strings, session uuids, jira keys, urls) can
-- participate. No foreign keys (polymorphic) — integrity is enforced app-side,
-- and edges are cleaned up when an entity is removed.
CREATE TABLE links (
  from_type     TEXT NOT NULL,
  from_id       TEXT NOT NULL,
  relation      TEXT NOT NULL,
  to_type       TEXT NOT NULL,
  to_id         TEXT NOT NULL,
  position      INTEGER,                 -- ordered relations (subtask); else NULL
  metadata_json TEXT,
  created_at_ms INTEGER NOT NULL,
  PRIMARY KEY (from_type, from_id, relation, to_type, to_id)
);

CREATE INDEX links_to_idx   ON links(to_type, to_id, relation);
CREATE INDEX links_from_idx ON links(from_type, from_id, relation, position);
