/**
 * The new-session draft record: what the first send will create, staged on
 * the client until then. Pure, so the rules that decide what a restage keeps
 * are tested here rather than inside `App`.
 *
 * The agent definition a draft starts as (`docs/agent-definitions.md` "UI")
 * is ON the record. Every restage builds a new record, and only a caller that
 * keeps the agent's runtime passes it on, so a model, effort, account or
 * persona pick from any picker, and every fresh start, drops it without each
 * caller having to remember.
 */
import type {
  AgentType,
  Harness,
  SessionMode,
  ThinkingLevel,
} from "@assistant/shared";
import { hasModeAxis } from "./sessionCapabilities.ts";

export interface StagedSessionRecord {
  id: string;
  harness: Harness;
  agentType: AgentType;
  provider?: string;
  modelId?: string;
  thinkingLevel: ThinkingLevel;
  /** Build/Plan staged for the first send (absent = Build). */
  mode?: SessionMode;
  /** The agent definition this session starts as. */
  agent?: string;
}

export interface StagedSessionInput {
  id: string;
  harness: Harness;
  agentType: AgentType;
  provider?: string | undefined;
  modelId?: string | undefined;
  thinkingLevel?: ThinkingLevel | undefined;
  mode: SessionMode | undefined;
  /** Only a restage that keeps the agent's runtime passes it on. */
  agent?: string | undefined;
}

/** The record a (re)stage writes. */
export function stagedSessionRecord(
  input: StagedSessionInput,
): StagedSessionRecord {
  return {
    id: input.id,
    harness: input.harness,
    agentType: input.agentType,
    ...(input.provider !== undefined ? { provider: input.provider } : {}),
    ...(input.modelId !== undefined ? { modelId: input.modelId } : {}),
    thinkingLevel: input.thinkingLevel ?? "off",
    // Only the personas WITH the mode axis can carry Plan, so a switch to an
    // assistant persona drops it rather than hiding it.
    ...(hasModeAxis({ agentType: input.agentType }) && input.mode !== undefined
      ? { mode: input.mode }
      : {}),
    ...(input.agent !== undefined ? { agent: input.agent } : {}),
  };
}

/**
 * The agent a persona switch keeps: staging context (a worktree) restages the
 * same persona and keeps it; another persona is not the agent's any more.
 */
export function agentAcrossPersonaSwitch(
  current:
    { agentType: AgentType; agent?: string | undefined } | null | undefined,
  agentType: AgentType,
): string | undefined {
  return current?.agentType === agentType ? current.agent : undefined;
}

/**
 * The draft once the user has left the new-session page: Plan and a picked
 * agent belong to the draft they left, not to whatever the page stages next.
 */
export function leftNewSessionPage(
  record: StagedSessionRecord | null,
): StagedSessionRecord | null {
  if (!record || (record.mode === undefined && record.agent === undefined))
    return record;
  const { mode: _spent, agent: _left, ...rest } = record;
  return rest;
}
