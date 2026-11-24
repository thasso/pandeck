/** Account selection at session/run start; usage reads never fetch. */
import {
  accountKindForModelProvider,
  accountServesModel,
  isSubscriptionAccountKind,
  supportedThinkingLevelsForModel,
  type AccountPickPreviewResult,
  type AppSettings,
  type CredentialProfileSummary,
  type ThinkingLevel,
} from "@assistant/shared";
import {
  rankCandidates,
  type RankingUsage,
} from "@assistant/shared/accountRanking";
import {
  usageIndicatorState,
  usageWindowPct,
  type UsageIndicator,
} from "@assistant/shared/usage";
import {
  DEFAULT_CLAUDE_PROFILE_ID,
  DEFAULT_OPENAI_PROFILE_ID,
  listCredentialProfiles,
} from "./credentialProfiles.ts";
import {
  accountLacksModel,
  pinnedModelOption,
  modelsForAccount,
} from "./harnesses/models.ts";
import { getSettings } from "./settings.ts";
import { cachedUsageIndicator } from "./usageCache.ts";
import { readAccountBench } from "./accountHealth.ts";

export interface AccountPickRequest {
  model: { provider: string; modelId: string };
  thinkingLevel?: ThinkingLevel;
  requiresEnterprise?: boolean;
  excludeProfileIds?: readonly string[];
  /** Background automation alone may use the protected, disabled default. */
  allowDisabledDefault?: boolean;
  /**
   * A Claude run's pinned concrete version: only an account that runs this
   * exact id is in scope (`harnesses/models.ts` `accountLacksModel`).
   */
  pinnedModelId?: string;
  /**
   * The existing session's stored pin string, for the unknown-account legacy
   * allowance. Never set for a new start, spawn or definition.
   */
  persistedPinnedModelId?: string;
}

type RoutingProfile = Pick<
  CredentialProfileSummary,
  "id" | "provider" | "enabled" | "enterprise" | "health" | "priority"
>;

export interface AccountCandidate {
  profile: RoutingProfile;
  offersModel: boolean;
  /**
   * The account's known model listing lacks the model: a hard exclusion,
   * unlike every other fact here. Unknown accounts never lack a model.
   */
  lacksModel?: boolean;
  usage: UsageIndicator | null;
  limited?: AccountPickPreviewResult["limited"];
}

export type AccountPickResult = AccountPickPreviewResult;
type AccountRoutingThresholds = Pick<
  AppSettings["accountRouting"],
  "fiveHourUsedThreshold" | "weeklyUsedThreshold"
>;

/** Pure policy, shared by real gathering and the ranking regressions. */
export function rankAccountCandidates(
  candidates: readonly AccountCandidate[],
  request: AccountPickRequest,
  thresholds: AccountRoutingThresholds,
  now: number,
  defaultProfileId: string | undefined,
): AccountPickResult {
  const served = candidates.filter(
    ({ profile }) =>
      accountServesModel(profile, request.model.provider) &&
      (!request.requiresEnterprise || profile.enterprise) &&
      !request.excludeProfileIds?.includes(profile.id),
  );
  // Entitlement is hard: an account whose listing lacks the model leaves the
  // scope BEFORE ranking, so neither the degraded pool nor the disabled
  // default can pick it. Benches, health and usage stay soft.
  const scope = served.filter((candidate) => !candidate.lacksModel);
  const ranked = rankCandidates(
    scope.map((candidate) => ({
      ...candidate,
      usage: rankingUsage(candidate.usage, now),
      source: candidate,
    })),
    thresholds,
    now,
  );
  if (ranked) {
    const first = ranked.pick.source;
    return {
      profileId: first.profile.id,
      ...(ranked.eligible ? {} : { degraded: "no-eligible-account" as const }),
      ...(first.limited ? { limited: first.limited } : {}),
    };
  }
  if (request.allowDisabledDefault && defaultProfileId !== undefined) {
    const fallback = scope.find(
      ({ profile }) => profile.id === defaultProfileId,
    );
    if (fallback)
      return {
        profileId: fallback.profile.id,
        degraded: "disabled-default",
        ...(fallback.limited ? { limited: fallback.limited } : {}),
      };
  }
  // "model-unavailable" only when entitlement decided it: a lacking account
  // would otherwise have been usable (enabled, or the disabled default this
  // request may fall back to). A disabled account that lacks the model is
  // excluded twice, and the accurate reason is the other one.
  const usableLacking = served.some(
    ({ profile, lacksModel }) =>
      lacksModel &&
      (profile.enabled ||
        (request.allowDisabledDefault === true &&
          profile.id === defaultProfileId)),
  );
  return {
    profileId: null,
    degraded: usableLacking
      ? "model-unavailable"
      : request.requiresEnterprise
        ? "no-enterprise-account"
        : "no-enabled-account",
  };
}

/**
 * The ranking's usage facts: only fresh usage with limits counts, else it is
 * unknown.
 */
function rankingUsage(
  usage: UsageIndicator | null,
  now: number,
): RankingUsage | null {
  if (!usage?.limitsAvailable || usageIndicatorState(usage, now) !== "fresh")
    return null;
  // The usage projection reports a null window only when the provider proved
  // it absent ("no 5h limit"): with fresh usage that is room, not unknown
  // usage. Unproven absence arrives as a window of unknown percent instead.
  const windowPct = (window: UsageIndicator["short"]): number | null => {
    if (window === null) return 0;
    const pct = usageWindowPct(window, now);
    return pct !== null && Number.isFinite(pct) ? pct : null;
  };
  const reset = usage.long?.resetsAt ? Date.parse(usage.long.resetsAt) : NaN;
  return {
    shortPct: windowPct(usage.short),
    longPct: windowPct(usage.long),
    longResetsAt: Number.isFinite(reset) ? reset : null,
  };
}

/**
 * One account's routing facts for a model: whether its official model snapshot
 * offers the model (and the thinking level), whether its known listing lacks
 * it, its cached usage and the bench on that model. Automatic and an explicit
 * move judge these same facts.
 */
export async function gatherAccountCandidate(
  profile: RoutingProfile,
  request: Pick<
    AccountPickRequest,
    "model" | "thinkingLevel" | "pinnedModelId" | "persistedPinnedModelId"
  >,
): Promise<AccountCandidate> {
  const pin = {
    ...(request.pinnedModelId !== undefined
      ? { pinnedModelId: request.pinnedModelId }
      : {}),
    ...(request.persistedPinnedModelId !== undefined
      ? { persistedPinnedModelId: request.persistedPinnedModelId }
      : {}),
  };
  // A pinned session is offered by its pin, never by whether the account
  // also lists the alias's current candidate.
  const [model, lacksModel] = await Promise.all([
    !profile.enabled
      ? undefined
      : pin.pinnedModelId !== undefined
        ? pinnedModelOption(
            profile.id,
            request.model.provider,
            request.model.modelId,
            pin,
          ).catch(() => undefined)
        : modelsForAccount(profile)
            .catch(() => [])
            .then((models) =>
              models.find(
                (option) =>
                  option.provider === request.model.provider &&
                  option.id === request.model.modelId,
              ),
            ),
    accountLacksModel(
      profile.id,
      request.model.provider,
      request.model.modelId,
      pin,
    ).catch(() => false),
  ]);
  // Usage and benches speak only for subscription logins; any other
  // account ranks on its own state alone.
  const kind = profile.provider;
  const subscription = isSubscriptionAccountKind(kind);
  let usage: UsageIndicator | null = null;
  try {
    if (profile.enabled && subscription)
      usage = cachedUsageIndicator({ id: profile.id, provider: kind });
  } catch {
    // A malformed best-effort cache is missing usage, not a failed start.
  }
  const bench = subscription
    ? readAccountBench(profile.id, request.model.modelId)
    : undefined;
  return {
    profile,
    ...(bench
      ? {
          limited: {
            until: bench.until,
            ...(bench.model ? { model: bench.model } : {}),
          },
        }
      : {}),
    offersModel:
      !!model &&
      (request.thinkingLevel === undefined ||
        supportedThinkingLevelsForModel(model).includes(request.thinkingLevel)),
    ...(lacksModel ? { lacksModel } : {}),
    usage,
  };
}

/** Gather official per-account model snapshots and cached usage, then rank. */
export async function pickAccount(
  request: AccountPickRequest,
): Promise<AccountPickResult> {
  const kind = accountKindForModelProvider(request.model.provider);
  const profiles = listCredentialProfiles().filter(
    (profile) =>
      accountServesModel(profile, request.model.provider) &&
      (!request.requiresEnterprise || profile.enterprise) &&
      !request.excludeProfileIds?.includes(profile.id),
  );
  const candidates = await Promise.all(
    profiles.map((profile) => gatherAccountCandidate(profile, request)),
  );
  return rankAccountCandidates(
    candidates,
    request,
    getSettings().accountRouting,
    Date.now(),
    // Only the subscription kinds have a protected default to fall back to.
    kind === "claude"
      ? DEFAULT_CLAUDE_PROFILE_ID
      : kind === "openai-codex"
        ? DEFAULT_OPENAI_PROFILE_ID
        : undefined,
  );
}
