/**
 * The usage port (`docs/agent-harnesses.md`): subscription usage per credential
 * profile, read by the engine that signs that kind of account in. Each kind
 * reports its own snapshot shape, so the port keeps one entry per kind rather
 * than flattening them.
 */
import type { Harness } from "@assistant/shared";
import {
  DEFAULT_CLAUDE_PROFILE_ID,
  DEFAULT_OPENAI_PROFILE_ID,
} from "../credentialProfiles.ts";
import type {
  ClaudeUsageSnapshot,
  OpenAiResetRedeemResult,
  OpenAiUsageSnapshot,
} from "@assistant/shared/usage";
import { fetchClaudeSdkUsage } from "../claudeSdk/usageQuery.ts";
import {
  fetchOpenAiUsageForProfile,
  redeemOpenAiResetCreditForProfile,
  type RedeemResetOptions,
} from "../piSdk/openaiUsageQuery.ts";

/** Usage-only attribution mirrors the account used to reopen legacy sessions. */
export function usageProfileForSession(
  session: { harness: Harness; credentialProfileId?: string } | undefined,
): string | null {
  if (!session) return null;
  return (
    session.credentialProfileId ??
    (session.harness === "claude-sdk"
      ? DEFAULT_CLAUDE_PROFILE_ID
      : DEFAULT_OPENAI_PROFILE_ID)
  );
}

/** Plan usage of a Claude account. */
export function fetchClaudeAccountUsage(
  profileId: string,
  timeoutMs: number,
): Promise<ClaudeUsageSnapshot> {
  return fetchClaudeSdkUsage(timeoutMs, profileId);
}

/** Plan usage of an OpenAI account. */
export function fetchOpenAiAccountUsage(
  profileId: string,
): Promise<OpenAiUsageSnapshot> {
  return fetchOpenAiUsageForProfile(profileId);
}

/** Redeem one of an OpenAI account's reset credits. */
export function redeemOpenAiResetCredit(
  profileId: string,
  creditId: string,
  options?: RedeemResetOptions,
): Promise<OpenAiResetRedeemResult> {
  return redeemOpenAiResetCreditForProfile(profileId, creditId, options);
}
