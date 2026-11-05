/**
 * Each OpenAI-compatible account's provider configuration as leased pi
 * engines follow it ({@link CompatProviderFeed}), read from the account's
 * endpoint as the direct path reads it (`openAiCompatibleAccounts.ts`). It
 * never carries the key: only the gateway holds that, pushed by
 * `gatewayLink.ts`, and an engine spends its lease at `/compat` instead.
 */
import {
  credentialProfileById,
  subscribeCredentialProfileChanges,
} from "../credentialProfiles.ts";
import {
  openAiCompatibleProviderConfig,
  readOpenAiCompatibleEndpoint,
} from "../openAiCompatibleAccounts.ts";
import type { CompatProviderFeed } from "./gatewayPiModelPort.ts";

export const compatProviderFeed: CompatProviderFeed = {
  current(profileId) {
    const profile = credentialProfileById(profileId);
    if (profile?.provider !== "openai-compatible") return undefined;
    let config;
    try {
      config = openAiCompatibleProviderConfig(
        readOpenAiCompatibleEndpoint(profileId),
        profile.name,
      );
    } catch {
      return undefined;
    }
    if (!config) return undefined;
    // Field by field, so the key can never come along.
    const { name, baseUrl, api, compat, models } = config;
    return { name, baseUrl, api, compat, models };
  },
  subscribe(profileId, listener) {
    return subscribeCredentialProfileChanges((id) => {
      if (id === profileId) listener();
    });
  },
};
