-- Initiative attention now includes ordinary activity, including while active.
-- Rebuild to widen the attention_kind CHECK; all existing columns are preserved.
CREATE TABLE initiatives_inbox (
  id INTEGER PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  state TEXT NOT NULL DEFAULT 'active' CHECK (state IN ('active','paused','done')),
  revision INTEGER NOT NULL DEFAULT 0,
  attention_revision INTEGER NOT NULL DEFAULT 0,
  attention_settled_revision INTEGER NOT NULL DEFAULT 0,
  attention_kind TEXT CHECK (attention_kind IN ('activity','paused','done')),
  attention_at_ms INTEGER,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  archived_at_ms INTEGER,
  deleted_at_ms INTEGER,
  inbox_position REAL
);
INSERT INTO initiatives_inbox (
  id, title, description, state, revision, attention_revision,
  attention_settled_revision, attention_kind, attention_at_ms,
  created_at_ms, updated_at_ms, archived_at_ms, deleted_at_ms
)
SELECT id, title, description, state, revision,
       attention_revision + CASE WHEN state = 'active' THEN 1 ELSE 0 END,
       attention_settled_revision,
       CASE WHEN state = 'active' THEN 'activity' ELSE attention_kind END,
       CASE WHEN state = 'active' THEN updated_at_ms ELSE attention_at_ms END,
       created_at_ms, updated_at_ms, archived_at_ms, deleted_at_ms
  FROM initiatives;
DROP TABLE initiatives;
ALTER TABLE initiatives_inbox RENAME TO initiatives;

-- Changed attention must invalidate cached state digests on reconnect too.
INSERT INTO sequences (entity_type, next_id) VALUES ('initiative_revision', 1)
ON CONFLICT(entity_type) DO UPDATE SET next_id = next_id + 1;
UPDATE initiatives
   SET revision = (SELECT next_id FROM sequences WHERE entity_type = 'initiative_revision')
 WHERE state = 'active';
