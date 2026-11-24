/**
 * Which accounts a session may move to, and the rules a move must pass.
 *
 * A move the user (session inspector) or its owning coordinator
 * (`session_control` `move_account`) picks is a PENDING account
 * (`sessionPendingRuntime.ts`); the move itself happens when the next turn is
 * admitted, through the engines' existing `switchAccount` (history copy on
 * Claude, staged reopen on pi, binding CAS). One predicate decides which
 * accounts qualify: the picker's list, the tool's error text and that apply
 * step all use it. It never sets or clears the enterprise requirement
 * (`docs/account-routing.md`).
 */
import {
  accountServesModel,
  isSubscriptionAccountKind,
  type SessionAccountMoveTarget,
  type ThinkingLevel,
} from "@assistant/shared";
import { activeEngine } from "./harnesses/activeEngine.ts";
import { isSubscriptionAccountModel } from "@assistant/shared/accountHealth";
import { gatherAccountCandidate } from "./accountRouter.ts";
import { readAccountBench, readAccountHealth } from "./accountHealth.ts";
import {
  credentialProfileById,
  credentialProfileHasCredential,
  listCredentialProfiles,
  type CredentialProfile,
} from "./credentialProfiles.ts";
import { sessionStore, type SessionMeta } from "./db/sessionStore.ts";
import { formatLocalDateTime } from "./googleTime.ts";
import { storedSessionModelOption } from "./harnesses/models.ts";
import type { RuntimePromptDriver } from "./session/runtimePrompt.ts";

export interface MoveSelection {
  model?: { provider: string; id: string } | undefined;
  thinkingLevel?: ThinkingLevel | undefined;
}

/**
 * The resident-session lookup the list needs; a narrow seam so tests
 * substitute a fake hub instead of module-mocking singletons.
 */
interface AccountMoveHost {
  /** The resident driver, without opening a harness (the list's read). */
  resident(sessionId: string): Promise<RuntimePromptDriver | undefined>;
}

let hostOverride: AccountMoveHost | undefined;

/** Test-only seam: substitute the runtime and hub. Undefined restores them. */
export function setAccountMoveHostForTests(
  host: AccountMoveHost | undefined,
): void {
  hostOverride = host;
}

function asDriver(candidate: unknown): RuntimePromptDriver | undefined {
  return candidate &&
    typeof candidate === "object" &&
    "createRuntimeAdapter" in candidate &&
    "canSteer" in candidate
    ? (candidate as RuntimePromptDriver)
    : undefined;
}

const defaultHost: AccountMoveHost = {
  async resident(sessionId) {
    const { hub } = await import("./hub.ts");
    return asDriver(hub.getLiveById(sessionId));
  },
};

function host(): AccountMoveHost {
  return hostOverride ?? defaultHost;
}

/** The session and the subscription login it may move off. Throws otherwise. */
function moveSource(sessionId: string): {
  row: SessionMeta;
  source: CredentialProfile;
} {
  const row = sessionStore.get(sessionId);
  if (!row) throw new Error("Session does not exist or was deleted.");
  if (row.scope !== "user")
    throw new Error("Only a user session can move to another account.");
  const source = row.credentialProfileId
    ? credentialProfileById(row.credentialProfileId)
    : undefined;
  if (!source) throw new Error("This session has no account to move from.");
  // Any account that is no subscription login alone serves its models.
  if (!isSubscriptionAccountKind(source.provider))
    throw new Error(
      `${source.name} is the only account that serves this session's model, so the session cannot move.`,
    );
  return { row, source };
}

/** The synchronous target rules: kind, current account, enabled, enterprise. */
function targetRefusal(
  row: SessionMeta,
  source: CredentialProfile,
  target: CredentialProfile | undefined,
): string | undefined {
  if (!target) return "The chosen account no longer exists.";
  if (target.id === source.id)
    return `This session already runs on ${source.name}.`;
  return accountRulesRefusal(row, source, target);
}

/**
 * Kind, enabled and enterprise, for any account the session may run on next,
 * its current one included.
 */
export function accountRulesRefusal(
  row: Pick<SessionMeta, "requiresEnterprise">,
  source: CredentialProfile,
  target: CredentialProfile,
): string | undefined {
  if (target.provider !== source.provider)
    return `${target.name} is not the same kind of account as ${source.name}.`;
  if (!target.enabled) return `${target.name} is disabled.`;
  if (row.requiresEnterprise && !target.enterprise)
    return `This session requires an enterprise account, and ${target.name} is not one.`;
  return undefined;
}

/** A session moves only with a model its subscription login runs. */
function selectionRefusal(
  source: CredentialProfile,
  selection: MoveSelection | undefined,
): string | undefined {
  if (!selection?.model) return "This session has no model to move with.";
  if (!isSubscriptionAccountModel(source.provider, selection.model.provider))
    return `This session's model is not one ${source.name}'s subscription runs, so the session cannot move.`;
  return undefined;
}

function benchText(name: string, modelId: string, until: number): string {
  return `${name} has reached its ${modelId} limit until ${formatLocalDateTime(new Date(until).toISOString())}.`;
}

/**
 * The model, health and bench rules, judged on the same per-account facts as
 * Automatic (`gatherAccountCandidate`): the account serves and offers the
 * session's model at its thinking level, needs no login, and has no bench on
 * that model.
 */
export async function modelRefusal(
  target: CredentialProfile,
  selection: MoveSelection & { model: { provider: string; id: string } },
): Promise<string | undefined> {
  const model = selection.model;
  if (!accountServesModel(target, model.provider))
    return `${target.name} cannot run this session's model.`;
  const candidate = await moveCandidate(target, selection);
  if (!candidate) return "The chosen account no longer exists.";
  if (!candidate.offersModel)
    return `${target.name} does not offer ${model.id} at this session's effort.`;
  if (candidate.profile.health.state === "needs-login")
    return `${target.name} needs login.`;
  if (candidate.limited)
    return benchText(target.name, model.id, candidate.limited.until);
  return undefined;
}

/** The account as Automatic judges it for this model and effort. */
async function moveCandidate(
  target: CredentialProfile,
  selection: MoveSelection & { model: { provider: string; id: string } },
) {
  const profile = listCredentialProfiles().find(({ id }) => id === target.id);
  if (!profile) return undefined;
  return gatherAccountCandidate(profile, {
    model: { provider: selection.model.provider, modelId: selection.model.id },
    ...(selection.thinkingLevel
      ? { thinkingLevel: selection.thinkingLevel }
      : {}),
  });
}

/**
 * Whether the account offers the model at that effort at all: the static half
 * of `modelRefusal`, without health or benches, which change by themselves and
 * are judged again when the selection applies.
 */
export async function accountOffersSelection(
  target: CredentialProfile,
  selection: MoveSelection & { model: { provider: string; id: string } },
): Promise<boolean> {
  return (await moveCandidate(target, selection))?.offersModel === true;
}

/** Health and bench again, synchronously, at every engine step. */
export function assertStillEligible(
  target: CredentialProfile,
  modelId: string,
): void {
  if (
    readAccountHealth(target.id, credentialProfileHasCredential(target.id))
      .state === "needs-login"
  )
    throw new Error(`${target.name} needs login.`);
  const bench = readAccountBench(target.id, modelId);
  if (bench) throw new Error(benchText(target.name, modelId, bench.until));
}

/** Why `target` cannot take the session right now; undefined when it can. */
async function accountMoveRefusal(
  row: SessionMeta,
  source: CredentialProfile,
  target: CredentialProfile | undefined,
  selection: MoveSelection | undefined,
): Promise<string | undefined> {
  const refusal =
    targetRefusal(row, source, target) ?? selectionRefusal(source, selection);
  if (refusal || !target || !selection?.model) return refusal;
  return modelRefusal(target, { ...selection, model: selection.model });
}

/**
 * The selection a session runs with now: its resident harness's, else its
 * stored model, normalized as a view reads it. Never opens a harness.
 */
export async function sessionSelection(
  row: SessionMeta,
): Promise<MoveSelection | undefined> {
  const driver = await host().resident(row.id);
  if (driver?.modelSelection) return driver.modelSelection();
  const model = storedSessionModelOption(
    activeEngine(row).harness,
    row.provider,
    row.model,
  );
  return model
    ? {
        model: { provider: model.provider, id: model.id },
        ...(row.thinkingLevel
          ? { thinkingLevel: row.thinkingLevel as ThinkingLevel }
          : {}),
      }
    : undefined;
}

/**
 * The rules for the session's OWN account running its next turn: enabled and
 * the enterprise requirement (kind is its own). `sessionPendingRuntime.ts`
 * judges a selection naming the bound account by these too.
 */
export function boundAccountRulesRefusal(
  row: Pick<SessionMeta, "requiresEnterprise">,
  account: CredentialProfile,
): string | undefined {
  if (!account.enabled) return `${account.name} is disabled.`;
  if (row.requiresEnterprise && !account.enterprise)
    return `This session requires an enterprise account, and ${account.name} is not one.`;
  return undefined;
}

/**
 * The accounts the session could move to right now, for the inspector's
 * picker and the coordinator tool's error text, judged against the model and
 * effort its next turn starts on (the pending selection's, else the current
 * one), and whether its bound account can run that turn itself by the same
 * rules a selection naming it is applied with. Throws when the session itself
 * cannot move.
 */
export async function accountMoveChoices(sessionId: string): Promise<{
  accounts: SessionAccountMoveTarget[];
  boundEligible: boolean;
}> {
  const { row, source, selection } = await nextTurnSelection(sessionId);
  const profiles = listCredentialProfiles();
  const [boundRefusal, ...refusals] = await Promise.all([
    boundAccountRefusal(row, source, selection),
    ...profiles.map((target) =>
      accountMoveRefusal(row, source, target, selection),
    ),
  ]);
  return {
    accounts: profiles
      .filter((_, index) => !refusals[index])
      .map((target) => ({
        id: target.id,
        name: target.name,
        enterprise: target.enterprise === true,
      })),
    boundEligible: !boundRefusal,
  };
}

/** `accountMoveChoices`' accounts alone. */
export async function accountMoveTargets(
  sessionId: string,
): Promise<SessionAccountMoveTarget[]> {
  return (await accountMoveChoices(sessionId)).accounts;
}

/** Why the bound account cannot run the next turn's selection itself. */
async function boundAccountRefusal(
  row: SessionMeta,
  source: CredentialProfile,
  selection: MoveSelection | undefined,
): Promise<string | undefined> {
  const rules = boundAccountRulesRefusal(row, source);
  if (rules || !selection?.model) return rules;
  return modelRefusal(source, { ...selection, model: selection.model });
}

/**
 * Why one account is not among `accountMoveTargets` right now, or undefined
 * when it is: the coordinator tool's specific refusal.
 */
export async function accountMoveTargetRefusal(
  sessionId: string,
  targetId: string,
): Promise<string | undefined> {
  const { row, source, selection } = await nextTurnSelection(sessionId);
  return accountMoveRefusal(
    row,
    source,
    credentialProfileById(targetId),
    selection,
  );
}

/** The model and effort the session's next turn starts on, and its account. */
async function nextTurnSelection(sessionId: string): Promise<{
  row: SessionMeta;
  source: CredentialProfile;
  selection: MoveSelection | undefined;
}> {
  const { row, source } = moveSource(sessionId);
  const selection: MoveSelection | undefined = row.pendingRuntime
    ? {
        model: row.pendingRuntime.model,
        thinkingLevel: row.pendingRuntime.thinkingLevel,
      }
    : await sessionSelection(row);
  const refusal = selectionRefusal(source, selection);
  if (refusal) throw new Error(refusal);
  return { row, source, selection };
}
