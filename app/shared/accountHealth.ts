import { CLAUDE_SDK_PROVIDER } from "./protocol.ts";
import type {
  AccountLoginAlert,
  CredentialProfileSummary,
} from "./protocol.ts";

/** A profile directory can also hold unrelated pi provider keys. Those runs say nothing about its subscription login. */
export function isSubscriptionAccountModel(
  provider: CredentialProfileSummary["provider"],
  modelProvider: string | undefined,
): boolean {
  return (
    modelProvider ===
    (provider === "claude" ? CLAUDE_SDK_PROVIDER : "openai-codex")
  );
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
  return `/settings/${provider === "claude" ? "claude-sdk" : "openai"}`;
}
