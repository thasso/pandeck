/**
 * What makes one Git-backed library different from another
 * (`docs/agent-definitions.md#shared-library-core`).
 *
 * The library core — storage, scanning, anchored reads, authoring, history —
 * is the same code for every kind; a kind supplies only the file a source
 * folder is recognized by, the rule its manifest must satisfy, the words its
 * messages and commit trailers use, and how its browser topic is refreshed.
 * Adding a kind should need a descriptor and a manifest rule and nothing else.
 */
import type { LibraryStore } from "./libraryStore.ts";
import type { ManifestResult } from "./entryManifest.ts";

export interface LibraryKind {
  /** Singular noun in messages: `skill`. */
  noun: string;
  /** Plural noun in messages, lock keys and the commit e-mail domain: `skills`. */
  plural: string;
  /** The one file a source folder is recognized by: `SKILL.md`. */
  manifestFile: string;
  /** Commit trailer prefix: `Skill` gives `Skill-Actor`, `Skill-Names`, … */
  trailerPrefix: string;
  /** The kind's whole manifest rule, shared by scanning and authoring. */
  parseManifest(content: string, path: string): ManifestResult;
  /**
   * Push a fresh read to the kind's browser topic after a committed mutation.
   * Runs while the repository lock is still held, and its failure never
   * unmakes the commit.
   */
  publish(library: LibraryStore): Promise<void>;
}
