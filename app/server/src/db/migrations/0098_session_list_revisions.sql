-- The `sessions` state topic's per-row revisions (Task-1302, `docs/state-sync.md`).
-- A separate table, not a `session_index` column: a live session can be listed
-- with no `session_index` row at all, and it still needs a revision to publish.
-- Rows are never deleted, so an archived or tombstoned session keeps the
-- revision its later `delete` events carry. The `session_list_revision`
-- sequence row is created on first use. Additive: no existing row changes.
CREATE TABLE session_list_revisions (
  session_id TEXT PRIMARY KEY,
  revision INTEGER NOT NULL
) WITHOUT ROWID;
