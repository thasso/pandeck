/**
 * Session-START conditional prompt assembly (Task 287).
 *
 * A persona's system prompt carries sections that only some sessions can use:
 * the Slack/Google paragraphs are dead weight while those integrations are off,
 * the Tempo paragraph likewise, the Project Registry pointer is redundant when
 * the session already opened with Project context, and the memory write rules
 * mean nothing to a persona that may not write memory. The eager attachment
 * tools are the same kind of conditional: their block only earns its place in a
 * session whose first prompt carried user files.
 *
 * ## Why this is frozen, and frozen HARD
 *
 * The conditions are computed ONCE, the first time a session's prompt (or eager
 * tool tier) is assembled, and persisted with the session record
 * (`sessionStore.freezePromptConditions`, insert-only). Every later assembly —
 * a resumed Claude query, a pi reopen, a pi system-prompt rebuild on deferred
 * tool activation — reads the frozen record and reproduces the same bytes.
 *
 * This is not an optimization detail: a Claude session resends its system
 * prompt on every resumed query and pi rebuilds it on every
 * `setActiveToolsByName`, so a condition that moved mid-session would bust the
 * provider's cache prefix for the WHOLE conversation. Nothing here may become
 * per-turn.
 *
 * The visible consequence, by design: enabling Slack (or attaching a file)
 * after a session started does not change that session's prompt. The tools
 * still arrive live through `tools/list_changed`; the prose reaches the next
 * session. For the permanent Personal Assistant that means its singleton picks
 * up newly enabled integrations when its conversation is rotated.
 */
import type { AgentType } from "./agentTypes.ts";
import { sessionStore } from "./db/sessionStore.ts";
import { getProject } from "./projectRegistry.ts";
import { currentIntegrationToolGates } from "./tools/toolPolicy.ts";

/**
 * The session-start facts the prompt assembly branches on. Each key switches
 * exactly one prompt section or eager tool group, so a condition record reads
 * as "which optional pieces this session carries".
 */
export interface PromptConditions {
  /**
   * The session's first prompt carried USER FILE attachments — deliberately
   * narrower than "has attachments": the hidden Task/Project/Knowledge context
   * attachments do not count, because their body is inlined in the prompt and
   * needs no tool to read. Switches the eager attachment tool group.
   */
  attachments: boolean;
  /** Slack integration was enabled at session start. */
  slack: boolean;
  /** Google Workspace integration was enabled at session start. */
  google: boolean;
  /** Tempo integration was enabled at session start. */
  tempo: boolean;
  /**
   * The session started WITHOUT a known Project's context attached, so it needs
   * the eager Project Registry pointer.
   *
   * A session that DID start on a known Project gets that pointer's two jobs
   * from its context attachment instead: the registry evidence and how to weigh
   * it, plus — deliberately added for this condition — the names of the two
   * deferred `project_registry_*` tools, so dropping the eager section costs
   * duplication and not tool DISCOVERY (`buildProjectContext` in
   * `sessionProjectContext.ts`; the two must stay in step).
   */
  projectRegistryPointer: boolean;
  /** This persona may WRITE memory (the write-side rules apply to it). */
  memoryWrite: boolean;
}

export type PromptConditionKey = keyof PromptConditions;

export const PROMPT_CONDITION_KEYS: readonly PromptConditionKey[] = [
  "attachments",
  "slack",
  "google",
  "tempo",
  "projectRegistryPointer",
  "memoryWrite",
];

/**
 * Every conditional section included. The default for callers that have no
 * session (one-shot agents, the prompt inventory, tests): assembly must
 * fail-OPEN, so a path that forgets to pass conditions loses a saving, never a
 * rule.
 */
const ALL_PROMPT_CONDITIONS: PromptConditions = {
  attachments: true,
  slack: true,
  google: true,
  tempo: true,
  projectRegistryPointer: true,
  memoryWrite: true,
};

/** What a session knows about itself when it starts. */
export interface SessionPromptEvidence {
  /** User file attachments carried by the session's first prompt. */
  hasAttachments?: boolean;
  /** Project id the session opens on (standalone Project, worktree, or Task). */
  projectId?: string;
}

/** Only these personas may write memory (coding sessions read it only). */
function personaWritesMemory(agentType: AgentType): boolean {
  return agentType === "assistant" || agentType === "personal-assistant";
}

/**
 * Everything this persona could possibly carry: the measurement baseline the
 * per-condition savings are subtracted from. Unlike {@link ALL_PROMPT_CONDITIONS}
 * it keeps `memoryWrite` at the persona's real capability, because that one is
 * a property of the persona, not a saving a session can win.
 */
export function maximalPromptConditions(
  agentType: AgentType,
): PromptConditions {
  return {
    ...ALL_PROMPT_CONDITIONS,
    memoryWrite: personaWritesMemory(agentType),
  };
}

/**
 * The conditions a session STARTING NOW would get. Reads the live integration
 * gates, so it is only ever correct at session start — call
 * {@link sessionPromptConditions} for anything session-scoped.
 */
export function computePromptConditions(
  agentType: AgentType,
  evidence: SessionPromptEvidence = {},
): PromptConditions {
  const gates = currentIntegrationToolGates();
  // A registry-evidence block only ships with the context attachment when the
  // project is actually IN the registry; an unknown id gets a warning instead,
  // and that session still needs the eager pointer.
  const projectId = evidence.projectId?.trim();
  const knownProject = Boolean(projectId && getProject(projectId));
  return {
    attachments: Boolean(evidence.hasAttachments),
    slack: gates.slack,
    google: gates.google,
    tempo: gates.tempo,
    projectRegistryPointer: !knownProject,
    memoryWrite: personaWritesMemory(agentType),
  };
}

/**
 * This session's conditions: the frozen record if it has one, otherwise
 * computed from `evidence` and frozen now.
 *
 * Creation paths pass their evidence; every later caller (resume, reopen, tool
 * activation, the tool inspector) passes none and gets the same bytes back. A
 * session that predates the freeze — or one whose creation path has no evidence
 * to give — freezes on first use instead, which is the honest fallback: its
 * prompt is stable from that point on.
 */
export function sessionPromptConditions(
  sessionId: string,
  agentType: AgentType,
  evidence?: SessionPromptEvidence,
  /**
   * Conditions to freeze instead of computing fresh ones — a fork passes its
   * parent's record so the branch keeps the prompt the conversation was built
   * with. Ignored once this session has its own.
   */
  preset?: PromptConditions,
): PromptConditions {
  const stored = parsePromptConditions(
    sessionStore.getPromptConditions(sessionId),
  );
  if (stored) return withPersonaMemoryRule(stored, agentType);
  const computed = preset ?? computePromptConditions(agentType, evidence);
  const frozen =
    parsePromptConditions(
      sessionStore.freezePromptConditions(sessionId, JSON.stringify(computed)),
    ) ?? computed;
  return withPersonaMemoryRule(frozen, agentType);
}

/**
 * `memoryWrite` is a property of the PERSONA, not of the session, so the
 * persona always wins over the record. Every other key fails open to more text;
 * this one would fail open to a DIFFERENT rule — a record from an older build
 * without the key would hand a coding session the write rules in place of its
 * read-only ones. The persona is the authority either way, so a stored value
 * that disagrees with it is simply wrong.
 */
function withPersonaMemoryRule(
  conditions: PromptConditions,
  agentType: AgentType,
): PromptConditions {
  const memoryWrite = personaWritesMemory(agentType);
  return conditions.memoryWrite === memoryWrite
    ? conditions
    : { ...conditions, memoryWrite };
}

/**
 * Read a persisted record back into a full condition set. Unknown/missing keys
 * fail open to "section included" for the same reason as
 * {@link ALL_PROMPT_CONDITIONS}: a record written by an older build must not
 * silently drop a rule from the prompt.
 */
export function parsePromptConditions(
  raw: string | undefined,
): PromptConditions | undefined {
  if (!raw) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    return undefined;
  const record = parsed as Record<string, unknown>;
  const out = { ...ALL_PROMPT_CONDITIONS };
  for (const key of PROMPT_CONDITION_KEYS)
    if (typeof record[key] === "boolean") out[key] = record[key];
  return out;
}
