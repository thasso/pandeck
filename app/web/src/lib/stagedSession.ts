/**
 * The new-session draft record: what the first send will create, staged on
 * the client until then. Pure, so the rules that decide what a restage keeps
 * are tested here rather than inside `App`.
 *
 * The agent definition a draft starts as (`docs/agent-definitions.md` "UI")
 * is ON the record. Every restage builds a new record, and only a caller that
 * keeps the role passes it on: a model, effort, account or Build/Plan pick
 * keeps it, since what runs a role is the user's choice, while a persona pick
 * and every fresh start drop it without each caller having to remember.
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
  /** Only a restage that keeps the role passes it on. */
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
  /** Whether only enterprise accounts may run it, as the switch shows now. */
  requiresEnterprise?: boolean | undefined;
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
 * now — engine, persona, account and its enterprise requirement, model, effort
 * and agent — so a pick made after the failure is the one sent, and a dropped
 * agent stays dropped. A pick
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
    requiresEnterprise: _enterprise,
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
    ...(draft.requiresEnterprise ? { requiresEnterprise: true } : {}),
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

/** One runtime a definition can be staged on, as its row in the list says. */
interface AgentPrefill {
  persona: "developer" | "assistant";
  provider: string;
  modelId: string;
  thinkingLevel: ThinkingLevel;
}

/**
 * The runtime picking the definition `name` pre-fills: its first listed model
 * that resolves and that an enabled account can run, at its effort. The user
 * may pick any other afterwards. Undefined when none can, or the definition
 * itself is unknown or broken.
 */
export function agentPrefill(
  list: EntryLibraryList | undefined,
  name: string,
  accounts: ReadonlyArray<{ provider: string }>,
): AgentPrefill | undefined {
  const runtime = agentRuntimeOf(list, name);
  if (!runtime?.persona) return undefined;
  const runnable = (provider: string) => {
    const accountProvider = accountProviderForModelProvider(provider);
    return accounts.some((account) => account.provider === accountProvider);
  };
  const listed =
    runtime.problem === undefined
      ? [runtime, ...runtime.models.slice(1)]
      : (runtime.models ?? []);
  for (const model of listed)
    if (model.provider !== undefined && runnable(model.provider))
      return {
        persona: runtime.persona,
        provider: model.provider,
        modelId: model.modelId,
        thinkingLevel: model.thinkingLevel,
      };
  return undefined;
}

/**
 * What staging the definition `name` sets: its persona, and the runtime it
 * pre-fills (`agentPrefill`) with the account to run it on — the picked one
 * when it is of the model's provider, else the first of that provider.
 * Undefined when the definition cannot be staged, so a pick is never staged
 * on another provider's account.
 */
export function agentDraft(
  list: EntryLibraryList | undefined,
  name: string,
  accounts: ReadonlyArray<{ id: string; provider: string }>,
  pickedAccountId: string | null | undefined,
):
  | (Omit<StagedSessionInput, "id" | "mode"> & {
      agent: string;
      accountId: string;
    })
  | undefined {
  const prefill = agentPrefill(list, name, accounts);
  if (!prefill) return undefined;
  const accountProvider = accountProviderForModelProvider(prefill.provider);
  const account =
    accounts.find(
      (candidate) =>
        candidate.id === pickedAccountId &&
        candidate.provider === accountProvider,
    ) ?? accounts.find((candidate) => candidate.provider === accountProvider);
  if (!account) return undefined;
  return {
    harness: harnessForModelProvider(prefill.provider),
    agentType: prefill.persona,
    provider: prefill.provider,
    modelId: prefill.modelId,
    thinkingLevel: prefill.thinkingLevel,
    agent: name,
    accountId: account.id,
  };
}

/**
 * Whether a draft's role survives a new agents list: dropped when the
 * definition is gone, broken beyond its models, or runs as another persona
 * now; else kept. Its runtime is never restaged: what the pickers show is the
 * user's choice, and the first send runs it. An unread list says nothing, so
 * it keeps.
 *
 * A persona is not restaged under the user: it decides which worktree the
 * draft needs, and a draft whose first send is held for retry offers no
 * persona or worktree picker any more. Restaging it would leave a Developer
 * draft without a worktree that no control can give it.
 */
export function reconcileStagedAgent(
  record: StagedSessionRecord | null,
  list: EntryLibraryList | undefined,
): "keep" | "drop" {
  if (!record?.agent || !list) return "keep";
  const runtime = agentRuntimeOf(list, record.agent);
  if (!runtime?.persona) return "drop";
  return runtime.persona === record.agentType ? "keep" : "drop";
}
