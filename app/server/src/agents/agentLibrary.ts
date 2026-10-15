/**
 * The agent definitions library as one kind of the shared library core
 * (`docs/agent-definitions.md`): `DATA_DIR/agents/<folder>/AGENT.md`, a
 * user-owned Git repository like the skills library and built on the same
 * code.
 *
 * This module owns the ONE content rule for `AGENT.md` — what the frontmatter
 * may say — and the one way the app renders it. Whether a definition can RUN
 * (its model resolves against the connected accounts, its denied tools exist,
 * its skills are valid) depends on state outside the file and is checked
 * separately, at write and at spawn (`agentRuntime.ts`).
 */
import {
  isCodingAgentType,
  isSafeEntryName,
  isThinkingLevel,
  THINKING_LEVELS,
  type ThinkingLevel,
} from "@assistant/shared";
import { AGENTS_LIBRARY_DIR } from "../config.ts";
import {
  formatManifest,
  parseManifestWith,
  yamlList,
  yamlScalar,
  yamlString,
  type ManifestIssue,
} from "../library/entryManifest.ts";
import type { LibraryKind } from "../library/libraryKind.ts";
import { scanLibrary, type LibraryScan } from "../library/libraryScanner.ts";
import { LibraryStore } from "../library/libraryStore.ts";

/** The personas a definition may build on: the ones `session_spawn` starts. */
export const AGENT_PERSONAS = ["developer", "assistant"] as const;
export type AgentPersona = (typeof AGENT_PERSONAS)[number];

/**
 * Harness-neutral names for the native capabilities a definition may deny;
 * each harness maps them to its own tools at spawn.
 */
export const AGENT_NATIVE_TOOLS = ["bash", "edit", "write"] as const;
export type AgentNativeTool = (typeof AGENT_NATIVE_TOOLS)[number];

/** The effort a definition without one runs at, fitted to its model. */
export const AGENT_DEFAULT_EFFORT = "medium" satisfies ThinkingLevel;

/**
 * The bound on a whole `AGENT.md`. The body becomes a system-prompt layer the
 * persona budgets never accounted for, so it is small on purpose — and within
 * the core's smallest read bound, which is what lets the rule read the body.
 */
export const MAX_AGENT_MANIFEST_BYTES = 16 * 1024;

/** Bound on a model spec: an alias or an exact model id. */
const MAX_MODEL_CHARS = 128;
/** How many models one definition may list; a card has to stay readable. */
export const MAX_AGENT_MODELS = 8;
const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/;
/** A denied tool: an unprefixed app tool name or a native capability. */
const TOOL_NAME_RE = /^[a-z][a-z0-9_]{0,63}$/;
const MAX_LISTED = 64;

const KNOWN_KEYS = new Set([
  "name",
  "description",
  "persona",
  "model",
  "effort",
  "tools",
  "skills",
]);

/** A valid `AGENT.md`, typed. */
export interface AgentManifest {
  name: string;
  description: string;
  /** Role instructions: the system-prompt layer a spawned session gets. */
  body: string;
  persona: AgentPersona;
  /**
   * The models it may run on, as written: aliases (`opus`, `sol`) or exact
   * ids. Never empty; the first is the default. A file may write one model as
   * a plain value.
   */
  models: string[];
  effort?: ThinkingLevel;
  /** Tools the spawned session must not have; empty when none. */
  denyTools: string[];
  /** Library skills to mount on top of the enabled set; developer only. */
  skills: string[];
}

type AgentFields = Omit<AgentManifest, "name" | "description" | "body">;

/** The whole `AGENT.md` content rule, for scanning and authoring alike. */
export function parseAgentManifest(content: string, path: string) {
  return parseManifestWith<AgentFields>(
    content,
    path,
    (fields, issues, body) => {
      const bad = (error: string): void => {
        issues.push({ code: "invalid-field", error });
      };
      for (const key of Object.keys(fields)) {
        if (!KNOWN_KEYS.has(key))
          bad(
            `Unknown frontmatter key "${key}"; an AGENT.md may set only ${[...KNOWN_KEYS].join(", ")}.`,
          );
      }
      const persona = fields.persona;
      if (!AGENT_PERSONAS.includes(persona as AgentPersona))
        bad(`Frontmatter persona must be one of ${AGENT_PERSONAS.join(", ")}.`);
      const models = parseModels(fields.model, issues);
      const effort = fields.effort;
      if (effort !== undefined && !isThinkingLevel(effort))
        bad(`Frontmatter effort must be one of ${THINKING_LEVELS.join(", ")}.`);
      const denyTools = parseDenyList(fields.tools, issues);
      const skills = parseNameList(fields.skills, "skills", issues);
      // Skills mount only where a session has a workspace to mount them in.
      if (skills.length > 0 && !isCodingAgentType(persona as AgentPersona))
        bad("Frontmatter skills may be set only for persona developer.");
      if (body.trim() === "")
        bad("The body must hold the agent's role instructions; it is empty.");
      return {
        persona: persona as AgentPersona,
        models,
        ...(isThinkingLevel(effort) ? { effort } : {}),
        denyTools,
        skills,
      };
    },
  );
}

/** `model`: one spec, or a list of them whose first entry is the default. */
function parseModels(value: unknown, issues: ManifestIssue[]): string[] {
  const models = Array.isArray(value) ? value : [value];
  if (
    models.length === 0 ||
    models.length > MAX_AGENT_MODELS ||
    !models.every(
      (model) =>
        typeof model === "string" &&
        model.length <= MAX_MODEL_CHARS &&
        MODEL_RE.test(model),
    )
  ) {
    issues.push({
      code: "invalid-field",
      error: `Frontmatter model must be a model alias or id, or a list of 1-${MAX_AGENT_MODELS} of them (letters, digits, ".", "_", ":", "/", "-"; at most ${MAX_MODEL_CHARS} characters each).`,
    });
    return [];
  }
  const specs = models as string[];
  if (new Set(specs.map((spec) => spec.toLowerCase())).size !== specs.length) {
    issues.push({
      code: "invalid-field",
      error: "Frontmatter model lists a model twice.",
    });
    return [];
  }
  return specs;
}

function parseDenyList(value: unknown, issues: ManifestIssue[]): string[] {
  if (value === undefined) return [];
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    issues.push({
      code: "invalid-field",
      error: "Frontmatter tools must be a mapping with a deny list.",
    });
    return [];
  }
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (key !== "deny")
      issues.push({
        code: "invalid-field",
        error: `Unknown key "tools.${key}"; tools may set only deny.`,
      });
  }
  return parseList(record.deny, "tools.deny", TOOL_NAME_RE, issues);
}

function parseNameList(
  value: unknown,
  field: string,
  issues: ManifestIssue[],
): string[] {
  if (value === undefined) return [];
  const names = parseList(value, field, /^.+$/, issues);
  const unsafe = names.filter((name) => !isSafeEntryName(name));
  if (unsafe.length > 0) {
    issues.push({
      code: "invalid-field",
      error: `Frontmatter ${field} must list declared skill names; not valid: ${unsafe.join(", ")}.`,
    });
    return [];
  }
  return names;
}

function parseList(
  value: unknown,
  field: string,
  pattern: RegExp,
  issues: ManifestIssue[],
): string[] {
  if (value === undefined) return [];
  if (
    !Array.isArray(value) ||
    value.length > MAX_LISTED ||
    !value.every((item) => typeof item === "string" && pattern.test(item))
  ) {
    issues.push({
      code: "invalid-field",
      error: `Frontmatter ${field} must be a list of at most ${MAX_LISTED} names of at most 64 characters.`,
    });
    return [];
  }
  const names = value as string[];
  if (new Set(names).size !== names.length) {
    issues.push({
      code: "invalid-field",
      error: `Frontmatter ${field} lists a name twice.`,
    });
    return [];
  }
  return names;
}

/** The descriptor the shared core runs agent definitions with. */
export const agentKind: LibraryKind<AgentManifest> = {
  noun: "agent",
  plural: "agents",
  manifestFile: "AGENT.md",
  trailerPrefix: "Agent",
  parseManifest: parseAgentManifest,
  maxManifestBytes: MAX_AGENT_MANIFEST_BYTES,
  // Imported when first used: the list module resolves runtimes through the
  // spawn path, which reaches this module, so a static import would close a
  // cycle.
  publish: async (library) =>
    (await import("./agentLibraryList.ts")).publishAgentLibrary(library),
};

/** The process-wide agents store: one bootstrap, one mutation lock chain. */
export const agentLibraryStore = new LibraryStore(
  agentKind,
  AGENTS_LIBRARY_DIR,
);

/** One fresh scan of an agents working tree. */
export function scanAgentLibrary(
  root: string,
  options?: Parameters<typeof scanLibrary>[2],
): Promise<LibraryScan> {
  return scanLibrary(agentKind, root, options);
}

/** The definition fields an author supplies; `name` doubles as the folder. */
export interface AgentDefinitionInput {
  name: string;
  description: string;
  persona: AgentPersona;
  /** Never empty; the first is the default. */
  models: string[];
  effort?: ThinkingLevel;
  denyTools?: string[];
  skills?: string[];
  body: string;
}

/**
 * Render complete `AGENT.md` source, deterministically: the same definition
 * always gives the same bytes, so rewriting it makes no empty commit. Strings
 * that may hold anything are quoted with `yamlString`, which the shared YAML
 * subset parses back byte-for-byte.
 */
export function formatAgentManifest(input: AgentDefinitionInput): string {
  const lines = [
    `name: ${yamlScalar(input.name)}`,
    `description: ${yamlString(input.description)}`,
    `persona: ${input.persona}`,
    // One model stays the plain value every definition used to have.
    `model: ${
      input.models.length === 1
        ? yamlString(input.models[0]!)
        : yamlList(input.models)
    }`,
  ];
  if (input.effort !== undefined) lines.push(`effort: ${input.effort}`);
  if (input.denyTools?.length)
    lines.push("tools:", `  deny: ${yamlList(input.denyTools)}`);
  if (input.skills?.length) lines.push(`skills: ${yamlList(input.skills)}`);
  return formatManifest(lines, input.body);
}
