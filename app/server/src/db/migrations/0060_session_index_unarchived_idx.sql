-- The DEFAULT session projection reads only unarchived rows (Task-696).
--
-- Settled sessions are archived automatically seven days after their latest
-- settlement, so the archived population is expected to outgrow the active
-- list many times over. The sidebar/`ready` list used to load every live user
-- row and drop the archived ones in TypeScript; it now asks SQLite for the
-- unarchived rows directly, and this partial index is that query's shape:
-- one scope, newest first, live and unarchived. The on-demand archive view
-- keeps the broader `session_index_scope_updated_idx` from 0047.
CREATE INDEX session_index_scope_unarchived_updated_idx
  ON session_index(scope, updated_at_ms DESC)
  WHERE deleted_at_ms IS NULL AND archived_at_ms IS NULL;
