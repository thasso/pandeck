/**
 * Automatic redemption of OpenAI reset credits that are about to expire
 * (`docs/usage.md#auto-redeem`).
 *
 * A banked "Full reset" lapses thirty days after its grant, at the grant's
 * time-of-day in UTC — the small hours in Europe, when nobody is watching a
 * Usage page. An unspent credit is worth nothing, so inside the shared lead
 * (`OPENAI_RESET_AUTO_REDEEM_LEAD_MS`) the server spends it on whatever
 * window is open, applicability guard OFF: the worst case is the same as
 * letting it slip, and the best case is a weekly window back at zero.
 *
 * This is the ONE piece of usage work that runs with no client attached, and
 * it has to be: the cache's no-headless rule exists for the Claude subprocess,
 * while a credit expiring at 04:00 is exactly the case a client-driven refresh
 * never sees. The cost is bounded to one sub-second HTTPS GET per OpenAI
 * account every lead interval when idle, and a live re-read right before any
 * irreversible POST. Claude accounts are never touched.
 *
 * Best-effort like the other sweeps: at boot and every quarter hour, one
 * invocation at a time, failures logged and retried by the next run.
 */
import { randomUUID } from "node:crypto";
import type { CredentialProfileSummary } from "@assistant/shared";
import {
  OPENAI_RESET_AUTO_REDEEM_LEAD_MS,
  type OpenAiResetCredit,
  type OpenAiResetRedeemResult,
  type OpenAiUsageSnapshot,
} from "@assistant/shared/usage";
import { listCredentialProfiles } from "./credentialProfiles.ts";
import { errorText } from "./errors.ts";
import { redeemOpenAiResetCredit } from "./harnesses/usage.ts";
import {
  peekUsageSnapshot,
  readUsageSnapshot,
  revalidateUsage,
} from "./usageCache.ts";

/**
 * A quarter hour: with a six-hour lead every credit gets two dozen attempts,
 * so one failed provider call never decides its fate.
 */
const OPENAI_RESET_AUTO_REDEEM_SWEEP_INTERVAL_MS = 15 * 60_000;

/**
 * The still-available credits inside the lead, soonest first. Pure, so the
 * policy is tested directly. A credit already past its expiry is skipped: the
 * provider would refuse it, and it has in fact already dropped the row.
 */
export function selectExpiringResetCredits(
  snapshot: OpenAiUsageSnapshot | null | undefined,
  now: number,
): OpenAiResetCredit[] {
  if (!snapshot?.available || !snapshot.resetCredits) return [];
  const due: (OpenAiResetCredit & { remaining: number })[] = [];
  for (const credit of snapshot.resetCredits.credits) {
    if (credit.status !== "available" || !credit.expiresAt) continue;
    const at = Date.parse(credit.expiresAt);
    if (!Number.isFinite(at)) continue;
    const remaining = at - now;
    if (remaining <= 0 || remaining > OPENAI_RESET_AUTO_REDEEM_LEAD_MS)
      continue;
    due.push({ ...credit, remaining });
  }
  due.sort((a, b) => a.remaining - b.remaining);
  return due.map(({ remaining: _remaining, ...credit }) => credit);
}

/**
 * Whether the snapshot's per-credit detail is missing rows the counts say
 * exist. `fetchOpenAiUsage` deliberately degrades a failed detail read to a
 * counts-only inventory (`credits: []`) so the Usage page still renders; for
 * this sweep such a snapshot is NOT an answer about expiries, and must neither
 * replace what the cache knew nor count as a fresh look.
 */
export function resetInventoryIncomplete(
  snapshot: OpenAiUsageSnapshot | null | undefined,
): boolean {
  const inventory = snapshot?.available ? snapshot.resetCredits : null;
  if (!inventory) return false;
  const detailed = inventory.credits.filter(
    (credit) => credit.status === "available",
  ).length;
  return (inventory.availableCount ?? 0) > detailed;
}

export interface AutoRedeemOutcome {
  profileId: string;
  creditId: string;
  expiresAt: string | null;
  result: OpenAiResetRedeemResult | null;
  error: string | null;
}

/** Injectable so tests never touch the registry, the cache or the network. */
export interface AutoRedeemDeps {
  listProfiles: () => CredentialProfileSummary[];
  /** The cache as it stands, without fetching. */
  peek: (
    profileId: string,
  ) => { snapshot: OpenAiUsageSnapshot; fetchedAt: number } | null;
  /** A cache read that fetches when asked to (`force`) or when hard-invalid. */
  read: (profileId: string, force: boolean) => Promise<OpenAiUsageSnapshot>;
  /** The irreversible POST, guard off, under the given idempotency key. */
  redeem: (
    profileId: string,
    creditId: string,
    redeemRequestId: string,
  ) => Promise<OpenAiResetRedeemResult>;
  /** A forced background refresh after a redemption reset a window. */
  revalidate: (profileId: string) => void;
  now: () => number;
}

const realDeps: AutoRedeemDeps = {
  listProfiles: () => listCredentialProfiles(),
  peek: (profileId) => {
    const cached = peekUsageSnapshot(profileId, "openai-codex");
    return cached
      ? {
          snapshot: cached.snapshot as OpenAiUsageSnapshot,
          fetchedAt: cached.fetchedAt,
        }
      : null;
  },
  read: async (profileId, force) =>
    (await readUsageSnapshot(profileId, "openai-codex", {
      force,
    })) as OpenAiUsageSnapshot,
  redeem: (profileId, creditId, redeemRequestId) =>
    redeemOpenAiResetCredit(profileId, creditId, {
      requireApplicable: false,
      redeemRequestId,
    }),
  revalidate: (profileId) =>
    revalidateUsage({ force: true, profileIds: [profileId] }),
  now: () => Date.now(),
};

/**
 * One idempotency key per account+credit for the life of the process, minted
 * on the first attempt and reused by every retry: a consume that did reach
 * OpenAI before the connection failed is then the SAME request, not a second
 * spend. That is what lets a failed attempt be retried by the next sweep at
 * all.
 */
const requestIds = new Map<string, string>();

/**
 * Account+credit pairs this process has CONFIRMED redeemed. A redemption whose
 * follow-up refresh failed would otherwise still show as available in the
 * cache and be POSTed again by the next sweep.
 */
const redeemed = new Set<string>();

/** Credits are scoped to the account that holds them, so the bookkeeping is too. */
const attemptKey = (profileId: string, creditId: string): string =>
  `${profileId}\u0000${creditId}`;
let sweepRunning = false;
let sweepTimer: ReturnType<typeof setInterval> | undefined;

/**
 * Redeem, on every enabled OpenAI account, each still-available credit inside
 * the lead, and answer what was attempted.
 *
 * Per account: look at the cache; refresh it when it is older than the lead
 * (a credit granted since the last look must be discovered before it can
 * lapse), when its detail is incomplete (counts say more than the rows show),
 * or when it already names a candidate (a live re-read before an irreversible
 * POST, in case the credit was spent in the ChatGPT app). A failed or
 * incomplete refresh does not stop a redemption the cache calls for: the
 * provider is the authority on a spent credit and refuses it for free,
 * whereas an unspent one lapses. A failed POST is retried by the next sweep
 * under the same idempotency key.
 */
export async function sweepOpenAiResetAutoRedeem(
  overrides: Partial<AutoRedeemDeps> = {},
): Promise<AutoRedeemOutcome[]> {
  if (sweepRunning) return [];
  sweepRunning = true;
  const deps = { ...realDeps, ...overrides };
  const outcomes: AutoRedeemOutcome[] = [];
  try {
    const profiles = deps
      .listProfiles()
      .filter(
        (profile) => profile.enabled && profile.provider === "openai-codex",
      );
    for (const profile of profiles) {
      const now = deps.now();
      const cached = deps.peek(profile.id);
      const cachedSnapshot = cached?.snapshot ?? null;
      const stale =
        !cached || now - cached.fetchedAt > OPENAI_RESET_AUTO_REDEEM_LEAD_MS;
      const expected = selectExpiringResetCredits(cachedSnapshot, now);
      // Forced, not merely hard-invalid, whenever the answer has to be live:
      // an unforced read serves a fresh cache as is, and a fresh counts-only
      // snapshot is exactly the one that must not be served.
      const force =
        expected.length > 0 || resetInventoryIncomplete(cachedSnapshot);
      let live: OpenAiUsageSnapshot | null = null;
      if (stale || force) {
        try {
          live = await deps.read(profile.id, force);
        } catch (err) {
          console.warn(
            `[usage] auto-redeem refresh failed for ${profile.id}; deciding on the cached snapshot: ${errorText(err)}`,
          );
        }
      }
      // The live read answers for a credit only when it actually lists the
      // inventory; a counts-only snapshot says nothing about what the cache
      // named, so those rows stay due alongside whatever the read did show.
      const dueById = new Map<string, OpenAiResetCredit>();
      if (live)
        for (const credit of selectExpiringResetCredits(live, deps.now()))
          dueById.set(credit.id, credit);
      if (!live || resetInventoryIncomplete(live))
        for (const credit of expected) dueById.set(credit.id, credit);
      const due = [...dueById.values()].filter(
        (credit) => !redeemed.has(attemptKey(profile.id, credit.id)),
      );
      for (const credit of due) {
        const key = attemptKey(profile.id, credit.id);
        const requestId = requestIds.get(key) ?? randomUUID();
        requestIds.set(key, requestId);
        const outcome: AutoRedeemOutcome = {
          profileId: profile.id,
          creditId: credit.id,
          expiresAt: credit.expiresAt,
          result: null,
          error: null,
        };
        try {
          outcome.result = await deps.redeem(profile.id, credit.id, requestId);
          redeemed.add(key);
          console.info(
            `[usage] auto-redeemed OpenAI reset credit ${credit.id} on ${profile.id} (expires ${credit.expiresAt}): ${outcome.result.windowsReset ?? 0} window(s) reset`,
          );
        } catch (err) {
          outcome.error = errorText(err);
          console.warn(
            `[usage] auto-redeem of ${credit.id} on ${profile.id} failed: ${outcome.error}`,
          );
        }
        outcomes.push(outcome);
      }
      if (due.length > 0) deps.revalidate(profile.id);
    }
    return outcomes;
  } finally {
    sweepRunning = false;
  }
}

function runSweep(trigger: "boot" | "interval"): void {
  void sweepOpenAiResetAutoRedeem().catch((err: unknown) => {
    console.warn(
      `[usage] ${trigger} auto-redeem sweep failed; will retry later: ${errorText(err)}`,
    );
  });
}

/** Run the best-effort sweep at boot and every quarter hour thereafter. Idempotent. */
export function startOpenAiResetAutoRedeemSweep(): void {
  if (sweepTimer) return;
  runSweep("boot");
  sweepTimer = setInterval(
    () => runSweep("interval"),
    OPENAI_RESET_AUTO_REDEEM_SWEEP_INTERVAL_MS,
  );
  sweepTimer.unref?.();
}

export function stopOpenAiResetAutoRedeemSweep(): void {
  if (!sweepTimer) return;
  clearInterval(sweepTimer);
  sweepTimer = undefined;
}

/** Test seam: forget which credits this process already redeemed or keyed. */
export function resetOpenAiResetAutoRedeemForTests(): void {
  redeemed.clear();
  requestIds.clear();
  sweepRunning = false;
  stopOpenAiResetAutoRedeemSweep();
}
