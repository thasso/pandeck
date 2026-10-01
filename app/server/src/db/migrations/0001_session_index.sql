CREATE TABLE session_index (
  id TEXT PRIMARY KEY,

  visibility TEXT NOT NULL DEFAULT 'user'
    CHECK (visibility IN ('user', 'internal')),
  purpose TEXT NOT NULL DEFAULT 'chat',

  harness TEXT NOT NULL
    CHECK (harness IN ('pi', 'claude-sdk')),
  agent_type TEXT NOT NULL
    CHECK (agent_type IN ('assistant', 'workshop')),

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

CREATE INDEX session_index_visible_updated_idx
  ON session_index(visibility, updated_at_ms DESC)
  WHERE deleted_at_ms IS NULL;

CREATE UNIQUE INDEX session_index_provider_session_idx
  ON session_index(provider, provider_session_id)
  WHERE provider_session_id IS NOT NULL;

CREATE TABLE session_links (
  parent_session_id TEXT NOT NULL
    REFERENCES session_index(id) ON DELETE CASCADE,
  child_session_id TEXT NOT NULL
    REFERENCES session_index(id) ON DELETE CASCADE,

  relation_type TEXT NOT NULL
    CHECK (relation_type IN ('spawned', 'internal', 'forked')),
  label TEXT,
  created_at_ms INTEGER NOT NULL,
  metadata_json TEXT,

  PRIMARY KEY (parent_session_id, child_session_id, relation_type)
);

CREATE INDEX session_links_parent_idx
  ON session_links(parent_session_id, relation_type, created_at_ms);

CREATE INDEX session_links_child_idx
  ON session_links(child_session_id, relation_type);

CREATE TABLE session_usage_totals (
  session_id TEXT PRIMARY KEY
    REFERENCES session_index(id) ON DELETE CASCADE,

  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens INTEGER NOT NULL DEFAULT 0,
  cache_write_tokens INTEGER NOT NULL DEFAULT 0,
  reasoning_tokens INTEGER NOT NULL DEFAULT 0,
  total_tokens INTEGER NOT NULL DEFAULT 0,

  cost_micros INTEGER,
  currency TEXT NOT NULL DEFAULT 'USD'
    CHECK (length(currency) = 3),

  usage_turns INTEGER NOT NULL DEFAULT 0,
  assistant_turns INTEGER NOT NULL DEFAULT 0,

  context_tokens INTEGER,
  context_window INTEGER,

  usage_source TEXT NOT NULL DEFAULT 'provider_reported'
    CHECK (usage_source IN ('provider_reported', 'imported', 'estimated', 'manual')),
  updated_at_ms INTEGER NOT NULL
);
