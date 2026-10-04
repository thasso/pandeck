/**
 * The usage port (`docs/agent-harnesses.md`): subscription usage per credential
 * profile, read by the engine that signs that kind of account in. Each kind
 * reports its own snapshot shape, so the port keeps one entry per kind rather
 * than flattening them.
 */
import type {
  ClaudeUsageSnapshot,
  OpenAiUsageSnapshot,
} from "@assistant/shared/usage";
import { fetchClaudeSdkUsage } from "../claudeSdk/usageQuery.ts";
import {
  fetchOpenAiUsageForProfile,
  redeemOpenAiResetCreditForProfile,
  type RedeemResetOptions,
} from "../piSdk/openaiUsageQuery.ts";

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
): ReturnType<typeof redeemOpenAiResetCreditForProfile> {
  return redeemOpenAiResetCreditForProfile(profileId, creditId, options);
}
