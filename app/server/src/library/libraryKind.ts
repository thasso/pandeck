/**
 * What makes one Git-backed library different from another
 * (`docs/agent-definitions.md#shared-library-core`).
 *
 * The library core — storage, scanning, anchored reads, authoring, history —
 * is the same code for every kind; a kind supplies only the file a source
 * folder is recognized by, the rule its manifest must satisfy, the words its
 * messages and commit trailers use, and how its browser topic is refreshed.
 * Adding a kind should need a descriptor, a manifest rule and a create renderer
 * and nothing else.
 */
import type { LibraryStore } from "./libraryStore.ts";
import type { EntryManifest, ManifestResult } from "./entryManifest.ts";

export interface LibraryKind<M extends EntryManifest = EntryManifest> {
  /** Singular noun in messages: `skill`. */
  noun: string;
  /** Plural noun in messages, lock keys and the commit e-mail domain: `skills`. */
  plural: string;
  /** The one file a source folder is recognized by: `SKILL.md`. */
  manifestFile: string;
  /** Commit trailer prefix: `Skill` gives `Skill-Actor`, `Skill-Names`, … */
  trailerPrefix: string;
  /**
   * The kind's whole manifest rule, shared by scanning and authoring; built
   * with `parseManifestWith` when the kind has fields beyond the shared ones.
   */
  parseManifest(content: string, path: string): ManifestResult<M>;
  /**
   * Push a fresh read to the kind's browser topic after a committed mutation.
   * Runs while the repository lock is still held, and its failure never
   * unmakes the commit.
   */
  publish(library: LibraryStore): Promise<void>;
}

/** `skill` → `a skill`, `agent` → `an agent`, for messages naming a kind. */
export function withArticle(word: string): string {
  return `${/^[aeiou]/i.test(word) ? "an" : "a"} ${word}`;
}

/** `skill` → `Skill`, for a message that starts with a kind's noun. */
export function capitalize(word: string): string {
  return word.charAt(0).toUpperCase() + word.slice(1);
}
