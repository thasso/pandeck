/**
 * The one-time move of Knowledge links from entry ids to file paths
 * (docs/knowledge-base.md, Links).
 *
 * Links written before the Knowledge Base became a plain folder name a retired
 * entry id, `pa://knowledge/<kb.id>`; a link now names a file,
 * `pa://knowledge/<path>`. Once, at boot, this:
 *
 * 1. reads every id → path pair the KB's frontmatter still carries and freezes
 *    it in `knowledge_legacy_links`, which keeps every link left in history
 *    (session transcripts, memory snapshots, workflow state) resolving;
 * 2. rewrites the links in the text people and agents still read and edit —
 *    the KB's own files (one commit; a file with uncommitted edits is left as
 *    it is), Task descriptions and comments, and active memory cards — after
 *    taking a consistent copy of the database.
 *
 * It records that it ran, with what it changed, and never runs again. A run
 * that fails part-way records nothing, and the next boot finishes it: text it
 * already rewrote no longer matches.
 */
import { existsSync } from "node:fs";
import { extname, join } from "node:path";
import { knowledgeFileLink } from "@assistant/shared/objectLinks";
import { DATA_DIR } from "./config.ts";
import { knowledgeLinkStore } from "./db/knowledgeLinkStore.ts";
import { knowledgeFiles } from "./knowledgeBaseIndex.ts";
import { KnowledgeBaseStore, type KbFileChange } from "./knowledgeBaseStore.ts";
import { editMemory } from "./memory/memoryService.ts";
import { notifyTaskChange } from "./tasks.ts";

const LEGACY_LINK_RE = /pa:\/\/knowledge\/([\w.%~:+-]+)/g;
const TEXT_EXTENSIONS = new Set([".md", ".markdown", ".mdx", ".txt"]);
const BACKUP_NAME = "app.sqlite3.pre-knowledge-path-links.bak";

/**
 * Rewrite every single-segment `pa://knowledge/<id>` whose id `pathFor` knows
 * into the file's path link. A link that already names a path (it continues
 * with `/`) or an id nobody knows is left alone, and so is what follows the id
 * — trailing punctuation, a `?query`, a `#fragment`.
 */
export function rewriteLegacyKnowledgeLinks(
  text: string,
  pathFor: (legacyId: string) => string | undefined,
): { text: string; count: number } {
  let count = 0;
  const next = text.replace(
    LEGACY_LINK_RE,
    (match, segment: string, offset: number) => {
      if (text[offset + match.length] === "/") return match;
      const id = segment.replace(/[.,;:!?]+$/, "");
      const rest = segment.slice(id.length);
      let decoded: string;
      try {
        decoded = decodeURIComponent(id);
      } catch {
        return match;
      }
      const path = pathFor(decoded);
      if (!path) return match;
      count += 1;
      return `${knowledgeFileLink(path)}${rest}`;
    },
  );
  return { text: next, count };
}

interface KnowledgeLinkMigrationSummary {
  legacyIds: number;
  kbFiles: number;
  kbCommit?: string;
  kbFilesSkipped: string[];
  tasks: number;
  taskComments: number;
  memoryCards: number;
  backup?: string;
}

/** Run the migration unless it already ran; returns what it changed. */
export async function migrateKnowledgeLinks(
  store = new KnowledgeBaseStore(),
): Promise<KnowledgeLinkMigrationSummary | null> {
  if (knowledgeLinkStore.migrationDone()) return null;

  // 1. Every id the folder still knows. Paths are walked in order, so of two
  //    files claiming one id the first keeps it.
  const files = await knowledgeFiles(store);
  const legacy = new Map<string, string>();
  for (const file of files)
    if (file.legacyId && !legacy.has(file.legacyId))
      legacy.set(file.legacyId, file.path);
  const pathFor = (id: string) => legacy.get(id);

  // 2. Work out every rewrite before changing anything.
  const dirty = await store.uncommittedPaths();
  const kbChanges: KbFileChange[] = [];
  const kbFilesSkipped: string[] = [];
  for (const { path } of legacy.size > 0 ? files : []) {
    if (!TEXT_EXTENSIONS.has(extname(path).toLowerCase())) continue;
    const rewritten = rewriteLegacyKnowledgeLinks(
      await store.readText(path),
      pathFor,
    );
    if (rewritten.count === 0) continue;
    if (dirty.has(path)) kbFilesSkipped.push(path);
    else kbChanges.push({ op: "write", path, content: rewritten.text });
  }
  const rewrite = <T extends { text: string }>(rows: T[]): T[] =>
    rows.flatMap((row) => {
      const rewritten = rewriteLegacyKnowledgeLinks(row.text, pathFor);
      return rewritten.count ? [{ ...row, text: rewritten.text }] : [];
    });
  const descriptions = rewrite(
    knowledgeLinkStore.taskDescriptionsWithKnowledgeLinks(),
  );
  const comments = rewrite(knowledgeLinkStore.taskCommentsWithKnowledgeLinks());
  const memoryCards = rewrite(
    knowledgeLinkStore.memoryCardsWithKnowledgeLinks(),
  );

  // 3. A copy of the database to undo the row rewrites from; the KB's own
  //    rewrite is a commit, undone with git.
  const summary: KnowledgeLinkMigrationSummary = {
    legacyIds: legacy.size,
    kbFiles: kbChanges.length,
    kbFilesSkipped,
    tasks: descriptions.length,
    taskComments: comments.length,
    memoryCards: memoryCards.length,
  };
  if (descriptions.length + comments.length + memoryCards.length > 0) {
    const backup = existsSync(join(DATA_DIR, BACKUP_NAME))
      ? join(DATA_DIR, `${BACKUP_NAME}-${Date.now()}`)
      : join(DATA_DIR, BACKUP_NAME);
    knowledgeLinkStore.backupTo(backup);
    summary.backup = backup;
  }

  // 4. Freeze the map, then rewrite.
  knowledgeLinkStore.putLegacyLinks(legacy);
  if (kbChanges.length > 0)
    summary.kbCommit = (
      await store.commitChanges(kbChanges, {
        actor: { kind: "system", name: "Knowledge Base" },
        reason: "Rewrite Knowledge links to file paths",
      })
    ).shortCommit;
  if (descriptions.length + comments.length > 0) {
    knowledgeLinkStore.rewriteTaskText({ descriptions, comments });
    notifyTaskChange(
      [
        ...descriptions.map((row) => row.id),
        ...comments.map((row) => row.taskId),
      ].map(String),
    );
  }
  for (const card of memoryCards) {
    const result = editMemory(card.id, card.revision, {
      text: card.text,
      reason: "Knowledge links now name file paths",
    });
    if (!result.ok)
      console.warn(
        `[knowledge] memory ${card.id} kept its old links: ${result.reason}`,
      );
  }
  knowledgeLinkStore.recordMigration(summary);
  return summary;
}
