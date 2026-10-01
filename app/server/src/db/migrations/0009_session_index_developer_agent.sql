-- assistant:migration:foreign_keys_off
-- Rebuild session_index so production-capable coding sessions can persist their
-- persona instead of failing the old assistant/workshop-only CHECK constraint.
-- Keep agent_type open-ended; TypeScript/shared protocol and the agent registry
-- validate known personas, while SQLite should not need a table rebuild for each
-- new persona name.
PRAGMA legacy_alter_table = ON;

DROP INDEX IF EXISTS session_index_visible_updated_idx;
DROP INDEX IF EXISTS session_index_provider_session_idx;

ALTER TABLE session_index RENAME TO session_index_old;

CREATE TABLE session_index (
  id TEXT PRIMARY KEY,

  visibility TEXT NOT NULL DEFAULT 'user'
    CHECK (visibility IN ('user', 'internal')),
  purpose TEXT NOT NULL DEFAULT 'chat',

  harness TEXT NOT NULL
    CHECK (harness IN ('pi', 'claude-sdk')),
  agent_type TEXT NOT NULL,

  title TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  message_count INTEGER NOT NULL DEFAULT 0,

  provider TEXT,
  provider_session_id TEXT,
  model TEXT,
  thinking_level TEXT,

  archived_at_ms INTEGER,
  read_at_ms INTEGER NOT NULL DEFAULT 0,

  fork_origin_json TEXT,
  fork_auto_rename_pending INTEGER NOT NULL DEFAULT 0,

  deleted_at_ms INTEGER
);

INSERT INTO session_index (
  id, visibility, purpose, harness, agent_type, title, created_at_ms, updated_at_ms,
  message_count, provider, provider_session_id, model, thinking_level, archived_at_ms,
  read_at_ms, fork_origin_json, fork_auto_rename_pending, deleted_at_ms
)
SELECT
  id, visibility, purpose, harness, agent_type, title, created_at_ms, updated_at_ms,
  message_count, provider, provider_session_id, model, thinking_level, archived_at_ms,
  read_at_ms, fork_origin_json, fork_auto_rename_pending, deleted_at_ms
FROM session_index_old;

DROP TABLE session_index_old;

CREATE INDEX session_index_visible_updated_idx
  ON session_index(visibility, updated_at_ms DESC)
  WHERE deleted_at_ms IS NULL;

CREATE UNIQUE INDEX session_index_provider_session_idx
  ON session_index(provider, provider_session_id)
  WHERE provider_session_id IS NOT NULL;

PRAGMA legacy_alter_table = OFF;
