import {
  ACCOUNT_KINDS,
  accountKindForModelProvider,
  accountPinForModel,
  accountServesModel,
  DEFAULT_HELPER_MODEL,
  HARNESSES,
  harnessForModelProvider,
  isSubscriptionAccountKind,
  type CredentialProfileProvider,
  type Harness,
  type ThinkingLevel,
} from "@assistant/shared";
import { credentialProfileById } from "./credentialProfiles.ts";
import { pickAccount } from "./accountRouter.ts";
import { sessionStore } from "./db/sessionStore.ts";

/** How an engine's `switchAccount` moves a session. */
export interface AccountSwitchOptions {
  /** The turn has not started, so a session with no native history may move. */
  allowWithoutHistory?: true;
  /** Commit `requires_enterprise = 1` with the new binding, atomically. */
  requireEnterprise?: true;
}

/**
 * Rechecked after each asynchronous move step, before changing the binding.
 * Only subscription logins ever switch: any other account alone serves its
 * models. `requireEnterprise` is a move that will make the session
 * enterprise-only with its commit, so its target must be enterprise already.
 */
export function assertSessionAccountSwitch(
  sessionId: string,
  previous: string,
  next: string,
  provider: CredentialProfileProvider,
  options: { requireEnterprise?: true } = {},
): void {
  const source = sessionStore.get(sessionId);
  if (!source || source.credentialProfileId !== previous)
    throw new Error(
      "The session's bound account is no longer available for this switch.",
    );
  const profile = credentialProfileById(next);
  if (
    next === previous ||
    !isSubscriptionAccountKind(provider) ||
    !profile?.enabled ||
    profile.provider !== provider
  )
    throw new Error("The replacement account is no longer available.");
  if (
    (source.requiresEnterprise || options.requireEnterprise) &&
    !profile.enterprise
  )
    throw new Error("This session requires an enterprise account.");
}

/**
 * The user's or an owning coordinator's one-way "Require enterprise account":
 * from now on only enterprise accounts may run the session, and its next turn
 * moves it to one first (`moveOffDisabledAccount`). A running turn keeps its
 * account. Only user sessions qualify, and not one bound to a non-enterprise
 * account that is no subscription login (it could never move). The caller owns
 * any further authority checks and list publication.
 * Answers whether the session already required it.
 */
export function requireSessionEnterprise(sessionId: string): boolean {
  const row = sessionStore.get(sessionId);
  if (!row) throw new Error("Session does not exist or was deleted.");
  if (row.scope !== "user")
    throw new Error("Only a user session can require an enterprise account.");
  if (row.requiresEnterprise) return true;
  // Only a subscription login ever moves; any other account alone serves its
  // models, so requiring enterprise of one that is not would refuse every turn.
  const bound = row.credentialProfileId
    ? credentialProfileById(row.credentialProfileId)
    : undefined;
  if (bound && !bound.enterprise && !isSubscriptionAccountKind(bound.provider))
    throw new Error(
      `${bound.name} is the only account that serves this session's model and is not an enterprise account, so the session cannot move to one.`,
    );
  sessionStore.requireEnterprise(sessionId);
  return false;
}

/**
 * Shared interactive creation policy. The model decides which accounts may
 * run it (`accountServesModel`). An explicit pin passes rule P, then must be
 * enabled and serve the model. An inherited pin (the parent session's account,
 * on a fork or draft) is kept, even disabled, only when that exact account
 * serves the new model; otherwise Automatic picks.
 */
export async function resolveSessionAccount(
  harness: Harness,
  selection: {
    credentialProfileId?: string | undefined;
    modelProvider?: string | undefined;
    modelId?: string | undefined;
    thinkingLevel?: ThinkingLevel | undefined;
    requiresEnterprise?: boolean | undefined;
  },
  options: { inheritedPin?: boolean } = {},
): Promise<string> {
  // The harness supplies only the default model when the selection names none.
  const defaultModel = HARNESSES[harness].defaultModel ?? DEFAULT_HELPER_MODEL;
  const model = {
    provider: selection.modelProvider ?? defaultModel.provider,
    modelId: selection.modelId ?? defaultModel.modelId,
  };
  const label =
    ACCOUNT_KINDS[accountKindForModelProvider(model.provider)].label;
  if (harnessForModelProvider(model.provider) !== harness)
    throw new Error(`Select an enabled ${label} credential profile.`);
  const stored = selection.credentialProfileId?.trim() || undefined;
  if (stored && options.inheritedPin) {
    const profile = credentialProfileById(stored);
    if (profile && accountServesModel(profile, model.provider)) {
      if (selection.requiresEnterprise && !profile.enterprise)
        throw new Error("This session requires an enterprise account.");
      return stored;
    }
  }
  const pin = options.inheritedPin
    ? undefined
    : accountPinForModel(model.provider, stored);
  if (pin) {
    const profile = credentialProfileById(pin);
    if (!profile)
      throw new Error("The bound credential profile no longer exists.");
    if (!accountServesModel(profile, model.provider) || !profile.enabled)
      throw new Error(`Select an enabled ${label} credential profile.`);
    if (selection.requiresEnterprise && !profile.enterprise)
      throw new Error("This session requires an enterprise account.");
    return pin;
  }
  const picked = await pickAccount({
    model,
    ...(selection.thinkingLevel !== undefined
      ? { thinkingLevel: selection.thinkingLevel }
      : {}),
    ...(selection.requiresEnterprise !== undefined
      ? { requiresEnterprise: selection.requiresEnterprise }
      : {}),
  });
  if (!picked.profileId)
    throw new Error(
      selection.requiresEnterprise
        ? `No enabled enterprise ${label} account is available.`
        : `No enabled ${label} account is available.`,
    );
  return picked.profileId;
}
