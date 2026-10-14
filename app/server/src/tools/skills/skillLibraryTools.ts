/**
 * The skills library's `skill_*` tool group ([Task-633](pa://task/633),
 * `docs/skills.md`): the shared library tool factory, given the skill kind's
 * create fields and the consequences a rename or delete has for frozen
 * sessions and the global on/off map.
 */
import { MAX_ENTRY_SOURCE_BYTES } from "../../library/libraryAuthoring.ts";
import type { LibraryStore } from "../../library/libraryStore.ts";
import type { AgentTool } from "../../mcp/tool.ts";
import { createSkill } from "../../skills/createSkill.ts";
import { skillLibraryStore } from "../../skills/skillLibrary.ts";
import { libraryTools } from "../library/libraryTools.ts";

let libraryFactory = (): LibraryStore => skillLibraryStore;

/** Test-only seam so tool tests run against an isolated temp library. */
export function setSkillToolLibraryForTests(
  factory: (() => LibraryStore) | null,
): void {
  libraryFactory = factory ?? (() => skillLibraryStore);
}

/** The one deferred group registered in `tools/catalog.ts`. */
export const skillLibraryTools: AgentTool[] = libraryTools({
  prefix: "skill",
  labelGroup: "Skills",
  exampleName: "release-notes",
  library: () => libraryFactory(),
  create: {
    description:
      "Create a new skill as <name>/SKILL.md in the user's library and commit it. The source folder is the declared name; frontmatter is written deterministically from name and description, and the body is your Markdown instructions. Requires a completely clean library repository (tracked, staged and untracked): a mutation never absorbs the user's manual edits, and a dirty tree is refused with what to resolve. The result is rejected before any commit if the scanner would not report the new skill as valid or if the name is already declared. Never put secrets, credentials, or tokens in a skill: this library is shared by every session that enables it.",
    properties: {
      name: {
        type: "string",
        description:
          "Declared skill name and source folder: 1-64 characters, lowercase letters, digits and single hyphens.",
      },
      description: {
        type: "string",
        description:
          "One-line trigger description (max 1024 characters) telling an agent when this skill applies.",
      },
      body: {
        type: "string",
        description: `Markdown instructions below the frontmatter. Bounded at ${MAX_ENTRY_SOURCE_BYTES} bytes for the whole file; put long reference material in supporting files via skill_manage_files.`,
      },
    },
    required: ["name", "description", "body"],
    run: (params, meta, library, options) =>
      createSkill(
        {
          name: params.name as string,
          description: params.description as string,
          body: params.body as string,
        },
        meta,
        library,
        options,
      ),
  },
  rename: {
    description:
      "Rename a skill: move its source folder to the new name and rewrite the declared frontmatter name in one commit. Refused when the new name is already declared or the destination folder exists. Consequences to report to the user: sessions that already froze the OLD name keep it and can no longer materialize it, the old name's global on/off setting stays as the user's historical decision, and the NEW name starts disabled until the user enables it in Settings → Skills. Requires a completely clean library repository.",
    consequences: (previousName, newName) => [
      `Sessions that froze "${previousName}" keep that name and can no longer materialize it.`,
      `The stored on/off entry for "${previousName}" is kept as the user's decision; "${newName}" defaults to off until the user enables it.`,
      `Agent definitions whose skills list "${previousName}" cannot be spawned until they are edited to name "${newName}".`,
    ],
  },
  delete: {
    description:
      "Delete one whole skill folder — SKILL.md and every supporting file — resolved from its current declared name, as one commit. Git history is the only recovery path: no tool restores a deleted skill. Frozen sessions and stored on/off settings are NOT rewritten, so a session that already froze this name can no longer materialize it. Confirm with the user before deleting a skill they did not just ask you to remove. Requires a completely clean library repository.",
    consequences: (name) => [
      "The folder is recoverable only from the library's Git history.",
      `Frozen sessions and the stored on/off entry for "${name}" are not rewritten.`,
      `Agent definitions whose skills list "${name}" cannot be spawned until it is removed from them.`,
    ],
  },
});
