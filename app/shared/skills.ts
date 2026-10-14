/**
 * Shared wire model for the user-owned skills library (`docs/skills.md`,
 * [Task-531](pa://task/531)): the global on/off state. The `skills` topic list,
 * scan summaries, diagnostics, file trees and detail reads are the
 * library-generic shapes in `library.ts`.
 */

/**
 * The stored global state of one skill. There is no third value: a skill is
 * either deliberately on or it is not on. Deliberately not exported — every
 * consumer holds the whole {@link SkillToggles} map, and a second name for the
 * two literals would only be somewhere else to widen them.
 */
type SkillToggleState = "on" | "off";

/**
 * Global on/off state keyed by DECLARED skill name, not by source folder: the
 * name is what a session freezes and what a runtime layout materializes, and a
 * user who renames a folder has not changed which skill they enabled.
 *
 * The map is deliberately sparse and an absent name resolves OFF
 * ({@link isSkillEnabled}). Enabling is therefore always something the user
 * did, never something a missing entry, a fresh install or a failed read
 * produced. A stored `"off"` is the same answer said out loud; it is kept
 * rather than pruned so the map records what the user decided.
 */
export type SkillToggles = Record<string, SkillToggleState>;

/**
 * The ONE rule for reading the toggle map. Every surface — Settings, and later
 * injection — must ask this rather than test the entry itself, so "no entry"
 * can never be read as anything but off.
 */
export function isSkillEnabled(
  toggles: SkillToggles | undefined,
  name: string,
): boolean {
  return toggles?.[name] === "on";
}
