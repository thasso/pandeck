import type {
  AccountModelOption,
  CredentialProfileProvider,
  CredentialProfileSlotUsage,
  CredentialProfileStatus,
  CredentialProfileSummary,
  ModelOption,
} from "@assistant/shared";
import { accountProviderForModelProvider } from "@assistant/shared";
import { authHeaders, serverHttpOrigin } from "./serverOrigin.ts";

/**
 * Flatten `{ account → models }` into the account/model combinations the
 * settings pickers offer. Only enabled accounts are offered; a disabled account
 * appears ONLY when a slot still pins it, so the current value stays visible
 * (and re-selectable) instead of silently reading as another account's model.
 */
export function accountModelOptions(
  profiles: CredentialProfileSummary[],
  modelsByProfile: Record<string, ModelOption[]>,
  pinnedProfileId?: string,
): AccountModelOption[] {
  return orderCredentialProfilesByProvider(profiles)
    .filter((profile) => profile.enabled || profile.id === pinnedProfileId)
    .flatMap((profile) =>
      (modelsByProfile[profile.id] ?? []).map((model) => ({
        ...model,
        credentialProfileId: profile.id,
        accountName: profile.name,
        ...(profile.enabled ? {} : { accountDisabled: true }),
      })),
    );
}

/**
 * Why a pinned account is not currently the one that would run: it was deleted,
 * or it is disabled. Mirrors the server's `resolveSlotAccount` degradation —
 * such a slot silently falls back to the automatic account rather than failing.
 */
export function accountPinWarning(
  profiles: CredentialProfileSummary[],
  slot: { provider: string; credentialProfileId?: string },
): string | undefined {
  const pinned = slot.credentialProfileId;
  if (!pinned) return undefined;
  const profile = profiles.find((item) => item.id === pinned);
  const wanted = accountProviderForModelProvider(slot.provider);
  const fallback = profiles.find(
    (item) => item.provider === wanted && item.enabled,
  );
  const runsOn = fallback ? `“${fallback.name}”` : "the automatic account";
  if (!profile)
    return `The pinned account no longer exists — this runs on ${runsOn}.`;
  if (!profile.enabled)
    return `“${profile.name}” is disabled — this runs on ${runsOn}.`;
  return undefined;
}

/**
 * What actually happens when this account is disabled, in the order it matters:
 * what MOVES (pinned settings slots, and unpinned work if this is the automatic
 * account) and what KEEPS RUNNING on it (bound sessions, including their forks,
 * `/clear` and drafts). Empty when disabling changes nothing.
 */
export function disableAccountImpact(
  profile: CredentialProfileSummary,
): string[] {
  const usage = profile.usage;
  if (!usage) return [];
  const lines: string[] = [];
  const target = usage.automaticFallback
    ? `“${usage.automaticFallback.name}”`
    : "the protected default account";
  if (usage.pinnedSlots.length > 0) {
    const one = usage.pinnedSlots.length === 1;
    lines.push(
      `${usage.pinnedSlots.length} settings ${one ? "slot" : "slots"} pinned to it ${one ? "falls" : "fall"} back to the automatic account: ${usage.pinnedSlots.map((slot) => slot.label).join(", ")}.`,
    );
  }
  if (usage.automaticForProvider) {
    lines.push(
      `It is the automatic account for new and unpinned work — that moves to ${target}.`,
    );
  }
  if (usage.boundSessionCount > 0) {
    lines.push(
      `${usage.boundSessionCount} existing ${usage.boundSessionCount === 1 ? "session keeps" : "sessions keep"} running on it (including forks, /clear and drafts of those sessions).`,
    );
  }
  return lines;
}

/** Group account surfaces by provider while preserving registry order within each provider. */
export function orderCredentialProfilesByProvider(
  profiles: CredentialProfileSummary[],
): CredentialProfileSummary[] {
  const providerRank: Record<CredentialProfileSummary["provider"], number> = {
    claude: 0,
    "openai-codex": 1,
  };
  return [...profiles].sort(
    (a, b) => providerRank[a.provider] - providerRank[b.provider],
  );
}

async function body<T>(res: Response): Promise<T> {
  const value = (await res.json().catch(() => null)) as
    (T & { error?: string }) | null;
  if (!res.ok || !value)
    throw new Error(value?.error ?? `Request failed (${res.status})`);
  return value;
}

export async function fetchCredentialProfiles(options?: {
  includeUsage?: boolean;
}): Promise<CredentialProfileSummary[]> {
  const query = options?.includeUsage ? "?includeUsage=1" : "";
  const result = await body<{ profiles: CredentialProfileSummary[] }>(
    await fetch(`${serverHttpOrigin()}/api/credential-profiles${query}`, {
      headers: authHeaders(),
    }),
  );
  return result.profiles;
}

export interface CredentialProfileProjection {
  profiles: CredentialProfileSummary[];
  modelsByProfile: Record<string, ModelOption[]>;
}

const credentialProfileProjectionRequests = new Map<
  number,
  Promise<CredentialProfileProjection>
>();

export function fetchCredentialProfilesWithModels(
  generation = 0,
  _signal?: AbortSignal,
): Promise<CredentialProfileProjection> {
  // React Strict Mode deliberately remounts effects in development. Dedupe one
  // logical generation across that cleanup/restart, but NOT across an explicit
  // invalidation: a credentialProfilesChanged event during the boot request
  // must start a newer read rather than adopt the pre-mutation answer.
  let request = credentialProfileProjectionRequests.get(generation);
  if (request) return request;
  request = fetch(
    `${serverHttpOrigin()}/api/credential-profiles?includeModels=1`,
    { headers: authHeaders() },
  )
    .then((response) => body<CredentialProfileProjection>(response))
    .finally(() => {
      credentialProfileProjectionRequests.delete(generation);
    });
  credentialProfileProjectionRequests.set(generation, request);
  return request;
}

export async function createCredentialProfile(
  name: string | undefined,
  provider: CredentialProfileProvider,
): Promise<CredentialProfileSummary> {
  const result = await body<{ profile: CredentialProfileSummary }>(
    await fetch(`${serverHttpOrigin()}/api/credential-profiles`, {
      method: "POST",
      headers: { ...authHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({
        ...(name === undefined ? {} : { name }),
        provider,
      }),
    }),
  );
  return result.profile;
}

async function patchCredentialProfile(
  id: string,
  patch: { name?: string; enabled?: boolean },
): Promise<CredentialProfileSummary> {
  const res = await fetch(
    `${serverHttpOrigin()}/api/credential-profiles/${encodeURIComponent(id)}`,
    {
      method: "PATCH",
      headers: { ...authHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    },
  );
  const body = (await res.json().catch(() => null)) as {
    profile?: CredentialProfileSummary;
    error?: string;
  } | null;
  if (!res.ok || !body?.profile)
    throw new Error(body?.error || `Request failed (${res.status})`);
  return body.profile;
}

export function renameCredentialProfile(
  id: string,
  name: string,
): Promise<CredentialProfileSummary> {
  return patchCredentialProfile(id, { name });
}

export function setCredentialProfileEnabled(
  id: string,
  enabled: boolean,
): Promise<CredentialProfileSummary> {
  return patchCredentialProfile(id, { enabled });
}

/** Deletes the account and reports the settings slots whose pin was dropped with it. */
export async function deleteCredentialProfile(
  id: string,
): Promise<CredentialProfileSlotUsage[]> {
  const res = await fetch(
    `${serverHttpOrigin()}/api/credential-profiles/${encodeURIComponent(id)}`,
    { method: "DELETE", headers: authHeaders() },
  );
  const payload = (await res.json().catch(() => null)) as {
    clearedSlots?: CredentialProfileSlotUsage[];
    error?: string;
  } | null;
  if (!res.ok)
    throw new Error(payload?.error || `Request failed (${res.status})`);
  return payload?.clearedSlots ?? [];
}

export async function startOpenAiProfileLogin(id: string): Promise<void> {
  await body<{ ok: true }>(
    await fetch(
      `${serverHttpOrigin()}/api/credential-profiles/${encodeURIComponent(id)}/login`,
      { method: "POST", headers: authHeaders() },
    ),
  );
}

export function openAiProfileConnectionAction(
  status: CredentialProfileStatus,
): { label: string; disabled: boolean } {
  if (status === "connecting") return { label: "Connecting…", disabled: true };
  return {
    label: status === "ready" ? "Reconnect" : "Connect",
    disabled: false,
  };
}
