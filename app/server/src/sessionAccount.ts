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

/**
 * Rechecked after each asynchronous move step, before changing the binding.
 * Only subscription logins ever switch: any other account alone serves its
 * models.
 */
export function assertSessionAccountSwitch(
  sessionId: string,
  previous: string,
  next: string,
  provider: CredentialProfileProvider,
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
  if (source.requiresEnterprise && !profile.enterprise)
    throw new Error("This session requires an enterprise account.");
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
