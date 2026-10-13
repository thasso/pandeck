/**
 * The one authoring step that belongs to skills alone: rendering `SKILL.md`
 * from a declared name, description and body ([Task-633](pa://task/633),
 * `docs/skills.md`). Every other mutation — edit, supporting files, rename,
 * delete — is the shared library core's (`library/libraryAuthoring.ts`).
 */
import {
  assertEntryDescription,
  assertSafeEntryName,
  formatManifest,
  yamlString,
} from "../library/entryManifest.ts";
import {
  createEntry,
  type LibraryMutationOptions,
  type LibraryMutationOutcome,
} from "../library/libraryAuthoring.ts";
import type {
  LibraryCommitMeta,
  LibraryStore,
} from "../library/libraryStore.ts";

/**
 * Render complete `SKILL.md` source. `description` is emitted as a quoted
 * scalar the shared YAML subset parses back byte-for-byte (`yamlString`).
 */
function formatSkillManifest(manifest: {
  name: string;
  description: string;
  body: string;
}): string {
  return formatManifest(
    [
      `name: ${manifest.name}`,
      `description: ${yamlString(manifest.description)}`,
    ],
    manifest.body,
  );
}

/** Create `<name>/SKILL.md` from a validated declared name, description, body. */
export async function createSkill(
  input: { name: string; description: string; body: string },
  meta: LibraryCommitMeta,
  library: LibraryStore,
  options: LibraryMutationOptions = {},
): Promise<LibraryMutationOutcome> {
  const name = assertSafeEntryName(library.kind, input.name);
  const description = assertEntryDescription(input.description);
  return createEntry(
    {
      name,
      source: formatSkillManifest({ name, description, body: input.body }),
    },
    meta,
    library,
    options,
  );
}
