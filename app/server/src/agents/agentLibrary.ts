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
  isSafeEntryName,
  isThinkingLevel,
  THINKING_LEVELS,
  type ThinkingLevel,
} from "@assistant/shared";
import { AGENTS_LIBRARY_DIR } from "../config.ts";
import {
  formatManifest,
  parseManifestWith,
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

/**
 * The bound on a whole `AGENT.md`. The body becomes a system-prompt layer the
 * persona budgets never accounted for, so it is small on purpose — and within
 * the core's smallest read bound, which is what lets the rule read the body.
 */
export const MAX_AGENT_MANIFEST_BYTES = 16 * 1024;

/** Bound on a model spec: an alias or an exact model id. */
const MAX_MODEL_CHARS = 128;
const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/;
/** A denied tool: an unprefixed app tool name or a native capability. */
const TOOL_NAME_RE = /^[a-z][a-z0-9_]*$/;
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
  /** As written: an alias (`opus`, `sol`) or an exact model id. */
  model: string;
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
      const model = fields.model;
      if (
        typeof model !== "string" ||
        model.length > MAX_MODEL_CHARS ||
        !MODEL_RE.test(model)
      )
        bad(
          `Frontmatter model must be a model alias or id (letters, digits, ".", "_", ":", "/", "-"; at most ${MAX_MODEL_CHARS} characters).`,
        );
      const effort = fields.effort;
      if (effort !== undefined && !isThinkingLevel(effort))
        bad(`Frontmatter effort must be one of ${THINKING_LEVELS.join(", ")}.`);
      const denyTools = parseDenyList(fields.tools, issues);
      const skills = parseNameList(fields.skills, "skills", issues);
      if (skills.length > 0 && persona !== "developer")
        bad("Frontmatter skills may be set only for persona developer.");
      if (body.trim() === "")
        bad("The body must hold the agent's role instructions; it is empty.");
      return {
        persona: persona as AgentPersona,
        model: model as string,
        ...(isThinkingLevel(effort) ? { effort } : {}),
        denyTools,
        skills,
      };
    },
  );
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
      error: `Frontmatter ${field} must be a list of at most ${MAX_LISTED} names.`,
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
  // The Agents page and its topic arrive with the UI (Task-784); until then no
  // browser shows the library, so there is nothing to refresh.
  publish: async () => undefined,
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
  model: string;
  effort?: ThinkingLevel;
  denyTools?: string[];
  skills?: string[];
  body: string;
}

/**
 * Render complete `AGENT.md` source, deterministically: the same definition
 * always gives the same bytes, so rewriting it makes no empty commit. Strings
 * that may hold anything are JSON-quoted scalars, which the shared YAML subset
 * parses back byte-for-byte.
 */
export function formatAgentManifest(input: AgentDefinitionInput): string {
  const lines = [
    `name: ${input.name}`,
    `description: ${JSON.stringify(input.description)}`,
    `persona: ${input.persona}`,
    `model: ${JSON.stringify(input.model)}`,
  ];
  if (input.effort !== undefined) lines.push(`effort: ${input.effort}`);
  if (input.denyTools?.length)
    lines.push("tools:", `  deny: [${input.denyTools.join(", ")}]`);
  if (input.skills?.length) lines.push(`skills: [${input.skills.join(", ")}]`);
  return formatManifest(lines, input.body);
}
