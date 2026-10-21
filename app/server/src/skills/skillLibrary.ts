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
import type { EntrySummary } from "@assistant/shared";
import { SKILLS_LIBRARY_DIR } from "../config.ts";
import {
  parseManifestWith,
  type EntryManifest,
  type ManifestResult,
} from "../library/entryManifest.ts";
import type { LibraryKind } from "../library/libraryKind.ts";
import { publishLibrary } from "../library/libraryPublish.ts";
import { scanLibrary, type LibraryScan } from "../library/libraryScanner.ts";
import { LibraryStore } from "../library/libraryStore.ts";

/** The one file a skill folder is recognized by. */
const SKILL_FILE_NAME = "SKILL.md";

/** The optional invocation fields a skill summary carries. */
type SkillInvocationFields = Pick<
  EntrySummary,
  "argumentHint" | "disableModelInvocation" | "userInvocable"
>;

type SkillManifest = EntryManifest & SkillInvocationFields;

/**
 * A skill's manifest is the shared `name` + `description` rule; every other
 * key is the harness's and ignored. The invocation fields the composer and the
 * inspector show are read here when well-typed and otherwise left out — the
 * harness parses them itself, so a wrong type is never a diagnostic.
 */
function parseSkillManifest(
  content: string,
  path: string,
): ManifestResult<SkillManifest> {
  return parseManifestWith<SkillInvocationFields>(content, path, (fields) => {
    const hint = fields["argument-hint"];
    const argumentHint =
      typeof hint === "string"
        ? hint
        : Array.isArray(hint) &&
            hint.length > 0 &&
            hint.every((item) => typeof item === "string")
          ? hint.map((item) => `[${item}]`).join(" ")
          : undefined;
    return {
      ...(argumentHint !== undefined ? { argumentHint } : {}),
      ...(fields["disable-model-invocation"] === true
        ? { disableModelInvocation: true as const }
        : {}),
      ...(fields["user-invocable"] === false
        ? { userInvocable: false as const }
        : {}),
    };
  });
}

export const skillKind: LibraryKind<SkillManifest> = {
  noun: "skill",
  plural: "skills",
  manifestFile: SKILL_FILE_NAME,
  trailerPrefix: "Skill",
  parseManifest: parseSkillManifest,
  summaryExtras: ({ argumentHint, disableModelInvocation, userInvocable }) => ({
    ...(argumentHint !== undefined ? { argumentHint } : {}),
    ...(disableModelInvocation ? { disableModelInvocation } : {}),
    ...(userInvocable === false ? { userInvocable } : {}),
  }),
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
