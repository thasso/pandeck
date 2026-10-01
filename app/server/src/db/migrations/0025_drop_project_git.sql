-- Drop the vestigial `project_git` table.
--
-- Project git links were removed in "Remove local-agent scanning and project
-- git links" (only `repoUrl` is retained for cloning). That change also edited
-- the already-applied 0005 migration to stop creating `project_git`, which
-- broke the migration checksum guard on every database that had applied the
-- original 0005. 0005 has been restored to its shipped bytes; this forward
-- migration performs the actual removal so both existing and fresh databases
-- converge on a schema without `project_git`. No live code references it.

DROP INDEX IF EXISTS project_git_project_idx;
DROP TABLE IF EXISTS project_git;
