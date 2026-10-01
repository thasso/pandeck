-- Agent memory system (Task 91): memory cards, the durable observation buffer,
-- the per-session effective-snapshot state, per-turn effective-load audit, and
-- the global processor usage ledger. All timestamps are epoch ms.

-- Versioned memory cards. One row per stable id; `revision` is the optimistic
-- concurrency token, bumped on every mutation. Superseded/archived rows stay for
-- audit. Scope is columnar (project_id / persona), NULL = global on that axis, so
-- intersection matching needs no string parsing.
CREATE TABLE memory_cards (
  id TEXT PRIMARY KEY,
  revision INTEGER NOT NULL DEFAULT 1,
  text TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('preference','fact','constraint','working')),
  project_id TEXT,
  persona TEXT,
  state TEXT NOT NULL DEFAULT 'active' CHECK (state IN ('active','superseded','archived')),
  pinned INTEGER NOT NULL DEFAULT 0 CHECK (pinned IN (0,1)),
  strength REAL NOT NULL DEFAULT 1,
  temporal_mode TEXT NOT NULL DEFAULT 'persistent'
    CHECK (temporal_mode IN ('persistent','window','until-changed','recurring')),
  valid_from_ms INTEGER,
  valid_until_ms INTEGER,
  timezone TEXT,
  recurrence_json TEXT,
  observed_at_ms INTEGER NOT NULL,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  last_loaded_at_ms INTEGER,
  source_kind TEXT NOT NULL DEFAULT 'manual'
    CHECK (source_kind IN ('manual','agent','processor','import','consolidation')),
  source_session_id TEXT,
  source_message_id TEXT,
  supersedes_id TEXT,
  idempotency_key TEXT,
  reason TEXT
);

CREATE INDEX memory_cards_active_scope_idx ON memory_cards(state, project_id, persona);
CREATE INDEX memory_cards_temporal_idx ON memory_cards(state, temporal_mode, valid_from_ms, valid_until_ms);
CREATE INDEX memory_cards_supersedes_idx ON memory_cards(supersedes_id);
-- Internal dedup/idempotency: at most one card per key (explicit agent writes and
-- later automatic processing converge on one card).
CREATE UNIQUE INDEX memory_cards_idempotency_idx ON memory_cards(idempotency_key)
  WHERE idempotency_key IS NOT NULL;

-- Durable observation buffer for adaptive processing. Stores only bounded human
-- turn text + required assistant context; never raw tool output/binary/secret
-- bodies. The source timestamp + timezone are snapshotted immutably at ingestion.
CREATE TABLE memory_observations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  user_turn_id TEXT NOT NULL,
  persona TEXT,
  project_id TEXT,
  human_text TEXT NOT NULL,
  assistant_text TEXT,
  source_timestamp_ms INTEGER NOT NULL,
  timezone TEXT NOT NULL,
  high_signal INTEGER NOT NULL DEFAULT 0 CHECK (high_signal IN (0,1)),
  state TEXT NOT NULL DEFAULT 'pending'
    CHECK (state IN ('pending','processing','processed','discarded','failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  claimed_at_ms INTEGER,
  created_at_ms INTEGER NOT NULL,
  processed_at_ms INTEGER,
  error TEXT
);

-- One accepted turn maps to at most one observation.
CREATE UNIQUE INDEX memory_observations_turn_idx ON memory_observations(session_id, user_turn_id);
CREATE INDEX memory_observations_pending_idx ON memory_observations(state, created_at_ms);

-- Last delivered effective snapshot per session, plus enough state to reconstruct
-- delivery/reuse and cumulative-injection diagnostics after restart.
CREATE TABLE memory_session_snapshots (
  session_id TEXT PRIMARY KEY,
  fingerprint TEXT NOT NULL,
  effective_json TEXT NOT NULL,
  rendered_text TEXT NOT NULL,
  rendered_chars INTEGER NOT NULL DEFAULT 0,
  last_delivery_state TEXT NOT NULL
    CHECK (last_delivery_state IN ('injected','reused','cleared','none')),
  last_delivery_turn_id TEXT,
  -- Injected characters accumulated since the last detected compaction/rotation.
  cumulative_injected_chars INTEGER NOT NULL DEFAULT 0,
  updated_at_ms INTEGER NOT NULL
);

-- Per-turn effective-load audit. A `reused` batch still records the exact
-- effective set while adding zero injected characters. These are audit records,
-- never transcript messages.
CREATE TABLE memory_load_batches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  user_turn_id TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  delivery_state TEXT NOT NULL
    CHECK (delivery_state IN ('injected','reused','cleared','none')),
  rendered_chars INTEGER NOT NULL DEFAULT 0,
  injected_chars INTEGER NOT NULL DEFAULT 0,
  created_at_ms INTEGER NOT NULL
);

CREATE UNIQUE INDEX memory_load_batches_turn_idx ON memory_load_batches(session_id, user_turn_id);
CREATE INDEX memory_load_batches_recent_idx ON memory_load_batches(session_id, id DESC);

-- Items snapshot the card text/kind/scope effective AT DELIVERY, so the inspector
-- renders exactly what was loaded even after the card is later corrected/archived.
CREATE TABLE memory_load_items (
  batch_id INTEGER NOT NULL REFERENCES memory_load_batches(id) ON DELETE CASCADE,
  rank INTEGER NOT NULL,
  memory_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  reason_code TEXT NOT NULL,
  reason TEXT NOT NULL,
  rendered_chars INTEGER NOT NULL DEFAULT 0,
  text TEXT NOT NULL DEFAULT '',
  kind TEXT NOT NULL DEFAULT 'fact',
  project_id TEXT,
  persona TEXT,
  temporal_label TEXT,
  PRIMARY KEY (batch_id, rank)
);

-- Global processor usage/cost ledger. Enough to enforce call/hour and cost/day
-- ceilings across sessions and restarts without retaining reasoning or sensitive
-- prompt bodies. A row is inserted as a `reserved` reservation before a model
-- call and reconciled (`success`/`error`) after it, with late-reported cost.
CREATE TABLE memory_processor_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  reserved_at_ms INTEGER NOT NULL,
  completed_at_ms INTEGER,
  outcome TEXT NOT NULL DEFAULT 'reserved'
    CHECK (outcome IN ('reserved','success','error','skipped')),
  trigger TEXT,
  operations_applied INTEGER NOT NULL DEFAULT 0,
  cost_micros_usd INTEGER,
  created_at_ms INTEGER NOT NULL
);

CREATE INDEX memory_processor_runs_window_idx ON memory_processor_runs(reserved_at_ms);
