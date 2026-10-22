-- The PA-owned subagent registry (Task-457) is removed: peer sessions replaced
-- it, and no code reads or writes these tables. Drop them and their revision
-- sequence (Task-1041).
--
-- A registry row is user data this build can no longer show or migrate, so
-- the migration REFUSES rather than deleting it: either trigger aborts, the
-- runner rolls this file's transaction back, and the database stays exactly as
-- it was. The guard objects are TEMP, so a refusal or success leaves nothing
-- behind in the schema.
CREATE TEMP TABLE subagent_registry_drop_guard (
  table_name TEXT NOT NULL,
  row_count INTEGER NOT NULL
);
CREATE TEMP TRIGGER subagent_registry_drop_guard_runs
BEFORE INSERT ON subagent_registry_drop_guard
WHEN NEW.table_name = 'subagent_runs' AND NEW.row_count > 0
BEGIN
  SELECT RAISE(ABORT, 'Migration 0097_drop_subagent_registry refused: subagent_runs still holds rows. This build removed the PA subagent registry and will not delete its records. Back up app.sqlite3, export or delete the subagent_runs and subagent_threads rows you no longer need, then restart. Nothing was changed.');
END;
CREATE TEMP TRIGGER subagent_registry_drop_guard_threads
BEFORE INSERT ON subagent_registry_drop_guard
WHEN NEW.table_name = 'subagent_threads' AND NEW.row_count > 0
BEGIN
  SELECT RAISE(ABORT, 'Migration 0097_drop_subagent_registry refused: subagent_threads still holds rows. This build removed the PA subagent registry and will not delete its records. Back up app.sqlite3, export or delete the subagent_runs and subagent_threads rows you no longer need, then restart. Nothing was changed.');
END;
INSERT INTO subagent_registry_drop_guard (table_name, row_count)
SELECT 'subagent_runs', count(*) FROM subagent_runs;
INSERT INTO subagent_registry_drop_guard (table_name, row_count)
SELECT 'subagent_threads', count(*) FROM subagent_threads;
DROP TABLE subagent_registry_drop_guard;

-- Runs reference threads, so runs go first; indexes go with their tables.
DROP TABLE subagent_runs;
DROP TABLE subagent_threads;
DELETE FROM sequences WHERE entity_type = 'subagent_revision';
