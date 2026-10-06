/**
 * Lookups over the frozen map from retired Knowledge entry ids to files
 * (`knowledge_legacy_links`, filled by `knowledgeLinkMigration.ts`): what a
 * `pa://knowledge/<id>` written before links were paths still names.
 */
import { knowledgeLinkStore } from "./db/knowledgeLinkStore.ts";
import type { KbFileInfo } from "./knowledgeBaseIndex.ts";

/**
 * The file a retired `pa://knowledge/<id>` names: the frozen map, else — before
 * the migration has run — the file whose frontmatter still carries that id.
 */
export function knowledgeLegacyPath(
  legacyId: string,
  files: readonly KbFileInfo[] = [],
): string | undefined {
  return (
    knowledgeLinkStore.legacyPath(legacyId) ??
    files.find((file) => file.legacyId === legacyId)?.path
  );
}

/** Keep the frozen map pointing at files `kb_move` moved. */
export function followKnowledgeMove(from: string, to: string): void {
  knowledgeLinkStore.moveLegacyPaths(from, to);
}
