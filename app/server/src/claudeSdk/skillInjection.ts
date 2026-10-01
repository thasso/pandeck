import { scanSkillLibrary } from "../skills/skillLibraryScanner.ts";
import { skillLibraryStore } from "../skills/skillLibraryStore.ts";
import { materializeSkillRuntime } from "../skills/skillRuntimeMaterializer.ts";

/**
 * Recreate and validate the generated Claude plugin for one frozen name set.
 *
 * This is intentionally called before every ordinary SDK query. Runtime layouts
 * are a disposable cache, while the session's frozen names remain authoritative.
 * An empty set needs no plugin and therefore does not bootstrap or scan storage.
 */
export async function prepareClaudeSkillRuntime(
  frozenSkillNames: readonly string[],
): Promise<void> {
  if (frozenSkillNames.length === 0) return;
  await skillLibraryStore.ensureInitialized();
  const scan = await scanSkillLibrary(skillLibraryStore.root);
  await materializeSkillRuntime(frozenSkillNames, scan);
}
