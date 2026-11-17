/**
 * The account ranking both Pandeck's router and the credential gateway's
 * machine pools use: which candidates may be picked and in what order. It has
 * no imports at all, type-only included, so the gateway may load it
 * (`workerBoundary.test.ts` `GATEWAY_ALLOWED`). Each caller scopes its
 * candidates first and computes their usage facts with its own helpers.
 */

/** What the ranking reads of an account. */
interface RankingProfile {
  id: string;
  enabled: boolean;
  health: { state: string };
  /** Manual priority, higher first, within a usage tier. */
  priority?: number | undefined;
}

/**
 * Fresh, limit-bearing usage, precomputed by the caller. `null` on the
 * candidate means unknown, which ranks in the middle tier.
 */
export interface RankingUsage {
  /** Percent used of the short (5-hour) window; null when unknown. */
  shortPct: number | null;
  /** Percent used of the long (weekly) window; null when unknown. */
  longPct: number | null;
  /** Epoch milliseconds the long window resets; null when unknown. */
  longResetsAt: number | null;
}

export interface RankingCandidate {
  profile: RankingProfile;
  offersModel: boolean;
  usage: RankingUsage | null;
  /** Any truthy value: the account is benched for this pick. */
  limited?: unknown;
}

export interface RankingThresholds {
  fiveHourUsedThreshold: number;
  weeklyUsedThreshold: number;
}

/**
 * The best candidate: from the eligible ones (enabled, not needs-login,
 * offering the model, not benched), else from the enabled ones as a degraded
 * pick, else undefined.
 */
export function rankCandidates<C extends RankingCandidate>(
  candidates: readonly C[],
  thresholds: RankingThresholds,
  now: number,
): { pick: C; eligible: boolean } | undefined {
  const enabled = candidates.filter(({ profile }) => profile.enabled);
  const eligible = enabled.filter(
    (candidate) =>
      candidate.profile.health.state !== "needs-login" &&
      candidate.offersModel &&
      !candidate.limited,
  );
  const pool = eligible.length ? eligible : enabled;
  if (!pool.length) return undefined;
  const pick = [...pool].sort(
    (a, b) =>
      Number(a.profile.health.state === "needs-login") -
        Number(b.profile.health.state === "needs-login") ||
      Number(!!a.limited) - Number(!!b.limited) ||
      Number(!a.offersModel) - Number(!b.offersModel) ||
      compareUsage(a, b, thresholds, now),
  )[0]!;
  return { pick, eligible: eligible.length > 0 };
}

function usageRank(
  usage: RankingUsage | null,
  thresholds: RankingThresholds,
  now: number,
): { tier: number; weeklyReset: number; fiveHourUsed: number } {
  if (!usage) return { tier: 1, weeklyReset: Infinity, fiveHourUsed: Infinity };
  const { shortPct: short, longPct: long, longResetsAt } = usage;
  const exhausted =
    (short !== null && short >= thresholds.fiveHourUsedThreshold) ||
    (long !== null && long >= thresholds.weeklyUsedThreshold);
  const tier = exhausted ? 2 : short === null || long === null ? 1 : 0;
  return {
    tier,
    weeklyReset:
      longResetsAt !== null &&
      Number.isFinite(longResetsAt) &&
      longResetsAt > now
        ? longResetsAt
        : Infinity,
    fiveHourUsed: short !== null ? short : Infinity,
  };
}

function compareUsage(
  a: RankingCandidate,
  b: RankingCandidate,
  thresholds: RankingThresholds,
  now: number,
): number {
  const left = usageRank(a.usage, thresholds, now);
  const right = usageRank(b.usage, thresholds, now);
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
