/**
 * Browser fetcher for the Usage page's provider account snapshots.
 *
 * Reads are served from the server-side cache (`docs/usage.md`); `refresh`
 * forces a live provider fetch and writes through, which is what the page's
 * refresh button does.
 */
import type {
  ClaudeUsageSnapshot,
  OpenAiResetRedeemResult,
  OpenAiUsageSnapshot,
} from "@assistant/shared/usage";
import { authHeaders, serverHttpOrigin } from "./serverOrigin.ts";

export async function fetchClaudeUsage(
  profileId?: string,
  options: { refresh?: boolean } = {},
): Promise<ClaudeUsageSnapshot> {
  const url = new URL(`${serverHttpOrigin()}/api/usage/claude`);
  if (profileId) url.searchParams.set("profileId", profileId);
  if (options.refresh) url.searchParams.set("refresh", "1");
  const res = await fetch(url, { headers: { ...authHeaders() } });
  const body = (await res.json().catch(() => null)) as
    (ClaudeUsageSnapshot & { error?: string }) | null;
  if (!res.ok || !body)
    throw new Error(body?.error || `Request failed (${res.status})`);
  return body;
}

export async function fetchOpenAiUsage(
  profileId?: string,
  options: { refresh?: boolean } = {},
): Promise<OpenAiUsageSnapshot> {
  const url = new URL(`${serverHttpOrigin()}/api/usage/openai`);
  if (profileId) url.searchParams.set("profileId", profileId);
  if (options.refresh) url.searchParams.set("refresh", "1");
  const res = await fetch(url, { headers: { ...authHeaders() } });
  const body = (await res.json().catch(() => null)) as
    (OpenAiUsageSnapshot & { error?: string }) | null;
  if (!res.ok || !body)
    throw new Error(body?.error || `Request failed (${res.status})`);
  return body;
}

/**
 * Redeems one banked OpenAI reset credit. IRREVERSIBLE — call only behind an
 * explicit confirmation. The server guards against redeeming when no reset is
 * applicable (409) unless `force` carries the user's "redeem anyway".
 */
export async function redeemOpenAiResetCredit(
  creditId: string,
  profileId?: string,
  options: { force?: boolean } = {},
): Promise<OpenAiResetRedeemResult> {
  const res = await fetch(
    `${serverHttpOrigin()}/api/usage/openai/redeem-reset`,
    {
      method: "POST",
      headers: { ...authHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({
        creditId,
        ...(profileId ? { profileId } : {}),
        ...(options.force ? { force: true } : {}),
      }),
    },
  );
  const body = (await res.json().catch(() => null)) as
    (OpenAiResetRedeemResult & { error?: string }) | null;
  if (!res.ok || !body) {
    const err = new Error(
      body?.error || `Request failed (${res.status})`,
    ) as RedeemRefusedError;
    // 409 is the guard, not a failure: the caller may re-confirm with `force`.
    if (res.status === 409) err.notApplicable = true;
    throw err;
  }
  return body;
}

/** A redeem error carrying the server's guarded refusal (HTTP 409). */
export type RedeemRefusedError = Error & { notApplicable?: boolean };
