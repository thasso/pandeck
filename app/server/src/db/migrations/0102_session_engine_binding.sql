-- A session's engine bindings (Task-1485 sub-PR 3): which harness, account,
-- model and effort run it, and the engine's own id for it. Exactly one binding
-- is active (ended_at_ms NULL); session_index's harness, provider,
-- provider_session_id, model, thinking_level and credential_profile_id are
-- that binding's projection, written in the same transaction by
-- sessionStore (docs/session-runtime-switching.md "Engine bindings").
--
-- native_session_id is the engine's id, never a path: pi's session id (its
-- transcript is derived from it), Claude's SDK session id (NULL until the
-- first query). started_seq is the session log's seq cursor when the binding
-- began; started_run_id the run that began it, NULL for the first binding.
CREATE TABLE session_engine_binding (
  session_id TEXT NOT NULL
    REFERENCES session_index(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL CHECK (seq >= 1),
  harness TEXT NOT NULL CHECK (harness IN ('pi', 'claude-sdk')),
  credential_profile_id TEXT,
  provider TEXT,
  model TEXT,
  thinking_level TEXT,
  native_session_id TEXT,
  started_seq INTEGER NOT NULL DEFAULT 0 CHECK (started_seq >= 0),
  started_run_id TEXT,
  created_at_ms INTEGER NOT NULL,
  ended_at_ms INTEGER,
  PRIMARY KEY (session_id, seq)
);

CREATE UNIQUE INDEX session_engine_binding_active_idx
  ON session_engine_binding(session_id)
  WHERE ended_at_ms IS NULL;

-- One binding per existing session, tombstoned rows included so a later
-- delete sweep still finds their native refs. A pi session's native id is its
-- app id: that is the transcript every build so far opened. No native file is
-- read, moved or rewritten.
INSERT INTO session_engine_binding (
  session_id, seq, harness, credential_profile_id, provider, model,
  thinking_level, native_session_id, started_seq, started_run_id,
  created_at_ms, ended_at_ms
)
SELECT
  id, 1, harness, credential_profile_id, provider, model, thinking_level,
  CASE WHEN harness = 'pi' THEN id ELSE provider_session_id END,
  0, NULL, created_at_ms, NULL
FROM session_index;
