/**
 * The inspector's Runtime section and the composer's runtime chip, built from
 * app state (`docs/session-runtime-switching.md`). Pure, so the rules a picker
 * applies (which models and accounts it offers, and why one is disabled) are
 * tested without the app.
 */
import {
  ACCOUNT_KINDS,
  accountKindForModelProvider,
  accountServesModel,
  harnessForModelProvider,
  isSubscriptionAccountKind,
  type CredentialProfileProvider,
  type CredentialProfileSummary,
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

interface Account {
  id: string;
  name: string;
  provider: CredentialProfileProvider;
}

/**
 * Whether running `model` moves a session on `harness` bound to `account` to
 * another engine: another harness, or another kind of account (pi's OpenAI ↔
 * OpenAI-compatible). The server judges the same (`crossesEngines`).
 */
export function crossesEngines(
  model: { provider: string },
  harness: Harness,
  account: Pick<Account, "id" | "provider"> | undefined,
): boolean {
  return (
    harnessForModelProvider(model.provider) !== harness ||
    (account !== undefined && !accountServesModel(account, model.provider))
  );
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
  /** The server's handoff estimate for this session's pending switch. */
  handoff: LoadState<number | null> | undefined;
  busy: boolean;
  actions: {
    listSessionAccountMoveTargets: (sessionId: string) => void;
    estimateSessionHandoff: (sessionId: string) => void;
    setPendingRuntime: (
      sessionId: string,
      change: SessionRuntimeChange,
    ) => void;
    clearPendingRuntime: (sessionId: string) => void;
  };
}): SessionRuntimeControl | undefined {
  const { sessionId, harness, account, actions } = input;
  if (!sessionId || !input.started) return undefined;
  // This engine's models first, then the ones a switch moves to.
  const models = [...input.models].sort(
    (a, b) =>
      Number(crossesEngines(a, harness, account)) -
      Number(crossesEngines(b, harness, account)),
  );
  const target = input.pending?.model ?? input.model;
  const cross =
    input.pending !== undefined &&
    crossesEngines(input.pending.model, harness, account);
  const targetKind = target
    ? accountKindForModelProvider(target.provider)
    : account?.provider;
  return {
    current: {
      model: input.model,
      thinkingLevel: input.thinkingLevel,
      accountName: account?.name,
    },
    pending: input.pending,
    models,
    // Only a subscription login ever moves, and Automatic picks among its
    // kind; any other account alone serves its models (the server refuses
    // the others too).
    accounts:
      targetKind && isSubscriptionAccountKind(targetKind)
        ? {
            targets: input.targets,
            onOpen: () => actions.listSessionAccountMoveTargets(sessionId),
            nameOf: (id) =>
              input.accounts.find((candidate) => candidate.id === id)?.name,
          }
        : undefined,
    ...(cross && target
      ? {
          engineSwitch: {
            kindLabel:
              ACCOUNT_KINDS[accountKindForModelProvider(target.provider)].label,
            // An endpoint model runs only on the account it belongs to.
            ...(targetKind && !isSubscriptionAccountKind(targetKind)
              ? {
                  fixedAccountName: input.accounts.find(
                    (candidate) => candidate.id === target.provider,
                  )?.name,
                }
              : {}),
            handoff: input.handoff,
            onEstimate: () => actions.estimateSessionHandoff(sessionId),
          },
        }
      : {}),
    busy: input.busy,
    onChange: (change) => actions.setPendingRuntime(sessionId, change),
    onReset: () => actions.clearPendingRuntime(sessionId),
  };
}

/**
 * The accounts `/account` may name, exactly as the SERVER judged them for the
 * model and effort the session's next turn starts on
 * (`listSessionAccountMoveTargets`, the inspector's list: the target model's
 * kind, enabled, enterprise requirement, offers the model at that effort,
 * login, bench): the bound account only when it serves that model and the
 * answer says it can run the turn itself, then the other accounts. `/account`
 * is offered only when there is more than one; none until that list has
 * answered, and none for a kind whose account cannot change.
 */
export function runtimeAccountChoices(
  account: Account | undefined,
  targetModel: { provider: string } | undefined,
  answer:
    | {
        targets: LoadState<SessionAccountMoveTarget[]>;
        boundEligible?: boolean;
      }
    | undefined,
): { id: string; name: string }[] {
  const kind = targetModel
    ? accountKindForModelProvider(targetModel.provider)
    : account?.provider;
  if (!kind || !isSubscriptionAccountKind(kind)) return [];
  const judged = answer ? dataOf(answer.targets) : undefined;
  if (!judged) return [];
  const bound =
    account !== undefined &&
    (!targetModel || accountServesModel(account, targetModel.provider)) &&
    answer?.boundEligible === true;
  return [
    ...(bound && account ? [{ id: account.id, name: account.name }] : []),
    ...judged
      .filter((target) => target.id !== account?.id)
      .map(({ id, name }) => ({ id, name })),
  ];
}

/**
 * When the handoff estimate must be asked for again: the session, its pending
 * target, the log's size and last change (each turn changes what is handed
 * over), and the accounts (Automatic's pick names one in the note).
 */
export function handoffEstimateRefreshKey(input: {
  sessionId: string | undefined;
  pending: SessionPendingRuntime | undefined;
  messageCount: number | undefined;
  updatedAt: number | undefined;
  profiles: readonly Pick<
    CredentialProfileSummary,
    "id" | "enabled" | "enterprise" | "health"
  >[];
}): string {
  return JSON.stringify([
    input.sessionId,
    input.pending,
    input.messageCount,
    input.updatedAt,
    input.profiles.map(({ id, enabled, enterprise, health }) => [
      id,
      enabled,
      enterprise,
      health,
    ]),
  ]);
}

/**
 * When `/account`'s server list must be asked for again: a key over everything
 * the server's judgement reads — the session and its bound account, the model
 * and effort its next turn starts on, the enterprise requirement, and every
 * account's kind, enabled, enterprise and whole health projection (login state
 * AND `benchRevision`: a new bench scope can leave the state as it was), and
 * each account's model listing: a listing refresh alone (the `models` push
 * reloading the projection) can add or drop the next turn's model on one
 * account while nothing else changes.
 */
export function accountTargetsRefreshKey(input: {
  sessionId: string | undefined;
  boundAccountId: string | undefined;
  model: unknown;
  thinkingLevel: string | undefined;
  requiresEnterprise: boolean;
  profiles: readonly Pick<
    CredentialProfileSummary,
    "id" | "provider" | "enabled" | "enterprise" | "health"
  >[];
  /** The projection's `modelsByProfile`: account id → models it offers. */
  modelListings: Readonly<Record<string, readonly ModelOption[]>>;
}): string {
  return JSON.stringify([
    input.sessionId,
    input.boundAccountId,
    input.model,
    input.thinkingLevel,
    input.requiresEnterprise,
    input.profiles.map(({ id, provider, enabled, enterprise, health }) => [
      id,
      provider,
      enabled,
      enterprise,
      health,
      input.modelListings[id] ?? null,
    ]),
  ]);
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
    targetModel: target
      ? control.models.find(
          (model) =>
            model.provider === target.provider && model.id === target.id,
        )
      : undefined,
    accounts: commands.accountChoices,
  };
}
