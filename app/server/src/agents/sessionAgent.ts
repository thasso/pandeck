/**
 * The agent definition a session runs as (`docs/agent-definitions.md` "What a
 * spawn freezes"). A spawn resolves the definition once and freezes it per
 * session, insert-only, so a resume, a fork and every rebuilt system prompt
 * read the same definition however the library has changed since.
 *
 * A row that does not parse fails CLOSED: the session refuses to run rather
 * than run without the role and the denied tools it was spawned with.
 */
import {
  isSafeEntryName,
  SESSION_AGENT_RUNTIME_SOURCES,
  THINKING_LEVELS,
  type SessionAgentRuntimeSource,
  type SessionAgentSummary,
  type ThinkingLevel,
} from "@assistant/shared";
import { sessionStore } from "../db/sessionStore.ts";
import { AGENT_PERSONAS, type AgentPersona } from "./agentLibrary.ts";

/** One definition as a session froze it at spawn. */
export interface SessionAgent {
  name: string;
  /** Git blob id of the `AGENT.md` it was spawned from. */
  blob: string;
  persona: AgentPersona;
  provider: string;
  model: string;
  /**
   * The concrete version a definition pinned (`claude-opus-5-5`), run in place
   * of whatever `model`, the alias, maps to later.
   */
  pinnedModel?: string;
  /** The effort it runs at, already fitted to the model. */
  effort: ThinkingLevel;
  /**
   * Who chose the runtime above: one of the definition's listed models, the
   * user in a proposal card, or the user on the new-session page. A row
   * stored before this existed came from the definition.
   */
  runtimeSource: SessionAgentRuntimeSource;
  /** Why an automatic spawn used a later listed model. Frozen with the runtime. */
  modelFallbackReason?: string;
  denyTools: string[];
  skills: string[];
  body: string;
}

/** A stored row this build cannot read; the session must not run without it. */
export class SessionAgentUnreadableError extends Error {}

function isStringList(value: unknown): value is string[] {
  return (
    Array.isArray(value) && value.every((item) => typeof item === "string")
  );
}

/** Read one stored row, or throw: there is no partial agent to fall back to. */
function parseSessionAgent(sessionId: string, raw: string): SessionAgent {
  let value: Partial<Record<keyof SessionAgent, unknown>> | undefined;
  try {
    value = JSON.parse(raw) as typeof value;
  } catch {
    value = undefined;
  }
  if (
    value &&
    typeof value.name === "string" &&
    isSafeEntryName(value.name) &&
    typeof value.blob === "string" &&
    (AGENT_PERSONAS as readonly unknown[]).includes(value.persona) &&
    typeof value.provider === "string" &&
    typeof value.model === "string" &&
    (value.pinnedModel === undefined ||
      typeof value.pinnedModel === "string") &&
    (THINKING_LEVELS as readonly unknown[]).includes(value.effort) &&
    (value.runtimeSource === undefined ||
      (SESSION_AGENT_RUNTIME_SOURCES as readonly unknown[]).includes(
        value.runtimeSource,
      )) &&
    (value.modelFallbackReason === undefined ||
      typeof value.modelFallbackReason === "string") &&
    isStringList(value.denyTools) &&
    isStringList(value.skills) &&
    typeof value.body === "string"
  )
    return {
      name: value.name,
      blob: value.blob,
      persona: value.persona as AgentPersona,
      provider: value.provider,
      model: value.model,
      ...(typeof value.pinnedModel === "string"
        ? { pinnedModel: value.pinnedModel }
        : {}),
      effort: value.effort as ThinkingLevel,
      runtimeSource:
        (value.runtimeSource as SessionAgentRuntimeSource | undefined) ??
        "definition",
      ...(typeof value.modelFallbackReason === "string"
        ? { modelFallbackReason: value.modelFallbackReason }
        : {}),
      denyTools: value.denyTools,
      skills: value.skills,
      body: value.body,
    };
  throw new SessionAgentUnreadableError(
    `Session ${sessionId} was spawned from an agent definition whose stored copy is unreadable, so it cannot run.`,
  );
}

/** The definition a session froze, or undefined for one not spawned from one. */
export function sessionAgent(sessionId: string): SessionAgent | undefined {
  const raw = sessionStore.getAgent(sessionId);
  return raw === undefined ? undefined : parseSessionAgent(sessionId, raw);
}

/**
 * Freeze `agent` for the session, or keep the row that already won: the
 * result is always the stored row. Throws when nothing can be stored, so a
 * session never starts without the definition it was spawned as.
 */
export function freezeSessionAgent(
  sessionId: string,
  agent: SessionAgent,
): SessionAgent {
  const stored = sessionStore.freezeAgent(sessionId, JSON.stringify(agent));
  if (stored === undefined)
    throw new Error(
      `The agent definition for session ${sessionId} could not be stored.`,
    );
  return parseSessionAgent(sessionId, stored);
}

/** The frozen definition for display, where an unreadable row reads as none. */
export function displayedSessionAgent(
  sessionId: string,
): SessionAgent | undefined {
  try {
    return sessionAgent(sessionId);
  } catch {
    return undefined;
  }
}

/** What the session inspector shows; never throws, since it is display only. */
export function sessionAgentSummary(
  sessionId: string,
): SessionAgentSummary | undefined {
  let agent: SessionAgent | undefined;
  try {
    agent = sessionAgent(sessionId);
  } catch {
    return { name: "unreadable", unreadable: true };
  }
  if (!agent) return undefined;
  return {
    name: agent.name,
    blob: agent.blob,
    model: `${agent.provider}/${agent.model}${
      agent.pinnedModel ? ` (${agent.pinnedModel})` : ""
    }`,
    effort: agent.effort,
    runtimeSource: agent.runtimeSource,
    ...(agent.modelFallbackReason
      ? { modelFallbackReason: agent.modelFallbackReason }
      : {}),
    denyTools: agent.denyTools,
    skills: agent.skills,
  };
}
