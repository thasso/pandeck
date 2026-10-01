-- assistant:migration:foreign_keys_off
-- Replace the two-valued `visibility` column with the three-way session SCOPE
-- (`user` | `internal` | `subagent`, Task-492): PA-owned subagent sessions are
-- neither the user's nor a usage-attribution stub, and every default projection
-- must be able to exclude them at the SQL layer.
--
-- Existing rows are NOT reclassified: `visibility` values carry over verbatim,
-- so a user session stays `user` and an internal usage session stays
-- `internal`. The column also loses its DEFAULT — a session row may not exist
-- without a scope somebody chose — and the CHECK keeps an unknown scope from
-- ever being written.
PRAGMA legacy_alter_table = ON;

DROP INDEX IF EXISTS session_index_visible_updated_idx;
DROP INDEX IF EXISTS session_index_provider_session_idx;
DROP INDEX IF EXISTS session_index_credential_profile_id_idx;

ALTER TABLE session_index RENAME TO session_index_old;

CREATE TABLE session_index (
  id TEXT PRIMARY KEY,

  scope TEXT NOT NULL
    CHECK (scope IN ('user', 'internal', 'subagent')),
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
  credential_profile_id TEXT,
  mode TEXT NOT NULL DEFAULT 'build'
    CHECK (mode IN ('build', 'plan')),

  archived_at_ms INTEGER,
  settled_at_ms INTEGER,
  last_error_at_ms INTEGER,
  last_error_text TEXT,
  read_at_ms INTEGER NOT NULL DEFAULT 0,

  fork_origin_json TEXT,
  fork_auto_rename_pending INTEGER NOT NULL DEFAULT 0,

  deleted_at_ms INTEGER
);

INSERT INTO session_index (
  id, scope, purpose, harness, agent_type, title, created_at_ms, updated_at_ms,
  message_count, provider, provider_session_id, model, thinking_level,
  credential_profile_id, mode, archived_at_ms, settled_at_ms, last_error_at_ms,
  last_error_text, read_at_ms, fork_origin_json, fork_auto_rename_pending,
  deleted_at_ms
)
SELECT
  id, visibility, purpose, harness, agent_type, title, created_at_ms, updated_at_ms,
  message_count, provider, provider_session_id, model, thinking_level,
  credential_profile_id, mode, archived_at_ms, settled_at_ms, last_error_at_ms,
  last_error_text, read_at_ms, fork_origin_json, fork_auto_rename_pending,
  deleted_at_ms
FROM session_index_old;

DROP TABLE session_index_old;

-- The default projection's index: every broad list reads one scope, newest
-- first, over live rows only.
CREATE INDEX session_index_scope_updated_idx
  ON session_index(scope, updated_at_ms DESC)
  WHERE deleted_at_ms IS NULL;

CREATE UNIQUE INDEX session_index_provider_session_idx
  ON session_index(provider, provider_session_id)
  WHERE provider_session_id IS NOT NULL;

CREATE INDEX session_index_credential_profile_id_idx
  ON session_index(credential_profile_id);

PRAGMA legacy_alter_table = OFF;
