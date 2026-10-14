/**
 * The skills library as one kind of the shared library core
 * (`docs/skills.md`, `docs/agent-definitions.md#shared-library-core`), and its
 * read side as the browser sees it.
 *
 * Subscribing to the `skills` topic IS the authoritative read: this module
 * bootstraps storage if needed, scans the working tree fresh, and publishes the
 * result through the shared topic seam (`library/libraryPublish.ts`). Nothing
 * here caches — the library is hand-authored, and a cached index would let
 * Settings show a skill that no longer matches the file a session is about to
 * inject.
 *
 * Every subscriber receives the same publish, so a second window that opens the
 * library also refreshes the first one instead of the two drifting apart.
 */
import { SKILLS_LIBRARY_DIR } from "../config.ts";
import { parseEntryManifest } from "../library/entryManifest.ts";
import type { LibraryKind } from "../library/libraryKind.ts";
import { publishLibrary } from "../library/libraryPublish.ts";
import { scanLibrary, type LibraryScan } from "../library/libraryScanner.ts";
import { LibraryStore } from "../library/libraryStore.ts";

/** The one file a skill folder is recognized by. */
const SKILL_FILE_NAME = "SKILL.md";

/** A skill's manifest is exactly the shared `name` + `description` rule. */
export const skillKind: LibraryKind = {
  noun: "skill",
  plural: "skills",
  manifestFile: SKILL_FILE_NAME,
  trailerPrefix: "Skill",
  parseManifest: parseEntryManifest,
  publish: (library) => publishSkillLibrary(library),
};

/**
 * The process-wide skills store. Every read path — the `skills` topic, the
 * bounded HTTP detail read, session injection, and the agent tools — goes
 * through this one instance so they share a single bootstrap and one mutation
 * lock chain.
 */
export const skillLibraryStore = new LibraryStore(
  skillKind,
  SKILLS_LIBRARY_DIR,
);

/** One fresh scan of a skills working tree. */
export function scanSkillLibrary(
  root: string,
  options?: Parameters<typeof scanLibrary>[2],
): Promise<LibraryScan> {
  return scanLibrary(skillKind, root, options);
}

/** Scan now and push the result to every `skills` subscriber. */
export function publishSkillLibrary(
  library: LibraryStore = skillLibraryStore,
): Promise<void> {
  return publishLibrary("skills", library);
}
