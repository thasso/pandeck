/**
 * The inspector's Runtime section and the composer's runtime chip, built from
 * app state (`docs/session-runtime-switching.md`). Pure, so the rules a picker
 * applies (which models and accounts it offers, and why one is disabled) are
 * tested without the app.
 */
import {
  accountServesModel,
  harnessForModelProvider,
  isSubscriptionAccountKind,
  type CredentialProfileProvider,
  type Harness,
  type ModelOption,
  type SessionAccountMoveTarget,
  type SessionPendingRuntime,
  type SessionRuntimeChange,
  type ThinkingLevel,
} from "@assistant/shared";
import type { SessionRuntimeControl } from "../components/SessionRuntimeSection.tsx";
import { dataOf, type LoadState } from "./loadState.ts";
import type { RuntimeCommandContext } from "./runtimeSlashCommand.ts";

/** Why another harness's model is disabled; sub-PR 3 lifts this. */
export const OTHER_HARNESS_REASON = "Another harness: not available yet";
/** Why a model the bound account's kind cannot run is disabled. */
export const OTHER_ACCOUNT_KIND_REASON = "Needs another kind of account";

interface Account {
  id: string;
  name: string;
  provider: CredentialProfileProvider;
}

/**
 * Why `model` cannot be the next model of a session on `harness` bound to
 * `account`, or undefined when it can: the server refuses the same targets.
 */
export function runtimeModelRefusal(
  model: Pick<ModelOption, "provider">,
  harness: Harness,
  account: Account | undefined,
): string | undefined {
  if (harnessForModelProvider(model.provider) !== harness)
    return OTHER_HARNESS_REASON;
  if (account && !accountServesModel(account, model.provider))
    return OTHER_ACCOUNT_KIND_REASON;
  return undefined;
}

/** The section's control, or undefined for a session that has not started. */
export function sessionRuntimeControl(input: {
  sessionId: string | undefined;
  started: boolean;
  harness: Harness;
  model: { provider: string; id: string; name?: string } | undefined;
  thinkingLevel: ThinkingLevel | undefined;
  pending: SessionPendingRuntime | undefined;
  account: Account | undefined;
  accounts: readonly Account[];
  models: readonly ModelOption[];
  targets: LoadState<SessionAccountMoveTarget[]> | undefined;
  busy: boolean;
  actions: {
    listSessionAccountMoveTargets: (sessionId: string) => void;
    setPendingRuntime: (
      sessionId: string,
      change: SessionRuntimeChange,
    ) => void;
    clearPendingRuntime: (sessionId: string) => void;
  };
}): SessionRuntimeControl | undefined {
  const { sessionId, harness, account, actions } = input;
  if (!sessionId || !input.started) return undefined;
  const refusal = (model: ModelOption) =>
    runtimeModelRefusal(model, harness, account);
  // This engine's models first, then the ones it cannot switch to yet.
  const models = [...input.models].sort(
    (a, b) => Number(!!refusal(a)) - Number(!!refusal(b)),
  );
  return {
    current: {
      model: input.model,
      thinkingLevel: input.thinkingLevel,
      accountName: account?.name,
    },
    pending: input.pending,
    models,
    modelRefusal: refusal,
    // Only a subscription login ever moves; any other account alone serves
    // its models (the server refuses those too).
    accounts:
      account && isSubscriptionAccountKind(account.provider)
        ? {
            targets: input.targets,
            onOpen: () => actions.listSessionAccountMoveTargets(sessionId),
            nameOf: (id) =>
              input.accounts.find((candidate) => candidate.id === id)?.name,
          }
        : undefined,
    busy: input.busy,
    onChange: (change) => actions.setPendingRuntime(sessionId, change),
    onReset: () => actions.clearPendingRuntime(sessionId),
  };
}

/**
 * The accounts `/account` may name: the bound account, and the accounts the
 * SERVER judged the session may move to for the model and effort its next turn
 * starts on (`listSessionAccountMoveTargets`, the inspector's list: same kind,
 * enabled, enterprise requirement, offers the model at that effort, login,
 * bench). `/account` is offered only when there is more than one; none until
 * that list has answered, and none for an account that cannot move.
 */
export function runtimeAccountChoices(
  account: Account | undefined,
  targets: LoadState<SessionAccountMoveTarget[]> | undefined,
): { id: string; name: string }[] {
  if (!account || !isSubscriptionAccountKind(account.provider)) return [];
  const judged = targets ? dataOf(targets) : undefined;
  if (!judged) return [];
  return [
    { id: account.id, name: account.name },
    ...judged
      .filter((target) => target.id !== account.id)
      .map(({ id, name }) => ({ id, name })),
  ];
}

/** What `/model`, `/effort` and `/account` resolve against. */
export function runtimeCommandContext(commands: {
  control: SessionRuntimeControl;
  accountChoices: readonly { id: string; name: string }[];
}): RuntimeCommandContext {
  const { control } = commands;
  const target = control.pending?.model ?? control.current.model;
  return {
    models: control.models,
    modelRefusal: control.modelRefusal,
    targetModel: target
      ? control.models.find(
          (model) =>
            model.provider === target.provider && model.id === target.id,
        )
      : undefined,
    accounts: commands.accountChoices,
  };
}
