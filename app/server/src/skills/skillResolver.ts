import type { SkillSummary, SkillToggles } from "@assistant/shared";

/**
 * Resolve the skill names selected by ordered settings layers.
 *
 * Later layers override earlier ones. Phase 1 supplies only the global layer;
 * keeping the layer list explicit lets project/session scopes be added without
 * changing lifecycle callers. Names absent from every layer are off, and names
 * not present in this working-tree scan can never enter the result.
 */
export function resolveSkillNames(
  availableSkills: readonly Pick<SkillSummary, "name">[],
  layers: readonly SkillToggles[],
): string[] {
  const resolved = new Map<string, "on" | "off">();
  for (const layer of layers)
    for (const [name, state] of Object.entries(layer))
      resolved.set(name, state);

  return [...new Set(availableSkills.map((skill) => skill.name))]
    .filter((name) => resolved.get(name) === "on")
    .sort(compareText);
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
