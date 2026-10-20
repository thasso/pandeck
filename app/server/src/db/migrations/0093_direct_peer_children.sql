-- The sessions each coordinator started through the direct `session_spawn`
-- path (Task-966), replacing the in-memory registry: admission counts a
-- coordinator's running work from it, and a child whose opening prompt waits
-- for a slot (`peer_prompts.status = 'held'`) is re-checked against the runtime
-- it was spawned on before it starts. Both have to survive a restart.
--
-- Identities only: which approved runtime row or agent definition the child was
-- spawned from, and the exact provider/model/thinking/account it runs on. No
-- prompt, label or credential is stored here.
--
-- The table starts empty: a child spawned before this build is not counted,
-- just as an in-memory child was not counted after a restart.
CREATE TABLE direct_peer_children (
  child_session_id TEXT PRIMARY KEY,
  spawner_session_id TEXT NOT NULL,
  cost_class TEXT NOT NULL CHECK (cost_class IN ('low', 'counted')),
  source_kind TEXT NOT NULL CHECK (source_kind IN ('profile', 'agent')),
  profile_id TEXT,
  agent_name TEXT,
  provider TEXT NOT NULL,
  model_id TEXT NOT NULL,
  thinking_level TEXT NOT NULL,
  credential_profile_id TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL
);

CREATE INDEX direct_peer_children_spawner_idx
  ON direct_peer_children (spawner_session_id);

-- A coordinator's waiting opening prompts, oldest first: the FIFO a start pass
-- walks.
CREATE INDEX peer_prompts_held_sender_idx
  ON peer_prompts (sender_session_id, queue_seq)
  WHERE status = 'held';
