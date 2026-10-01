-- Projects → SQLite (see docs/projects design; mirrors the Tasks playbook).
--
-- Design: columns = a project's own attributes; relationships to other nodes are
-- edges in the generic `links` table:
--   * project —parent→ project      (hierarchy; sibling order is the sort_order column)
--   * project —jira→   jira          (role/notes in metadata_json)
--   * session —in_project→ project   (standalone session→project mapping; replaces session-projects.json)
--
-- Unlike tasks, the id is a stable human slug (referenced by task in_project edges,
-- session mappings, and knowledge/projects/<id>/ folders), so it is TEXT, not a
-- per-type integer sequence. `key` is a separate, editable Jira-style display badge.
--
-- Value-object collections that are not links: matcher-critical localPaths/git get
-- child tables; simple aliases/tags are JSON on the row. `tempo` and the inert
-- `reference` status are intentionally dropped in this move.

CREATE TABLE projects (
  id            TEXT PRIMARY KEY,        -- stable lowercase slug, e.g. 'acme'
  name          TEXT NOT NULL,
  key           TEXT NOT NULL,           -- display badge, e.g. 'AC'; unique among live rows
  color         TEXT,                    -- CSS color for compact badges/dots
  description   TEXT NOT NULL DEFAULT '',
  status        TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived')),
  aliases_json  TEXT,                    -- string[] as JSON, or NULL
  tags_json     TEXT,                    -- string[] as JSON, or NULL
  sort_order    INTEGER,                 -- manual order among siblings (parent is an edge)
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  deleted_at_ms INTEGER
);

-- `key` is unique among non-deleted projects (a tombstoned row must not block reuse).
CREATE UNIQUE INDEX projects_key_idx ON projects(key) WHERE deleted_at_ms IS NULL;

CREATE TABLE project_paths (
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  path       TEXT NOT NULL,
  kind       TEXT CHECK (kind IN ('repo','workspace','folder')),
  match      TEXT NOT NULL DEFAULT 'prefix' CHECK (match IN ('exact','prefix')),
  notes      TEXT,
  PRIMARY KEY (project_id, path)
);

CREATE TABLE project_git (
  project_id           TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  remote               TEXT,
  branch_patterns_json TEXT,             -- string[] as JSON, or NULL
  notes                TEXT
);

CREATE INDEX project_git_project_idx ON project_git(project_id);
