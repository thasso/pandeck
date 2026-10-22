/** Account selection at session/run start; usage reads never fetch. */
import {
  accountProviderForModelProvider,
  supportedThinkingLevelsForModel,
  type AccountPickPreviewResult,
  type AppSettings,
  type CredentialProfileSummary,
  type ThinkingLevel,
} from "@assistant/shared";
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
import { modelsForAccount } from "./harnesses/models.ts";
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
}

type RoutingProfile = Pick<
  CredentialProfileSummary,
  "id" | "provider" | "enabled" | "enterprise" | "health" | "priority"
>;

export interface AccountCandidate {
  profile: RoutingProfile;
  offersModel: boolean;
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
  defaultProfileId: string,
): AccountPickResult {
  const provider = accountProviderForModelProvider(request.model.provider);
  const scope = candidates.filter(
    ({ profile }) =>
      profile.provider === provider &&
      (!request.requiresEnterprise || profile.enterprise) &&
      !request.excludeProfileIds?.includes(profile.id),
  );
  const enabled = scope.filter(({ profile }) => profile.enabled);
  const eligible = enabled.filter(
    (candidate) =>
      candidate.profile.health.state !== "needs-login" &&
      candidate.offersModel &&
      !candidate.limited,
  );
  const pool = eligible.length ? eligible : enabled;
  if (pool.length) {
    const first = [...pool].sort(
      (a, b) =>
        Number(a.profile.health.state === "needs-login") -
          Number(b.profile.health.state === "needs-login") ||
        Number(!!a.limited) - Number(!!b.limited) ||
        Number(!a.offersModel) - Number(!b.offersModel) ||
        compareUsage(a, b, thresholds, now),
    )[0]!;
    return {
      profileId: first.profile.id,
      ...(eligible.length ? {} : { degraded: "no-eligible-account" as const }),
      ...(first.limited ? { limited: first.limited } : {}),
    };
  }
  if (request.allowDisabledDefault) {
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
  return {
    profileId: null,
    degraded: request.requiresEnterprise
      ? "no-enterprise-account"
      : "no-enabled-account",
  };
}

function usageRank(
  candidate: AccountCandidate,
  thresholds: AccountRoutingThresholds,
  now: number,
): { tier: number; weeklyReset: number; fiveHourUsed: number } {
  const usage = candidate.usage;
  const shortPct = usage ? usageWindowPct(usage.short, now) : null;
  const longPct = usage ? usageWindowPct(usage.long, now) : null;
  const short =
    shortPct !== null && Number.isFinite(shortPct) ? shortPct : null;
  const long = longPct !== null && Number.isFinite(longPct) ? longPct : null;
  const fresh =
    usage &&
    usage.limitsAvailable &&
    usageIndicatorState(usage, now) === "fresh";
  const exhausted =
    (short !== null && short >= thresholds.fiveHourUsedThreshold) ||
    (long !== null && long >= thresholds.weeklyUsedThreshold);
  const tier = !fresh
    ? 1
    : exhausted
      ? 2
      : short === null || long === null
        ? 1
        : 0;
  const reset =
    fresh && usage.long?.resetsAt ? Date.parse(usage.long.resetsAt) : NaN;
  return {
    tier,
    weeklyReset: Number.isFinite(reset) && reset > now ? reset : Infinity,
    fiveHourUsed: fresh && short !== null ? short : Infinity,
  };
}

function compareUsage(
  a: AccountCandidate,
  b: AccountCandidate,
  thresholds: AccountRoutingThresholds,
  now: number,
): number {
  const left = usageRank(a, thresholds, now);
  const right = usageRank(b, thresholds, now);
  // Infinity - Infinity is NaN; `||` deliberately proceeds to the next key.
  // The manual priority orders accounts within a usage tier only.
  return (
    left.tier - right.tier ||
    (b.profile.priority ?? 0) - (a.profile.priority ?? 0) ||
    left.weeklyReset - right.weeklyReset ||
    left.fiveHourUsed - right.fiveHourUsed ||
    (a.profile.id < b.profile.id ? -1 : a.profile.id > b.profile.id ? 1 : 0)
  );
}

/** Gather official per-account model snapshots and cached usage, then rank. */
export async function pickAccount(
  request: AccountPickRequest,
): Promise<AccountPickResult> {
  const provider = accountProviderForModelProvider(request.model.provider);
  const profiles = listCredentialProfiles().filter(
    (profile) =>
      profile.provider === provider &&
      (!request.requiresEnterprise || profile.enterprise) &&
      !request.excludeProfileIds?.includes(profile.id),
  );
  const candidates = await Promise.all(
    profiles.map(async (profile): Promise<AccountCandidate> => {
      const models = profile.enabled
        ? await modelsForAccount(profile).catch(() => [])
        : [];
      const model = models.find(
        (option) =>
          option.provider === request.model.provider &&
          option.id === request.model.modelId,
      );
      let usage: UsageIndicator | null = null;
      try {
        if (profile.enabled) usage = cachedUsageIndicator(profile);
      } catch {
        // A malformed best-effort cache is missing usage, not a failed start.
      }
      const bench = readAccountBench(profile.id, request.model.modelId);
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
            supportedThinkingLevelsForModel(model).includes(
              request.thinkingLevel,
            )),
        usage,
      };
    }),
  );
  return rankAccountCandidates(
    candidates,
    request,
    getSettings().accountRouting,
    Date.now(),
    provider === "claude"
      ? DEFAULT_CLAUDE_PROFILE_ID
      : DEFAULT_OPENAI_PROFILE_ID,
  );
}
