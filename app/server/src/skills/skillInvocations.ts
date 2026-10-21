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
 *
 * The user's `/<skill>` composer invocation is the third way, `command`. Each
 * harness confirms it from its own durable transcript — pi's expanded skill
 * block at the runtime path, a Claude skill turn whose assistant entry carries
 * `nativeResponse` — and hands over only confirmed ones. A confirmed command
 * already loaded that skill for its turn, so a same-turn Skill call or read of
 * it is not counted again.
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
  /** The user turn the call ran in, when the feed knows it. */
  turn?: string;
}

/** A user `/<skill>` invocation its harness confirmed loaded the skill. */
export interface SkillInvocationCommand {
  /** Declared library skill name, as the user typed it. */
  name: string;
  at: number;
  turn: string;
}

/** A transcript's tool calls plus the ids whose result arrived without error. */
export interface SkillInvocationTranscript {
  calls: readonly SkillInvocationToolCall[];
  succeeded: ReadonlySet<string>;
  commands?: readonly SkillInvocationCommand[];
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
  const commanded = new Set<string>();
  for (const command of transcript.commands ?? []) {
    if (!frozen.has(command.name)) continue;
    const key = `${command.turn}\0${command.name}`;
    if (commanded.has(key)) continue;
    commanded.add(key);
    trail.push({ at: command.at, name: command.name, via: "command" });
  }
  for (const call of transcript.calls) {
    if (!transcript.succeeded.has(call.toolCallId)) continue;
    const invocation = classify(call, frozen, plugin, skillsRoot);
    if (!invocation) continue;
    if (
      call.turn !== undefined &&
      commanded.has(`${call.turn}\0${invocation.name}`)
    )
      continue;
    trail.push(invocation);
  }
  // Stable: a command precedes the calls of its own turn at the same instant.
  if (commanded.size > 0) trail.sort((a, b) => a.at - b.at);
  return trail.slice(-TRAIL_LIMIT);
}

/**
 * Whether a pi user message is the skill block pi expands a `/skill:<name>`
 * command into, for a frozen skill at THIS session's runtime path. pi writes
 * the block only after reading the file, so the block is the confirmation; a
 * block naming any other location is a repository skill. `runtimeDir` as in
 * {@link skillInvocationTrail}.
 */
export function piSkillCommandName(
  frozenNames: readonly string[],
  text: string,
  runtimeDir: string = SKILLS_RUNTIME_DIR,
): string | undefined {
  const match = /^<skill name="([^"]+)" location="([^"]+)">/.exec(text);
  if (!match) return undefined;
  const [, name, location] = match;
  if (!name || !location || !frozenNames.includes(name)) return undefined;
  const expected = resolve(
    runtimeDir,
    skillSetHash(frozenNames),
    "skills",
    name,
    SKILL_FILE_NAME,
  );
  return isAbsolute(location) && normalize(location) === expected
    ? name
    : undefined;
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
