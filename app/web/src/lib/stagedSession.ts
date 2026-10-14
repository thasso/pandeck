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
import {
  accountProviderForModelProvider,
  agentRuntimeOf,
  harnessForModelProvider,
  type AgentType,
  type EntryLibraryList,
  type Harness,
  type SessionMode,
  type ThinkingLevel,
} from "@assistant/shared";
import type { HarnessSendInput } from "../hooks/useAssistant.ts";
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

/** What the pickers show for the draft right now. */
export interface DraftRuntime {
  /** The staged session's id, when the draft has one of its own. */
  id?: string | undefined;
  harness: Harness;
  agentType: AgentType;
  /** The account picked for it. */
  credentialProfileId?: string | undefined;
  provider?: string | undefined;
  modelId?: string | undefined;
  thinkingLevel?: ThinkingLevel | undefined;
  mode?: SessionMode | undefined;
  agent?: string | undefined;
}

/**
 * A failed first send re-issued, from the composer or a Retry button. Its
 * consumed context (the Task, the worktree, the project to provision in) and
 * request identity are the held send's; what RUNS it is what the pickers show
 * now — engine, persona, account, model, effort and agent — so a pick made
 * after the failure is the one sent, and a dropped agent stays dropped. A pick
 * that restaged the draft gave it a new id, which the send takes too, so it
 * lands on the session the page shows.
 */
export function reissuedFirstSend(
  held: HarnessSendInput,
  draft: DraftRuntime,
  content: Pick<HarnessSendInput, "text" | "attachments">,
): HarnessSendInput {
  const {
    agentType: _persona,
    credentialProfileId: _account,
    modelProvider: _provider,
    modelId: _model,
    thinkingLevel: _thinking,
    mode: _mode,
    agent: _agent,
    ...context
  } = held;
  return {
    ...context,
    id: draft.id ?? held.id,
    harness: draft.harness,
    agentType: draft.agentType,
    ...(draft.credentialProfileId !== undefined
      ? { credentialProfileId: draft.credentialProfileId }
      : {}),
    ...(draft.provider !== undefined ? { modelProvider: draft.provider } : {}),
    ...(draft.modelId !== undefined ? { modelId: draft.modelId } : {}),
    ...(draft.thinkingLevel !== undefined
      ? { thinkingLevel: draft.thinkingLevel }
      : {}),
    ...(draft.mode !== undefined ? { mode: draft.mode } : {}),
    ...(draft.agent !== undefined ? { agent: draft.agent } : {}),
    text: content.text,
    ...(content.attachments !== undefined
      ? { attachments: content.attachments }
      : {}),
  };
}

/** A draft without its agent definition: the same runtime, a plain session. */
export function withoutAgent(record: StagedSessionRecord): StagedSessionRecord {
  if (record.agent === undefined) return record;
  const { agent: _dropped, ...plain } = record;
  return plain;
}

/**
 * What staging the definition `name` sets: its persona, engine, model and
 * effort, and the account to run it on — the picked one when it is of the
 * model's provider, else the first of that provider. Undefined when the
 * definition cannot start (unknown, with a problem, or with no account of its
 * provider), so a pick is never staged on another provider's account.
 */
export function agentDraft(
  list: EntryLibraryList | undefined,
  name: string,
  accounts: ReadonlyArray<{ id: string; provider: string }>,
  pickedAccountId: string | undefined,
):
  | (Omit<StagedSessionInput, "id" | "mode"> & {
      agent: string;
      accountId: string;
    })
  | undefined {
  const runtime = agentRuntimeOf(list, name);
  if (!runtime || runtime.problem !== undefined) return undefined;
  const accountProvider = accountProviderForModelProvider(runtime.provider);
  const account =
    accounts.find(
      (candidate) =>
        candidate.id === pickedAccountId &&
        candidate.provider === accountProvider,
    ) ?? accounts.find((candidate) => candidate.provider === accountProvider);
  if (!account) return undefined;
  return {
    harness: harnessForModelProvider(runtime.provider),
    agentType: runtime.persona,
    provider: runtime.provider,
    modelId: runtime.modelId,
    thinkingLevel: runtime.thinkingLevel,
    agent: name,
    accountId: account.id,
  };
}

/**
 * How a draft's agent follows a new agents list: dropped when the definition
 * is gone or cannot start, restaged when what it runs on changed, else kept.
 * An unread list says nothing, so it keeps.
 */
export function reconcileStagedAgent(
  record: StagedSessionRecord | null,
  list: EntryLibraryList | undefined,
): "keep" | "drop" | "restage" {
  if (!record?.agent || !list) return "keep";
  const runtime = agentRuntimeOf(list, record.agent);
  if (!runtime || runtime.problem !== undefined) return "drop";
  const same =
    runtime.persona === record.agentType &&
    runtime.provider === record.provider &&
    runtime.modelId === record.modelId &&
    runtime.thinkingLevel === record.thinkingLevel;
  return same ? "keep" : "restage";
}
