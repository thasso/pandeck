import {
  accountProviderForModelProvider,
  CLAUDE_SDK_PROVIDER,
  DEFAULT_HELPER_MODEL,
  type CredentialProfileProvider,
  type ThinkingLevel,
} from "@assistant/shared";
import { credentialProfileById } from "./credentialProfiles.ts";
import { pickAccount } from "./accountRouter.ts";
import { sessionStore } from "./db/sessionStore.ts";

/** Rechecked after each asynchronous move step, before changing the binding. */
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
  if (next === previous || !profile?.enabled || profile.provider !== provider)
    throw new Error("The replacement account is no longer available.");
  if (source.requiresEnterprise && !profile.enterprise)
    throw new Error("This session requires an enterprise account.");
}

/** Shared interactive creation policy; inherited pins alone may be disabled. */
export async function resolveSessionAccount(
  provider: CredentialProfileProvider,
  selection: {
    credentialProfileId?: string | undefined;
    modelProvider?: string | undefined;
    modelId?: string | undefined;
    thinkingLevel?: ThinkingLevel | undefined;
    requiresEnterprise?: boolean | undefined;
  },
  options: { allowDisabledPin?: boolean } = {},
): Promise<string> {
  const label = provider === "claude" ? "Claude" : "OpenAI";
  const model = {
    provider:
      selection.modelProvider ??
      (provider === "claude"
        ? CLAUDE_SDK_PROVIDER
        : DEFAULT_HELPER_MODEL.provider),
    modelId:
      selection.modelId ??
      (provider === "claude" ? "sonnet" : DEFAULT_HELPER_MODEL.modelId),
  };
  if (accountProviderForModelProvider(model.provider) !== provider)
    throw new Error(`Select an enabled ${label} credential profile.`);
  const pin = selection.credentialProfileId?.trim();
  if (pin) {
    const profile = credentialProfileById(pin);
    if (!profile)
      throw new Error("The bound credential profile no longer exists.");
    if (
      profile.provider !== provider ||
      (!profile.enabled && !options.allowDisabledPin)
    )
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
