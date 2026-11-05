import { ACCOUNT_KINDS } from "./accountKinds.ts";
import type {
  AccountLoginAlert,
  CredentialProfileSummary,
} from "./protocol.ts";

/**
 * A profile directory can also hold unrelated pi provider keys. Those runs say
 * nothing about its subscription login, and an account that is no
 * subscription login (an OpenAI-compatible endpoint) has none to speak for.
 */
export function isSubscriptionAccountModel(
  provider: CredentialProfileSummary["provider"],
  modelProvider: string | undefined,
): boolean {
  const kind = ACCOUNT_KINDS[provider];
  return kind.subscription && modelProvider === kind.subscriptionModelProvider;
}

/** Canonical words for a provider's named cap or model id. */
export function accountLimitModel(
  model: string | null | undefined,
): string | undefined {
  if (!model) return undefined;
  const words = model.toLowerCase().match(/[a-z0-9]+/g) ?? [];
  const key = words
    .filter(
      (word) => !["claude", "codex", "openai", "anthropic"].includes(word),
    )
    .join("-");
  return key && /[a-z]/.test(key) && key.length <= 120 ? key : undefined;
}

/** Named-cap words must all occur in the executing model id; no family inventory. */
export function accountLimitMatches(
  cap: string,
  model: string | undefined,
): boolean {
  const key = accountLimitModel(cap);
  const words = new Set(accountLimitModel(model)?.split("-") ?? []);
  return !!key && key.split("-").every((word) => words.has(word));
}

/** Secret-free, stable projection for the app-wide login alert. */
export function accountLoginAlerts(
  profiles: CredentialProfileSummary[],
): AccountLoginAlert[] {
  return profiles
    .filter(
      (profile) => profile.enabled && profile.health.state === "needs-login",
    )
    .map(({ id, name, provider }) => ({ profileId: id, name, provider }))
    .sort((a, b) => a.profileId.localeCompare(b.profileId));
}

export function accountSettingsPath(
  provider: AccountLoginAlert["provider"],
): string {
  return `/settings/${ACCOUNT_KINDS[provider].settingsSection}`;
}
