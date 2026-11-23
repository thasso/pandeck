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
import { sessionClaudePin } from "./harnesses/curatedModels.ts";
import { accountLacksModel } from "./harnesses/models.ts";
import {
  assertAccountCanRunModel,
  noAccountCanRunModelError,
} from "./settingsModelSlots.ts";

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
 * moves it to one first (`moveOffDisabledAccount`). Only an idle user session
 * qualifies, and not one bound to a non-enterprise account that is no
 * subscription login (it could never move). A running session is refused, so
 * every message sent into a running turn was sent before the requirement and
 * every later one passes the admission check. `runtime` is the caller's view of
 * the session runtime. The caller owns any further authority checks and list
 * publication.
 * Answers whether the session already required it.
 */
export function requireSessionEnterprise(
  sessionId: string,
  runtime: { isRunning(sessionId: string): boolean },
): boolean {
  const row = sessionStore.get(sessionId);
  if (!row) throw new Error("Session does not exist or was deleted.");
  if (row.scope !== "user")
    throw new Error("Only a user session can require an enterprise account.");
  if (runtime.isRunning(sessionId))
    throw new Error(
      `Session ${sessionId} is running; require an enterprise account once its turn ends.`,
    );
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
 * enabled, serve the model and not be known to lack it (its model listing).
 * An inherited pin (the parent session's account, on a fork or draft) is kept,
 * even disabled, only when that exact account serves the new model and is not
 * known to lack it; otherwise Automatic picks.
 */
export async function resolveSessionAccount(
  harness: Harness,
  selection: {
    credentialProfileId?: string | undefined;
    modelProvider?: string | undefined;
    modelId?: string | undefined;
    thinkingLevel?: ThinkingLevel | undefined;
    requiresEnterprise?: boolean | undefined;
    /**
     * The concrete version a new Claude session pins (its agent
     * definition's): only an account that runs exactly it may take it.
     */
    pinnedModelId?: string | undefined;
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
  // A new session: its pin, never a stored one (`claudeSdk/modelResolution.ts`).
  const modelPin =
    selection.pinnedModelId !== undefined
      ? { pinnedModelId: selection.pinnedModelId }
      : {};
  const stored = selection.credentialProfileId?.trim() || undefined;
  if (stored && options.inheritedPin) {
    const profile = credentialProfileById(stored);
    if (
      profile &&
      accountServesModel(profile, model.provider) &&
      !(await accountLacksModel(
        profile.id,
        model.provider,
        model.modelId,
        modelPin,
      ))
    ) {
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
    await assertAccountCanRunModel(
      pin,
      model.provider,
      model.modelId,
      modelPin,
    );
    return pin;
  }
  const picked = await pickAccount({
    model,
    ...modelPin,
    ...(selection.thinkingLevel !== undefined
      ? { thinkingLevel: selection.thinkingLevel }
      : {}),
    ...(selection.requiresEnterprise !== undefined
      ? { requiresEnterprise: selection.requiresEnterprise }
      : {}),
  });
  if (!picked.profileId && picked.degraded === "model-unavailable")
    throw await noAccountCanRunModelError(model.provider, model.modelId);
  if (!picked.profileId)
    throw new Error(
      selection.requiresEnterprise
        ? `No enabled enterprise ${label} account is available.`
        : `No enabled ${label} account is available.`,
    );
  return picked.profileId;
}

/**
 * Refuse an existing session's run when its bound account is not entitled to
 * its current model ("<account> can't run <model>."), judged with the
 * session's pin (`sessionClaudePin`). The callers pass the live binding and
 * selection: turn admission (`session/runtimePrompt.ts`) and `/compact`
 * (`hostSlashCommands.ts`), both before any run starts, so a refusal is a
 * local policy decision that never reaches the provider or account health.
 */
export async function assertSessionModelEntitled(input: {
  sessionId: string;
  credentialProfileId: string | undefined;
  model: { provider: string; id: string } | undefined;
}): Promise<void> {
  const { credentialProfileId, model } = input;
  if (!credentialProfileId || !model) return;
  await assertAccountCanRunModel(
    credentialProfileId,
    model.provider,
    model.id,
    sessionClaudePin(input.sessionId, model.provider, model.id),
  );
}
