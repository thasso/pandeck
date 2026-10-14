/**
 * The skills library ([Task-531](pa://task/531), `docs/skills.md`): the shared
 * library page ({@link LibrarySettingsSection}) with a skill's on/off switch on
 * every row.
 *
 * A toggle holds NO state of its own ([Task-613](pa://task/613)): it renders
 * `settings.skills` and asks `useAssistant` to turn one name on or off, so what
 * it shows is only ever what the settings say. A local "on" flipped by the
 * click would claim a skill is enabled before anything was written, and a save
 * that failed would leave that claim standing over settings that never changed.
 *
 * It also does not BUILD the replacement map. The section is replaced whole, so
 * the next write has to start from the one last sent while a save is still in
 * flight — state this surface deliberately cannot see — and that map belongs to
 * `useAssistant` with the rest of the protocol state.
 *
 * A broken folder has no toggle: there is no valid name to turn on.
 */
import {
  isSkillEnabled,
  type AppSettings,
  type EntryLibraryList,
} from "@assistant/shared";
import type { LoadState } from "../lib/loadState.ts";
import {
  LibrarySettingsSection,
  type LibraryPageCopy,
} from "./LibrarySettingsSection.tsx";
import { Field, FieldTitle } from "@/components/ui/field";
import { Switch } from "@/components/ui/switch";

const SKILLS_COPY: LibraryPageCopy = {
  library: "skills",
  title: "Skills",
  noun: "skill",
  manifestFile: "SKILL.md",
  intro: (
    <>
      Reusable agent skills you write yourself. Each skill is a folder with a{" "}
      <code>SKILL.md</code> whose frontmatter declares a name and a description.
      The library is read here and never written: you own the files and their
      Git history.
    </>
  ),
  listTitle: "Available skills",
  listDescription: (
    <>
      A skill you turn on here is on everywhere; a new skill starts off until
      you say otherwise. Per-project and per-session choices come later, as does
      handing the enabled skills to a running agent. Select a skill to read its{" "}
      <code>SKILL.md</code>.
    </>
  ),
  emptyText: (
    <>
      No skills yet. Add a folder with a <code>SKILL.md</code> inside the
      library folder above.
    </>
  ),
  noneUsableText:
    "No usable skills. Every folder in the library has a problem listed below.",
  diagnosticsDescription:
    "These folders cannot be used as skills. They stay listed here so a typo does not simply make a skill disappear.",
};

export function SkillsSettingsSection({
  library,
  settings,
  onToggleSkill,
}: {
  library: LoadState<EntryLibraryList>;
  settings: AppSettings;
  onToggleSkill: (name: string, on: boolean) => void;
}) {
  return (
    <LibrarySettingsSection
      copy={SKILLS_COPY}
      library={library}
      rowAction={(skill) => (
        <Field orientation="horizontal" className="w-auto">
          <Switch
            checked={isSkillEnabled(settings.skills, skill.name)}
            onCheckedChange={(checked) => onToggleSkill(skill.name, checked)}
            aria-label={`Enable skill ${skill.name}`}
          />
          <FieldTitle>On</FieldTitle>
        </Field>
      )}
    />
  );
}
