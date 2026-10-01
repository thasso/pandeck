-- assistant:migration:foreign_keys_off
-- Widen memory_load_batches.delivery_state to add 'failed' (Task 91/102 review
-- follow-up): when memory selection/delivery throws for an accepted turn, the
-- runtime now records a 'failed' audit batch (no items, zero chars, snapshot
-- left untouched) so the inspector shows an explicit failure instead of quietly
-- reusing the PREVIOUS turn's batch as if it were current. SQLite CHECK
-- constraints require a table rebuild; memory_load_items references
-- memory_load_batches(id) so foreign_keys must be off for the rebuild.
PRAGMA legacy_alter_table = ON;

DROP INDEX IF EXISTS memory_load_batches_turn_idx;
DROP INDEX IF EXISTS memory_load_batches_recent_idx;

ALTER TABLE memory_load_batches RENAME TO memory_load_batches_old;

CREATE TABLE memory_load_batches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  user_turn_id TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  delivery_state TEXT NOT NULL
    CHECK (delivery_state IN ('injected','reused','cleared','none','failed')),
  rendered_chars INTEGER NOT NULL DEFAULT 0,
  injected_chars INTEGER NOT NULL DEFAULT 0,
  cumulative_injected_chars INTEGER NOT NULL DEFAULT 0,
  created_at_ms INTEGER NOT NULL
);

INSERT INTO memory_load_batches (
  id, session_id, user_turn_id, fingerprint, delivery_state, rendered_chars,
  injected_chars, cumulative_injected_chars, created_at_ms
)
SELECT
  id, session_id, user_turn_id, fingerprint, delivery_state, rendered_chars,
  injected_chars, cumulative_injected_chars, created_at_ms
FROM memory_load_batches_old;

DROP TABLE memory_load_batches_old;

-- True AUTOINCREMENT tracks the next rowid ONLY via sqlite_sequence (it does not
-- scan existing data), and a RENAME/DROP pair can leave that entry stale or
-- missing — reseed it explicitly so the next natural insert cannot collide with
-- a copied historical id.
DELETE FROM sqlite_sequence WHERE name IN ('memory_load_batches', 'memory_load_batches_old');
INSERT INTO sqlite_sequence (name, seq) SELECT 'memory_load_batches', COALESCE(MAX(id), 0) FROM memory_load_batches;

CREATE UNIQUE INDEX memory_load_batches_turn_idx ON memory_load_batches(session_id, user_turn_id);
CREATE INDEX memory_load_batches_recent_idx ON memory_load_batches(session_id, id DESC);

PRAGMA legacy_alter_table = OFF;
