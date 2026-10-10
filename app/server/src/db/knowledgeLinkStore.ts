/**
 * Persistence for the Knowledge link migration (migration
 * `0069_knowledge_legacy_links.sql`): the frozen map from a retired entry id to
 * the file it named, the migration's done-marker, and the row reads and writes
 * the migration rewrites. Policy lives in `../knowledgeLinkMigration.ts`.
 */
import { getDb, withDbTransaction } from "./index.ts";

/** The file a retired `pa://knowledge/<id>` link names, if the id was known. */
function legacyPath(legacyId: string): string | undefined {
  const row = getDb()
    .prepare("SELECT path FROM knowledge_legacy_links WHERE legacy_id = ?")
    .get(legacyId) as { path: string } | undefined;
  return row?.path;
}

/** Freeze id → path pairs; an id already frozen keeps its path. */
function putLegacyLinks(links: ReadonlyMap<string, string>): void {
  withDbTransaction(() => {
    const insert = getDb().prepare(
      "INSERT OR IGNORE INTO knowledge_legacy_links (legacy_id, path) VALUES (?, ?)",
    );
    for (const [legacyId, path] of links) insert.run(legacyId, path);
  });
}

/** Follow a move: every frozen path equal to `from`, or under it, moves to `to`. */
function moveLegacyPaths(from: string, to: string): void {
  getDb()
    .prepare(
      `UPDATE knowledge_legacy_links
          SET path = ? || substr(path, ? + 1)
        WHERE path = ? OR substr(path, 1, ? + 1) = ? || '/'`,
    )
    .run(to, from.length, from, from.length, from);
}

function migrationDone(): boolean {
  return (
    getDb()
      .prepare("SELECT 1 FROM knowledge_link_migration WHERE id = 1")
      .get() !== undefined
  );
}

function recordMigration(summary: unknown, at = Date.now()): void {
  getDb()
    .prepare(
      "INSERT OR REPLACE INTO knowledge_link_migration (id, completed_at_ms, summary_json) VALUES (1, ?, ?)",
    )
    .run(at, JSON.stringify(summary));
}

/** Task descriptions that mention a Knowledge link, deleted Tasks included. */
function taskDescriptionsWithKnowledgeLinks(): {
  id: number;
  text: string;
}[] {
  return getDb()
    .prepare(
      "SELECT id, description AS text FROM tasks WHERE description LIKE '%pa://knowledge/%'",
    )
    .all() as unknown as { id: number; text: string }[];
}

/** Active memory cards that mention a Knowledge link, with their revision. */
function memoryCardsWithKnowledgeLinks(): {
  id: string;
  revision: number;
  text: string;
}[] {
  return getDb()
    .prepare(
      "SELECT id, revision, text FROM memory_cards WHERE state = 'active' AND text LIKE '%pa://knowledge/%'",
    )
    .all() as unknown as { id: string; revision: number; text: string }[];
}

/**
 * Write rewritten Task descriptions in one transaction. `updated_at_ms` is left
 * alone: a link's new spelling is not an edit anyone made, and must not reorder
 * lists.
 */
function rewriteTaskDescriptions(rows: { id: number; text: string }[]): void {
  withDbTransaction(() => {
    const description = getDb().prepare(
      "UPDATE tasks SET description = ? WHERE id = ?",
    );
    for (const row of rows) description.run(row.text, row.id);
  });
}

/** A consistent copy of the whole database, for a rewrite to be undone from. */
function backupTo(path: string): void {
  getDb().prepare("VACUUM INTO ?").run(path);
}

export const knowledgeLinkStore = {
  legacyPath,
  putLegacyLinks,
  moveLegacyPaths,
  migrationDone,
  recordMigration,
  taskDescriptionsWithKnowledgeLinks,
  memoryCardsWithKnowledgeLinks,
  rewriteTaskDescriptions,
  backupTo,
};
