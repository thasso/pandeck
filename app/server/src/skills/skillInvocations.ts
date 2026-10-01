/**
 * Which library skills a coding session has actually LOADED, derived from its
 * tool calls. A frozen name only mounts a skill; its body reaches the model
 * through one of two calls this module recognizes:
 *
 *  - Claude's native `Skill` tool, which names the skill plugin-qualified
 *    (`pa-skills-<hash16>:<name>`). The qualifier must be this session's own
 *    runtime plugin: an unqualified or foreign name is a repository or CLI
 *    skill that happens to share the name, not a library load.
 *  - A read of the materialized `SKILL.md` (Claude `Read`, pi `read`), which
 *    is what pi's skill prompt asks the model to do. Only the runtime path
 *    counts — it is the location both harnesses advertise — so a shell `cat`
 *    or a read of the library source folder is invisible here.
 *
 * A call counts only once its result is in and not an error: a refused read
 * or a failed Skill call put nothing in context, and a call still running has
 * not yet. Both harnesses feed their committed transcript through
 * `skillInvocationTrail` at projection time, the way the Tools inspector
 * derives `used`.
 */
import { isAbsolute, normalize, resolve, sep } from "node:path";
import type { SessionSkillInvocation } from "@assistant/shared";
import { SKILLS_RUNTIME_DIR } from "../config.ts";
import {
  skillRuntimePluginName,
  skillSetHash,
} from "./skillRuntimeMaterializer.ts";

/** One transcript tool call, in the harness-neutral shape both timelines share. */
export interface SkillInvocationToolCall {
  toolCallId: string;
  toolName: string;
  input: unknown;
  at: number;
}

/** A transcript's tool calls plus the ids whose result arrived without error. */
export interface SkillInvocationTranscript {
  calls: readonly SkillInvocationToolCall[];
  succeeded: ReadonlySet<string>;
}

const TRAIL_LIMIT = 50;
const SKILL_FILE_NAME = "SKILL.md";

/**
 * A session's newest-last invocation trail. `runtimeDir` is the generated
 * layout root (`SKILLS_RUNTIME_DIR`), overridable for tests.
 */
export function skillInvocationTrail(
  frozenNames: readonly string[],
  transcript: SkillInvocationTranscript,
  runtimeDir: string = SKILLS_RUNTIME_DIR,
): SessionSkillInvocation[] {
  if (frozenNames.length === 0) return [];
  const frozen = new Set(frozenNames);
  const hash = skillSetHash(frozenNames);
  const plugin = skillRuntimePluginName(hash);
  const skillsRoot = resolve(runtimeDir, hash, "skills") + sep;
  const trail: SessionSkillInvocation[] = [];
  for (const call of transcript.calls) {
    if (!transcript.succeeded.has(call.toolCallId)) continue;
    const invocation = classify(call, frozen, plugin, skillsRoot);
    if (invocation) trail.push(invocation);
  }
  return trail.slice(-TRAIL_LIMIT);
}

function classify(
  call: SkillInvocationToolCall,
  frozen: ReadonlySet<string>,
  plugin: string,
  skillsRoot: string,
): SessionSkillInvocation | undefined {
  const input = asRecord(call.input);
  if (!input) return undefined;
  switch (call.toolName) {
    case "Skill": {
      const qualified = input.skill;
      if (typeof qualified !== "string") return undefined;
      const separator = qualified.indexOf(":");
      if (separator < 0 || qualified.slice(0, separator) !== plugin)
        return undefined;
      const name = qualified.slice(separator + 1);
      return frozen.has(name)
        ? { at: call.at, name, via: "skill_tool" }
        : undefined;
    }
    case "Read":
    case "read": {
      const path = input.file_path ?? input.path;
      if (typeof path !== "string" || !isAbsolute(path)) return undefined;
      const absolute = normalize(path);
      if (!absolute.startsWith(skillsRoot)) return undefined;
      const [name, file, ...rest] = absolute
        .slice(skillsRoot.length)
        .split(sep);
      if (rest.length > 0 || file !== SKILL_FILE_NAME || !name)
        return undefined;
      return frozen.has(name) ? { at: call.at, name, via: "read" } : undefined;
    }
    default:
      return undefined;
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
