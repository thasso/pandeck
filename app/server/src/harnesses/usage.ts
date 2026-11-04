/**
 * The usage port (`docs/agent-harnesses.md`): subscription usage per credential
 * profile, read by the engine that signs that kind of account in. Each kind
 * reports its own snapshot shape, so the port keeps one entry per kind rather
 * than flattening them.
 *
 * Under the credential gateway Claude usage, and OpenAI usage, credits and
 * redemption, go through it on the account's server lease (`gatewayLink.ts`),
 * Claude's with no CLI child; a gateway that cannot grant one fails the read,
 * never falling back to the account's own token or the CLI.
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
import { fetchClaudeUsageViaGateway } from "../claudeSdk/usageViaGateway.ts";
import { serverGatewayAccess } from "../gatewayLink.ts";
import {
  fetchOpenAiUsageForProfile,
  fetchOpenAiUsageViaGateway,
  redeemOpenAiResetCreditForProfile,
  redeemOpenAiResetCreditViaGateway,
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
export async function fetchClaudeAccountUsage(
  profileId: string,
  timeoutMs: number,
): Promise<ClaudeUsageSnapshot> {
  const gateway = await serverGatewayAccess(profileId);
  return gateway
    ? fetchClaudeUsageViaGateway(profileId, gateway, timeoutMs)
    : fetchClaudeSdkUsage(timeoutMs, profileId);
}

/** Plan usage of an OpenAI account. */
export async function fetchOpenAiAccountUsage(
  profileId: string,
): Promise<OpenAiUsageSnapshot> {
  const gateway = await serverGatewayAccess(profileId);
  return gateway
    ? fetchOpenAiUsageViaGateway(profileId, gateway)
    : fetchOpenAiUsageForProfile(profileId);
}

/** Redeem one of an OpenAI account's reset credits. */
export async function redeemOpenAiResetCredit(
  profileId: string,
  creditId: string,
  options?: RedeemResetOptions,
): Promise<OpenAiResetRedeemResult> {
  const gateway = await serverGatewayAccess(profileId);
  return gateway
    ? redeemOpenAiResetCreditViaGateway(profileId, gateway, creditId, options)
    : redeemOpenAiResetCreditForProfile(profileId, creditId, options);
}
