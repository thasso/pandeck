-- The session's compaction window in tokens (Task-968). NULL means the
-- provider's own default. Written only through
-- `sessionStore.setCompactionWindow`; `upsert` never touches it.
ALTER TABLE session_index ADD COLUMN compaction_window INTEGER;
