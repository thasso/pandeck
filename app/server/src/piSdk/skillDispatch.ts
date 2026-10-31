/**
 * pi's dispatch of a user `/<skill>` composer invocation (`docs/skills.md`).
 *
 * pi expands `/skill:<name> <args>` itself, looking the name up among the
 * skills its resource loader holds. That loader keeps the FIRST of two skills
 * with one name, so a repository `.pi/skills` skill can shadow the library one
 * the session froze: the command would then load the repository's file. The
 * name is therefore resolved here first, and only this session's own runtime
 * file passes.
 */
import { isAbsolute, normalize, resolve } from "node:path";
import { SKILLS_RUNTIME_DIR } from "../config.ts";
import type { SkillDispatch } from "../session/adapters/contract.ts";
import { skillSetHash } from "../skills/skillRuntimeMaterializer.ts";

/** The loader surface the check reads: the skills pi would expand. */
interface SkillLoader {
  getSkills(): { skills: readonly { name: string; filePath: string }[] };
}

/**
 * The native command for `name`, or why it cannot be sent. Synchronous and
 * side-effect free. `runtimeDir` is the generated layout root, overridable
 * for tests.
 */
export function piSkillDispatch(
  loader: SkillLoader,
  frozenNames: readonly string[],
  name: string,
  runtimeDir: string = SKILLS_RUNTIME_DIR,
): SkillDispatch {
  const skill = loader.getSkills().skills.find((entry) => entry.name === name);
  if (!frozenNames.includes(name) || !skill)
    return { refused: `/${name} is not loaded in this session.` };
  const expected = resolve(
    runtimeDir,
    skillSetHash(frozenNames),
    "skills",
    name,
    "SKILL.md",
  );
  if (!isAbsolute(skill.filePath) || normalize(skill.filePath) !== expected)
    return {
      refused: `/${name} clashes with a repository skill of the same name in this checkout. Rename one of them, or ask the agent to load it.`,
    };
  return { command: `/skill:${name}` };
}
