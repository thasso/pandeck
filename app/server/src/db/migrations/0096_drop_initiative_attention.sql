-- Initiatives left the Sessions inbox (docs/initiatives.md): they are browsed
-- under Projects and have no attention cursor or manual Attention position.
-- Rebuild without those columns; every other column and row is preserved.
CREATE TABLE initiatives_plain (
  id INTEGER PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  state TEXT NOT NULL DEFAULT 'active' CHECK (state IN ('active','paused','done')),
  revision INTEGER NOT NULL DEFAULT 0,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  archived_at_ms INTEGER,
  deleted_at_ms INTEGER
);
INSERT INTO initiatives_plain (
  id, title, description, state, revision,
  created_at_ms, updated_at_ms, archived_at_ms, deleted_at_ms
)
SELECT id, title, description, state, revision,
       created_at_ms, updated_at_ms, archived_at_ms, deleted_at_ms
  FROM initiatives;
DROP TABLE initiatives;
ALTER TABLE initiatives_plain RENAME TO initiatives;

-- The summary lost its attention fields, so cached state digests must not
-- match on reconnect.
INSERT INTO sequences (entity_type, next_id) VALUES ('initiative_revision', 1)
ON CONFLICT(entity_type) DO UPDATE SET next_id = next_id + 1;
UPDATE initiatives
   SET revision = (SELECT next_id FROM sequences WHERE entity_type = 'initiative_revision');
