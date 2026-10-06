-- Knowledge Base links name file paths now (`pa://knowledge/<path>`); older
-- links name a retired entry id (`pa://knowledge/<kb.id>`). The boot-time link
-- migration (`knowledgeLinkMigration.ts`) rewrites the text people still edit
-- and freezes the id → path map here, so the links left in history (session
-- transcripts, memory snapshots, workflow state) keep resolving. `kb_move`
-- keeps the paths current.
CREATE TABLE knowledge_legacy_links (
  legacy_id TEXT PRIMARY KEY,
  path      TEXT NOT NULL
);

-- One row once the migration has run, with what it changed.
CREATE TABLE knowledge_link_migration (
  id              INTEGER PRIMARY KEY CHECK (id = 1),
  completed_at_ms INTEGER NOT NULL,
  summary_json    TEXT NOT NULL
);
