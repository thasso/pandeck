/**
 * Provider account usage/rate-limit snapshot types (Usage page).
 *
 * - Claude (`ClaudeUsageSnapshot`): the Claude Agent SDK's experimental
 *   `usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET` control request
 *   (the data behind the CLI's `/usage` command).
 * - OpenAI (`OpenAiUsageSnapshot`): the ChatGPT backend `/backend-api/wham/usage`
 *   endpoint, authed with the OAuth token the user logged pi in with.
 *
 * Both upstream shapes are unstable, so these types are deliberately small,
 * stable projections rather than passthroughs of the raw responses.
 */

/** A single utilization window (e.g. the rolling 5-hour or weekly cap). */
export interface UsageLimitWindow {
  /** Percentage of the cap CONSUMED (0 = untouched, 100 = exhausted), or null when unknown. */
  utilizationPct: number | null;
  /** ISO 8601 timestamp of the next reset, or null when unknown. */
  resetsAt: string | null;
}

/**
 * One entry from the account's generic `limits[]` list — forward-compatible
 * with limit kinds this app does not specifically name (e.g. a future
 * model-scoped weekly cap). Rendered generically alongside the named windows.
 */
export interface UsageGenericLimit {
  kind: string;
  group: string;
  percent: number | null;
  severity: string | null;
  resetsAt: string | null;
  scope: { modelDisplayName?: string | null; surface?: string | null } | null;
  isActive: boolean;
}

/**
 * Prepaid overage credits beyond the plan's included limits, when enabled.
 * `monthlyLimit`/`usedCredits` are MINOR currency units (e.g. euro cents);
 * `decimalPlaces` is the exponent to divide by for a major-unit display
 * (2 ⇒ cents), so a raw `5025` renders as `50.25 EUR`, never `5025 EUR`.
 */
export interface UsageExtraCredits {
  enabled: boolean;
  monthlyLimit: number | null;
  usedCredits: number | null;
  utilizationPct: number | null;
  currency: string | null;
  decimalPlaces: number | null;
}

/** One model-scoped utilization window (e.g. per-model weekly caps like Fable/Opus). */
export interface UsageModelScoped {
  modelDisplayName: string | null;
  utilizationPct: number | null;
  resetsAt: string | null;
}

/** One local-transcript attribution window (approximate; excludes other devices). */
export interface UsageBehaviorWindow {
  requestCount: number;
  sessionCount: number;
  behaviors: { key: string; pct: number; count: number }[];
  /** Top agents/skills/plugins/mcp servers by weighted share, merged and capped. */
  topContributors: {
    name: string;
    pct: number;
    kind: "agent" | "skill" | "plugin" | "mcp_server";
  }[];
}

export interface ClaudeUsageSnapshot {
  /** Epoch ms this snapshot was fetched, for a "last updated" display. */
  fetchedAt: number;
  subscriptionType: string | null;
  /** False for API-key/Bedrock/Vertex sessions, where plan limits do not apply. */
  rateLimitsAvailable: boolean;
  fiveHour: UsageLimitWindow | null;
  weekly: UsageLimitWindow | null;
  limits: UsageGenericLimit[];
  /** Per-model utilization windows (e.g. Fable/Opus weekly caps), when reported. */
  modelScoped: UsageModelScoped[];
  extraUsage: UsageExtraCredits | null;
  session: {
    totalCostUsd: number;
    totalApiDurationMs: number;
    totalDurationMs: number;
  };
  /** Local-transcript behavioral attribution, or null when unavailable/non-subscriber. */
  behaviors: { day: UsageBehaviorWindow; week: UsageBehaviorWindow } | null;
}

/**
 * OpenAI (ChatGPT / Codex) account usage snapshot, sourced from the ChatGPT
 * backend `GET /backend-api/wham/usage` endpoint using the OAuth credentials the
 * user already logged in with for terminal pi (`~/.pi/agent/auth.json`,
 * `openai-codex`). Read-only: the app never refreshes the token — a stale token
 * degrades to `available: false` with a hint to re-run pi.
 */
export interface OpenAiUsageWindow {
  /**
   * Window classification by duration — the raw API "primary/secondary" naming
   * is NOT reliable (the primary window can itself be the weekly cap), so we
   * classify from `windowSeconds` instead.
   */
  kind: "five_hour" | "weekly" | "unknown";
  /** A label for named model-specific caps (e.g. "Codex Spark"); null for the plain 5h/weekly windows. */
  label: string | null;
  /** Percentage of the window CONSUMED (0-100), or null when unknown. */
  usedPercent: number | null;
  /** The window length in seconds (e.g. 18000 = 5h, 604800 = 7d), or null. */
  windowSeconds: number | null;
  /** ISO 8601 timestamp of the next reset, or null. */
  resetsAt: string | null;
}

/**
 * Admin/user spend cap ("spend_control"). The API reports NO currency or
 * exponent, so `limit`/`used` are raw numbers in an unknown unit (most likely
 * whole USD) — the UI must present them without inventing a currency symbol.
 */
export interface OpenAiSpendControl {
  reached: boolean;
  source: string | null;
  limit: number | null;
  used: number | null;
  remaining: number | null;
  usedPercent: number | null;
  resetsAt: string | null;
}

/**
 * One banked rate-limit reset credit (a "Full reset" OpenAI grants that resets a
 * currently-hit window early). Detail comes from `/wham/rate-limit-reset-credits`.
 */
export interface OpenAiResetCredit {
  id: string;
  /** e.g. "available" | "redeemed". */
  status: string | null;
  grantedAt: string | null;
  /** ISO expiry — a credit lapses ~30 days after grant if never spent. */
  expiresAt: string | null;
  redeemedAt: string | null;
  title: string | null;
  description: string | null;
  supportedByPlan: boolean;
}

/**
 * Reset-credit inventory. `applicableCount` (from `/wham/usage`) is how many
 * are usable RIGHT NOW — it is 0 unless a window is actually hit, so redeeming
 * while it is 0 wastes a credit. `credits` is the per-credit detail (expiries).
 */
export interface OpenAiResetCreditInventory {
  availableCount: number | null;
  applicableCount: number | null;
  credits: OpenAiResetCredit[];
}

export interface OpenAiUsageSnapshot {
  /** Epoch ms this snapshot was fetched, for a "last updated" display. */
  fetchedAt: number;
  /** True only when credentials were present AND the endpoint answered with usage data. */
  available: boolean;
  /** Human-readable reason when `available` is false (e.g. not logged in, token expired). */
  unavailableReason: string | null;
  planType: string | null;
  email: string | null;
  /** True when any tracked window is currently exhausted. */
  limitReached: boolean;
  /** 5-hour / weekly / named model windows, classified by duration. */
  windows: OpenAiUsageWindow[];
  credits: {
    hasCredits: boolean;
    unlimited: boolean;
    overageLimitReached: boolean;
    balance: number | null;
    approxLocalMessages: number | null;
    approxCloudMessages: number | null;
  } | null;
  spendControl: OpenAiSpendControl | null;
  resetCredits: OpenAiResetCreditInventory | null;
}

/**
 * Meter thresholds every usage surface shares: the Usage page's detail meters
 * and the new-session provider cards must not disagree about what "nearly out"
 * looks like. Percentages are always CONSUMED.
 */
export const USAGE_WARN_PCT = 70;
export const USAGE_CRITICAL_PCT = 90;

export type UsageLevel = "ok" | "warn" | "critical";

/** Colour band for a consumed-percentage meter; unknown reads as `ok` (neutral). */
export function usageLevel(pct: number | null | undefined): UsageLevel {
  if (pct === null || pct === undefined) return "ok";
  if (pct >= USAGE_CRITICAL_PCT) return "critical";
  if (pct >= USAGE_WARN_PCT) return "warn";
  return "ok";
}

/**
 * How much a cached snapshot can still be trusted.
 *
 * - `fresh`: within the provider's staleness threshold — render plainly.
 * - `stale`: past it and shown dimmed. A stale percent is only ever a LOWER
 *   bound within its window, which is what makes showing it safe at all.
 * - `unknown`: nothing cached yet, or the cache is known-wrong (too old, or the
 *   window it described has already rolled over) — render `—`, never a number.
 */
export type UsageIndicatorState = "fresh" | "stale" | "unknown";

/**
 * Age at which a cached snapshot is shown dimmed, and the age at which its
 * numbers stop being shown at all. Per provider because the fetches differ in
 * cost and the windows differ in speed.
 *
 * These live in shared, and the state is DERIVED from `fetchedAt` rather than
 * sent: a snapshot goes stale by the clock, with nothing happening on the
 * server to push a new value — an account stuck in failure backoff would
 * otherwise keep claiming to be fresh.
 */
export const USAGE_STALE_MS: Record<UsageIndicator["provider"], number> = {
  claude: 15 * 60_000,
  "openai-codex": 10 * 60_000,
};

export const USAGE_HARD_INVALID_MS: Record<UsageIndicator["provider"], number> =
  {
    claude: 60 * 60_000,
    "openai-codex": 30 * 60_000,
  };

export function usageIndicatorState(
  indicator: UsageIndicator,
  now: number,
): UsageIndicatorState {
  if (indicator.fetchedAt === null) return "unknown";
  const age = now - indicator.fetchedAt;
  if (age >= USAGE_HARD_INVALID_MS[indicator.provider]) return "unknown";
  return age >= USAGE_STALE_MS[indicator.provider] ? "stale" : "fresh";
}

/**
 * The percentage to render for one window, or null when there is no honest
 * number: once `now` passes the window's own reset the cycle has rolled over,
 * so the cached percent is known-wrong rather than merely old.
 */
export function usageWindowPct(
  window: UsageIndicatorWindow | null | undefined,
  now: number,
): number | null {
  if (!window || window.usedPct === null) return null;
  const resetMs = window.resetsAt ? Date.parse(window.resetsAt) : NaN;
  if (Number.isFinite(resetMs) && now >= resetMs) return null;
  return Math.min(100, Math.max(0, window.usedPct));
}

/**
 * How long until a window resets, as a compact duration (`45m`, `2h 20m`,
 * `14h`, `1d 2h`) — empty when the reset is unknown, `now` once it is due.
 *
 * The precision is deliberately coarse and BANDED, because this is an estimate
 * on a card, not a countdown: each unit is dropped once a coarser one carries
 * the answer — minutes from ten hours out, hours from ten days out. Rounding
 * carries upward (23h 50m reads `1d`, never `24h`).
 *
 * Together those bound the string at six characters (`9d 23h` is the widest)
 * for every wait under ~27 years, which is what lets a fixed-width column hold
 * it without ever reflowing. The current callers — 5-hour and weekly windows —
 * never leave the first two bands.
 */
export function formatUsageReset(
  resetsAt: string | null | undefined,
  now: number,
): string {
  if (!resetsAt) return "";
  const at = Date.parse(resetsAt);
  if (!Number.isFinite(at)) return "";
  const MINUTE = 60_000;
  const HOUR = 60 * MINUTE;
  const DAY = 24 * HOUR;
  const remaining = at - now;
  if (remaining <= 0) return "now";
  if (remaining >= 10 * DAY) return `${Math.round(remaining / DAY)}d`;
  if (remaining >= DAY) {
    const hours = Math.round(remaining / HOUR);
    const days = Math.floor(hours / 24);
    const rest = hours % 24;
    return days >= 10 ? `${days}d` : rest ? `${days}d ${rest}h` : `${days}d`;
  }
  if (remaining >= 10 * HOUR) {
    const hours = Math.round(remaining / HOUR);
    return hours >= 24 ? "1d" : `${hours}h`;
  }
  const minutes = Math.round(remaining / MINUTE);
  if (minutes < 1) return "now";
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (!hours) return `${minutes}m`;
  return rest ? `${hours}h ${rest}m` : `${hours}h`;
}

/** One generic cycle slot on a provider card (short = 5-hour, long = weekly). */
export interface UsageIndicatorWindow {
  /** Percentage of the window CONSUMED, or null when not (or no longer) known. */
  usedPct: number | null;
  /** ISO 8601 timestamp of the next reset, or null. */
  resetsAt: string | null;
}

/**
 * The narrow per-account projection the provider cards render.
 *
 * Deliberately NOT the raw snapshot: account email, spend controls and credit
 * detail stay on the Usage page's own path, so nothing account-identifying and
 * no secret travels with the cards. Each provider adapter maps its own windows
 * into the two generic cycle slots (or one, or none).
 */
export interface UsageIndicator {
  /** Credential profile the numbers belong to — usage is never shared across accounts. */
  profileId: string;
  provider: "claude" | "openai-codex";
  /** True while a background fetch for this account is in flight. */
  refreshing: boolean;
  /** Epoch ms of the cached snapshot, or null when nothing is cached. */
  fetchedAt: number | null;
  /**
   * False when the account reports no subscription limits at all — a Claude
   * API-key/Bedrock/Vertex session, or an OpenAI profile whose credentials are
   * missing/expired. The card shows a capability line instead of meters.
   */
  limitsAvailable: boolean;
  /** Short rolling cycle (5-hour), or null when the provider reports none. */
  short: UsageIndicatorWindow | null;
  /** Long cycle (weekly), or null when the provider reports none. */
  long: UsageIndicatorWindow | null;
}

/** Result of redeeming one reset credit (irreversible — the credit is consumed). */
export interface OpenAiResetRedeemResult {
  /** True when the reset was applied (at least one window reset). */
  ok: boolean;
  /** Backend result code, e.g. "reset". */
  code: string | null;
  /** How many rate-limit windows the redemption reset. */
  windowsReset: number | null;
  creditId: string | null;
  redeemedAt: string | null;
}

/**
 * How long before its expiry the server spends a still-available reset credit
 * on its own (`docs/usage.md#auto-redeem`). A credit lapses at the grant's
 * time-of-day in UTC — small hours in Europe — and an unspent one is worth
 * nothing, so it is redeemed on whatever window is open rather than let slip.
 * Six hours leaves the whole preceding day for a deliberate redemption while
 * still absorbing a server that was down for an evening.
 */
export const OPENAI_RESET_AUTO_REDEEM_LEAD_MS = 6 * 60 * 60_000;

/**
 * How urgently a reset credit's expiry should read.
 *
 * - `ok`: more than five days out.
 * - `soon`: within five days — shown with its clock time, because a date alone
 *   ("Sep 21") hides that the lapse is at 04:21 that morning.
 * - `imminent`: within a day — the countdown is the message.
 * - `pending`: inside the auto-redeem lead — the server is about to spend it.
 * - `expired`: past — the provider drops such rows, so this is rarely seen.
 * - `unknown`: no expiry on the row.
 */
export type ResetCreditExpiryLevel =
  "ok" | "soon" | "imminent" | "pending" | "expired" | "unknown";

export function resetCreditExpiryLevel(
  expiresAt: string | null | undefined,
  now: number,
): ResetCreditExpiryLevel {
  if (!expiresAt) return "unknown";
  const at = Date.parse(expiresAt);
  if (!Number.isFinite(at)) return "unknown";
  const remaining = at - now;
  const DAY = 24 * 60 * 60_000;
  if (remaining <= 0) return "expired";
  if (remaining <= OPENAI_RESET_AUTO_REDEEM_LEAD_MS) return "pending";
  if (remaining <= DAY) return "imminent";
  if (remaining <= 5 * DAY) return "soon";
  return "ok";
}
