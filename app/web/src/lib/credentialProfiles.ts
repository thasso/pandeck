import type {
  AccountModelOption,
  AccountPickPreviewRequest,
  AccountPickPreviewResult,
  CredentialProfileProvider,
  CredentialProfileSlotUsage,
  CredentialProfileStatus,
  CredentialProfileSummary,
  ModelOption,
  ThinkingLevel,
} from "@assistant/shared";
import {
  supportedThinkingLevelsForModel,
  accountProviderForModelProvider,
  THINKING_LEVELS,
} from "@assistant/shared";
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
 * A model offered with no account: the account router picks one per run, among
 * the enabled accounts of the model's provider that offer it. A settings slot
 * picked from these saves no `credentialProfileId`.
 */
export interface AutomaticModelOption extends ModelOption {
  automatic: true;
}

/** What a settings slot's model picker offers: Automatic, or one account's model. */
export type SlotModelOption = AutomaticModelOption | AccountModelOption;

export function isAutomaticModelOption(
  model: ModelOption,
): model is AutomaticModelOption {
  return "automatic" in model && model.automatic === true;
}

/**
 * The models Automatic can run: every model at least one eligible account
 * offers, once each, in account order. This is a set union, never a ranking —
 * which account runs a model is the server's choice at start. A session that
 * requires enterprise may only land on an enterprise account, so only those
 * accounts contribute.
 */
export function automaticModels(
  profiles: CredentialProfileSummary[],
  modelsByProfile: Record<string, ModelOption[]>,
  options: { requiresEnterprise?: boolean } = {},
): ModelOption[] {
  return mergeModelOffers(
    orderCredentialProfilesByProvider(profiles)
      .filter(
        (profile) =>
          profile.enabled &&
          (!options.requiresEnterprise || profile.enterprise),
      )
      .flatMap((profile) => modelsByProfile[profile.id] ?? []),
  );
}

/**
 * One option per provider+model, in first-offer order. Automatic may run any
 * contributing account, so the option offers every thinking level at least one
 * of them accepts — the first account's catalog alone could hide an effort
 * another account can run.
 */
function mergeModelOffers<M extends ModelOption>(offers: readonly M[]): M[] {
  const merged = new Map<string, { model: M; levels: Set<ThinkingLevel> }>();
  for (const offer of offers) {
    const key = `${offer.provider}:${offer.id}`;
    const entry = merged.get(key) ?? { model: offer, levels: new Set() };
    for (const level of supportedThinkingLevelsForModel(offer))
      entry.levels.add(level);
    if (offer.reasoning && !entry.model.reasoning)
      entry.model = { ...entry.model, reasoning: true };
    merged.set(key, entry);
  }
  return [...merged.values()].map(({ model, levels }) => ({
    ...model,
    supportedThinkingLevels: THINKING_LEVELS.filter((level) =>
      levels.has(level),
    ),
  }));
}

/**
 * A settings slot's choices: Automatic first (the models any enabled account
 * offers), then the explicit account/model combinations.
 */
export function slotModelOptions(
  accountModels: AccountModelOption[],
): SlotModelOption[] {
  const automatic = mergeModelOffers(
    accountModels
      .filter((option) => !option.accountDisabled)
      .map(
        ({
          credentialProfileId: _account,
          accountName: _name,
          accountDisabled: _disabled,
          ...model
        }): ModelOption => model,
      ),
  ).map((model): AutomaticModelOption => ({ ...model, automatic: true }));
  return [...automatic, ...accountModels];
}

/**
 * Why a pinned account is not currently the one that would run: it was deleted,
 * or it is disabled. Mirrors the server's `resolveSlotAccount` degradation —
 * such a slot silently falls back to the automatic account rather than failing.
 * Which account Automatic lands on is the router's call, so it is not named.
 */
export function accountPinWarning(
  profiles: CredentialProfileSummary[],
  slot: { credentialProfileId?: string },
): string | undefined {
  const pinned = slot.credentialProfileId;
  if (!pinned) return undefined;
  const profile = profiles.find((item) => item.id === pinned);
  if (!profile)
    return "The pinned account no longer exists — this runs on the automatic account.";
  if (!profile.enabled)
    return `“${profile.name}” is disabled — this runs on the automatic account.`;
  return undefined;
}

/**
 * What actually happens when this account is disabled, in the order it matters:
 * what MOVES (pinned settings slots) and what KEEPS RUNNING on it (bound
 * sessions, including their forks, `/clear` and drafts). Automatic work needs no
 * line: the router simply stops picking a disabled account. Empty when
 * disabling changes nothing.
 */
export function disableAccountImpact(
  profile: CredentialProfileSummary,
): string[] {
  const usage = profile.usage;
  if (!usage) return [];
  const lines: string[] = [];
  if (usage.pinnedSlots.length > 0) {
    const one = usage.pinnedSlots.length === 1;
    lines.push(
      `${usage.pinnedSlots.length} settings ${one ? "slot" : "slots"} pinned to it ${one ? "falls" : "fall"} back to the automatic account: ${usage.pinnedSlots.map((slot) => slot.label).join(", ")}.`,
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

/**
 * Which account Automatic would pick right now for this model — the server's
 * router answers, so the browser never ranks accounts itself. Non-binding: the
 * first send picks again.
 */
export async function previewAutomaticAccount(
  request: AccountPickPreviewRequest,
  signal?: AbortSignal,
): Promise<AccountPickPreviewResult> {
  return body<AccountPickPreviewResult>(
    await fetch(`${serverHttpOrigin()}/api/account-router/pick`, {
      method: "POST",
      headers: { ...authHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify(request),
      ...(signal ? { signal } : {}),
    }),
  );
}

export function limitedAccountDescription(
  limited: { until?: number; model?: string } | undefined,
): string | undefined {
  if (
    !limited?.until ||
    !Number.isFinite(limited.until) ||
    limited.until <= Date.now()
  )
    return undefined;
  return `Limited until ${new Date(limited.until).toLocaleString()}${limited.model ? ` for ${limited.model}` : ""}`;
}

/**
 * What a pick preview tells the user about an Automatic choice: the account it
 * resolves to now and, when the router had to degrade, why. `warning` marks an
 * answer that is not a clean pick.
 */
export function automaticPreviewHint(
  preview: AccountPickPreviewResult,
  profiles: CredentialProfileSummary[],
  modelProvider: string,
): { text: string; warning: boolean } | undefined {
  const provider =
    accountProviderForModelProvider(modelProvider) === "claude"
      ? "Claude"
      : "OpenAI";
  const name = profiles.find(
    (profile) => profile.id === preview.profileId,
  )?.name;
  const account = name ? `“${name}”` : "an account";
  const limited = limitedAccountDescription(preview.limited);
  if (limited)
    return {
      text: `${limited}. Automatic falls back to ${account}.`,
      warning: true,
    };
  switch (preview.degraded) {
    case undefined:
      return name
        ? {
            text: `Automatic runs this on ${account} right now.`,
            warning: false,
          }
        : undefined;
    case "no-eligible-account":
      return {
        text: `No account can run this model cleanly right now (login, limits or model/effort) — Automatic falls back to ${account}.`,
        warning: true,
      };
    case "disabled-default":
      return {
        text: `Every account is disabled — background work falls back to ${account}.`,
        warning: true,
      };
    case "no-enabled-account":
      return {
        text: `No enabled ${provider} account.`,
        warning: true,
      };
    case "no-enterprise-account":
      return {
        text: `No enabled enterprise ${provider} account.`,
        warning: true,
      };
  }
  return undefined;
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
  name: string,
  provider: CredentialProfileProvider,
): Promise<CredentialProfileSummary> {
  const result = await body<{ profile: CredentialProfileSummary }>(
    await fetch(`${serverHttpOrigin()}/api/credential-profiles`, {
      method: "POST",
      headers: { ...authHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({ name, provider }),
    }),
  );
  return result.profile;
}

async function patchCredentialProfile(
  id: string,
  patch: { name?: string; enabled?: boolean; enterprise?: boolean },
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

/**
 * Marks the account as an enterprise account. Metadata only: it changes which
 * sessions may run on it ("requires enterprise"), never how it signs in.
 */
export function setCredentialProfileEnterprise(
  id: string,
  enterprise: boolean,
): Promise<CredentialProfileSummary> {
  return patchCredentialProfile(id, { enterprise });
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
