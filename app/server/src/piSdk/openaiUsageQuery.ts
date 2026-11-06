/**
 * Fetches the OpenAI (ChatGPT / Codex) account usage snapshot for the Usage
 * page, backing `GET /api/usage/openai`.
 *
 * It reads the selected PA-owned profile's OAuth credentials from
 * `DATA_DIR/credential-profiles/<id>/pi-agent/auth.json` and calls the ChatGPT
 * backend `GET /backend-api/wham/usage` endpoint — the same data source the Codex CLI's
 * `/status` uses. READ-ONLY: we never refresh the token. A missing/expired
 * token degrades to `available: false` with a hint to re-run pi, rather than an
 * error, so the UI can show a friendly state.
 *
 * Under the credential gateway the same requests go to its `/chatgpt` prefix
 * with the server's lease as the bearer; the gateway adds the token and
 * account id. The server then reads only whether `auth.json` holds a Codex
 * login and when it expires, or in client mode the mirrored account's state.
 * A gateway refusal (its marker) is a temporary
 * failure, never a rejected login.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { piAgentDir, remoteAccountReady } from "../credentialProfiles.ts";
import { gatewayRefusalText } from "../providerErrors.ts";
import type { EngineGatewayAccess } from "../workerProtocol/engineMethods.ts";
import { randomUUID } from "node:crypto";
import type {
  OpenAiResetCredit,
  OpenAiResetRedeemResult,
  OpenAiSpendControl,
  OpenAiUsageSnapshot,
  OpenAiUsageWindow,
} from "@assistant/shared/usage";

const BACKEND_BASE = "https://chatgpt.com/backend-api/wham";

/** The `openai-codex` OAuth entry we read out of pi's auth store. */
interface PiCodexAuth {
  access: string;
  accountId: string;
  /** Epoch ms of access-token expiry, when pi recorded it. */
  expires: number | null;
}

/** Where a profile's wham requests go and what they carry. */
interface CodexBackend {
  /** Epoch ms of access-token expiry, when pi recorded it. */
  expires: number | null;
  /** The wham base: chatgpt.com's, or the gateway's. */
  base: string;
  headers: Record<string, string>;
}

type HttpResult = { status: number; body: unknown };

/** Injectable dependencies so tests never touch the real filesystem or network. */
export interface OpenAiUsageDeps {
  readAuth: () => Promise<CodexBackend | null>;
  fetchUsage: (backend: CodexBackend) => Promise<HttpResult>;
  /** Best-effort per-credit inventory (expiries); a failure degrades to counts-only. */
  fetchResetCredits: (backend: CodexBackend) => Promise<HttpResult>;
  /** IRREVERSIBLE redeem POST; only called from `redeemOpenAiResetCredit`. */
  postConsume: (
    backend: CodexBackend,
    creditId: string,
    redeemRequestId: string,
  ) => Promise<HttpResult>;
  now: () => number;
  newRequestId: () => string;
}

/** Path to a PA-owned pi auth store. Tests inject `readAuth` rather than a path. */
function piAuthPath(profileId = "default"): string {
  return join(piAgentDir(profileId), "auth.json");
}

/** The profile's Codex login, or null without one. */
async function readCodexLogin(profileId: string): Promise<PiCodexAuth | null> {
  let raw: string;
  try {
    raw = await readFile(piAuthPath(profileId), "utf8");
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const codex = (parsed as Record<string, unknown> | null)?.["openai-codex"];
  if (!codex || typeof codex !== "object") return null;
  const c = codex as Record<string, unknown>;
  const access = typeof c.access === "string" ? c.access : null;
  const accountId = typeof c.accountId === "string" ? c.accountId : "";
  if (!access) return null;
  return {
    access,
    accountId,
    expires: typeof c.expires === "number" ? c.expires : null,
  };
}

/** The ChatGPT web backend expects a browser-ish origin alongside the bearer token. */
const BROWSER_HEADERS = {
  Origin: "https://chatgpt.com",
  Referer: "https://chatgpt.com/",
  "User-Agent": "Mozilla/5.0",
};

/** chatgpt.com directly, with the profile's own token and account id. */
async function readPiCodexAuth(
  profileId = "default",
): Promise<CodexBackend | null> {
  const auth = await readCodexLogin(profileId);
  return (
    auth && {
      expires: auth.expires,
      base: BACKEND_BASE,
      headers: {
        Authorization: `Bearer ${auth.access}`,
        Accept: "application/json",
        "ChatGPT-Account-Id": auth.accountId,
        ...BROWSER_HEADERS,
      },
    }
  );
}

/**
 * Whether the profile holds a Codex login, and its expiry: never the token
 * or account id, which only the gateway reads (RD-G4-3). In client mode no
 * file exists here: the gateway says whether the login works and renews it,
 * so there is no expiry to read.
 */
export async function readPiCodexMeta(
  profileId: string,
): Promise<{ expires: number | null } | null> {
  if (remoteAccountReady(profileId)) return { expires: null };
  const auth = await readCodexLogin(profileId);
  return auth && { expires: auth.expires };
}

/** The gateway's `/chatgpt`, with the server lease: the gateway adds the rest. */
async function readGatewayBackend(
  profileId: string,
  access: EngineGatewayAccess,
): Promise<CodexBackend | null> {
  const meta = await readPiCodexMeta(profileId);
  return (
    meta && {
      expires: meta.expires,
      base: `${access.baseUrl}/chatgpt/backend-api/wham`,
      headers: {
        Authorization: `Bearer ${access.leaseToken}`,
        Accept: "application/json",
        ...BROWSER_HEADERS,
      },
    }
  );
}

async function readHttpResult(res: Response): Promise<HttpResult> {
  const text = await res.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { status: res.status, body };
}

async function fetchUsageOverHttp(backend: CodexBackend): Promise<HttpResult> {
  return readHttpResult(
    await fetch(`${backend.base}/usage`, {
      method: "GET",
      headers: backend.headers,
    }),
  );
}

async function fetchResetCreditsOverHttp(
  backend: CodexBackend,
): Promise<HttpResult> {
  return readHttpResult(
    await fetch(`${backend.base}/rate-limit-reset-credits`, {
      method: "GET",
      headers: backend.headers,
    }),
  );
}

async function postConsumeOverHttp(
  backend: CodexBackend,
  creditId: string,
  redeemRequestId: string,
): Promise<HttpResult> {
  return readHttpResult(
    await fetch(`${backend.base}/rate-limit-reset-credits/consume`, {
      method: "POST",
      headers: { ...backend.headers, "Content-Type": "application/json" },
      body: JSON.stringify({
        credit_id: creditId,
        redeem_request_id: redeemRequestId,
      }),
    }),
  );
}

const DEFAULT_DEPS: OpenAiUsageDeps = {
  readAuth: readPiCodexAuth,
  fetchUsage: fetchUsageOverHttp,
  fetchResetCredits: fetchResetCreditsOverHttp,
  postConsume: postConsumeOverHttp,
  now: () => Date.now(),
  newRequestId: () => randomUUID(),
};

function numberOrNull(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  // Some fields (spend limits) arrive as numeric strings.
  if (typeof value === "string" && value.trim() !== "") {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

/** Normalizes a `reset_at` (epoch seconds, sometimes ms) to an ISO string. */
function resetToIso(value: unknown): string | null {
  const raw = numberOrNull(value);
  if (raw === null) return null;
  const ms = raw > 1e11 ? raw : raw * 1000; // < 1e11 ⇒ seconds
  const date = new Date(ms);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/** Classifies a window by its length: ≤6h ⇒ 5-hour, ≥6d ⇒ weekly, else unknown. */
function classifyWindow(
  windowSeconds: number | null,
): OpenAiUsageWindow["kind"] {
  if (windowSeconds === null) return "unknown";
  if (windowSeconds <= 6 * 3600) return "five_hour";
  if (windowSeconds >= 6 * 24 * 3600) return "weekly";
  return "unknown";
}

function mapWindow(
  raw: unknown,
  label: string | null,
): OpenAiUsageWindow | null {
  if (!raw || typeof raw !== "object") return null;
  const w = raw as Record<string, unknown>;
  const windowSeconds = numberOrNull(w.limit_window_seconds);
  return {
    kind: classifyWindow(windowSeconds),
    label,
    usedPercent: numberOrNull(w.used_percent),
    windowSeconds,
    resetsAt: resetToIso(w.reset_at),
  };
}

function mapSpendControl(raw: unknown): OpenAiSpendControl | null {
  if (!raw || typeof raw !== "object") return null;
  const s = raw as Record<string, unknown>;
  const individual =
    s.individual_limit && typeof s.individual_limit === "object"
      ? (s.individual_limit as Record<string, unknown>)
      : null;
  if (!individual)
    return s.reached === true
      ? {
          reached: true,
          source: null,
          limit: null,
          used: null,
          remaining: null,
          usedPercent: null,
          resetsAt: null,
        }
      : null;
  return {
    reached: s.reached === true,
    source: stringOrNull(individual.source),
    limit: numberOrNull(individual.limit),
    used: numberOrNull(individual.used),
    remaining: numberOrNull(individual.remaining),
    usedPercent: numberOrNull(individual.used_percent),
    resetsAt: resetToIso(individual.reset_at),
  };
}

/** Maps one `/wham/rate-limit-reset-credits` credit row into the stable wire shape. */
function mapResetCredit(raw: unknown): OpenAiResetCredit | null {
  if (!raw || typeof raw !== "object") return null;
  const c = raw as Record<string, unknown>;
  const id = stringOrNull(c.id);
  if (!id) return null;
  const toIso = (v: unknown): string | null => {
    const s = stringOrNull(v);
    if (!s) return null;
    const d = new Date(s);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  };
  return {
    id,
    status: stringOrNull(c.status),
    grantedAt: toIso(c.granted_at),
    expiresAt: toIso(c.expires_at),
    redeemedAt: toIso(c.redeemed_at),
    title: stringOrNull(c.title),
    description: stringOrNull(c.description),
    supportedByPlan: c.is_supported_by_plan === true,
  };
}

/** Parses the detail-endpoint body into sorted (soonest-expiring first) credit rows. */
export function mapResetCredits(raw: unknown): OpenAiResetCredit[] {
  const list =
    raw && typeof raw === "object"
      ? (raw as Record<string, unknown>).credits
      : null;
  if (!Array.isArray(list)) return [];
  const credits = list.flatMap((entry) => {
    const mapped = mapResetCredit(entry);
    return mapped ? [mapped] : [];
  });
  credits.sort((a, b) => (a.expiresAt ?? "").localeCompare(b.expiresAt ?? ""));
  return credits;
}

/** Maps the loosely-typed `/wham/usage` response into the stable wire shape. */
export function mapOpenAiUsageResponse(
  raw: Record<string, unknown>,
  fetchedAt: number,
): OpenAiUsageSnapshot {
  const rateLimit =
    raw.rate_limit && typeof raw.rate_limit === "object"
      ? (raw.rate_limit as Record<string, unknown>)
      : null;
  const windows: OpenAiUsageWindow[] = [];
  if (rateLimit) {
    const primary = mapWindow(rateLimit.primary_window, null);
    const secondary = mapWindow(rateLimit.secondary_window, null);
    if (primary) windows.push(primary);
    if (secondary) windows.push(secondary);
    if (Array.isArray(rateLimit.additional_rate_limits)) {
      for (const entry of rateLimit.additional_rate_limits) {
        if (!entry || typeof entry !== "object") continue;
        const e = entry as Record<string, unknown>;
        const label =
          stringOrNull(e.name) ??
          stringOrNull(e.label) ??
          stringOrNull(e.title) ??
          "Model limit";
        const mapped = mapWindow(e, label);
        if (mapped) windows.push(mapped);
      }
    }
  }

  const creditsRaw =
    raw.credits && typeof raw.credits === "object"
      ? (raw.credits as Record<string, unknown>)
      : null;
  const resetCreditsRaw =
    raw.rate_limit_reset_credits &&
    typeof raw.rate_limit_reset_credits === "object"
      ? (raw.rate_limit_reset_credits as Record<string, unknown>)
      : null;

  return {
    fetchedAt,
    available: true,
    unavailableReason: null,
    planType: stringOrNull(raw.plan_type),
    email: stringOrNull(raw.email),
    limitReached: rateLimit?.limit_reached === true,
    windows,
    credits: creditsRaw
      ? {
          hasCredits: creditsRaw.has_credits === true,
          unlimited: creditsRaw.unlimited === true,
          overageLimitReached: creditsRaw.overage_limit_reached === true,
          balance: numberOrNull(creditsRaw.balance),
          approxLocalMessages: numberOrNull(creditsRaw.approx_local_messages),
          approxCloudMessages: numberOrNull(creditsRaw.approx_cloud_messages),
        }
      : null,
    spendControl: mapSpendControl(raw.spend_control),
    resetCredits: resetCreditsRaw
      ? {
          availableCount: numberOrNull(resetCreditsRaw.available_count),
          applicableCount: numberOrNull(
            resetCreditsRaw.applicable_available_count,
          ),
          // Per-credit detail (expiries) is enriched separately in fetchOpenAiUsage.
          credits: [],
        }
      : null,
  };
}

/** Reads `rate_limit_reset_credits.applicable_available_count` from a `/wham/usage` body. */
function applicableResetCount(body: unknown): number | null {
  if (!body || typeof body !== "object") return null;
  const rlrc = (body as Record<string, unknown>).rate_limit_reset_credits;
  if (!rlrc || typeof rlrc !== "object") return null;
  return numberOrNull(
    (rlrc as Record<string, unknown>).applicable_available_count,
  );
}

function unavailable(
  reason: string,
  fetchedAt: number,
  code: NonNullable<OpenAiUsageSnapshot["unavailableCode"]>,
): OpenAiUsageSnapshot {
  return {
    fetchedAt,
    available: false,
    unavailableReason: reason,
    unavailableCode: code,
    planType: null,
    email: null,
    limitReached: false,
    windows: [],
    credits: null,
    spendControl: null,
    resetCredits: null,
  };
}

/**
 * Fetches the OpenAI account usage snapshot. Returns an `available: false`
 * snapshot for the expected non-error states (not logged in via pi, expired
 * token, forbidden account). Throws only on genuinely unexpected failures
 * (network down, malformed body) so the route can surface a 502.
 */
export async function fetchOpenAiUsage(
  deps: Partial<OpenAiUsageDeps> = {},
): Promise<OpenAiUsageSnapshot> {
  const { readAuth, fetchUsage, fetchResetCredits, now } = {
    ...DEFAULT_DEPS,
    ...deps,
  };
  const fetchedAt = now();

  const auth = await readAuth();
  if (!auth) {
    return unavailable(
      "Not signed in to this OpenAI profile. Connect it in Settings, then reload.",
      fetchedAt,
      "not-signed-in",
    );
  }
  if (auth.expires !== null && auth.expires <= fetchedAt) {
    return unavailable(
      "This OpenAI access token has expired. Run a session to refresh it, then reload.",
      fetchedAt,
      "expired",
    );
  }

  const { status, body } = await fetchUsage(auth);
  throwGatewayRefusal(body);
  if (status === 401) {
    return unavailable(
      "OpenAI rejected this profile login token (expired or invalid). Reconnect it in Settings.",
      fetchedAt,
      "rejected",
    );
  }
  if (status === 403) {
    return unavailable(
      "This OpenAI account cannot access usage data (403).",
      fetchedAt,
      "forbidden",
    );
  }
  if (status < 200 || status >= 300) {
    throw new Error(`OpenAI usage request failed (HTTP ${status}).`);
  }
  if (!body || typeof body !== "object") {
    throw new Error("OpenAI usage response was not valid JSON.");
  }

  const snapshot = mapOpenAiUsageResponse(
    body as Record<string, unknown>,
    fetchedAt,
  );

  // Best-effort per-credit inventory (expiries). A failure here must NOT fail the
  // whole snapshot — usage still renders, just without expiry rows.
  if (snapshot.resetCredits) {
    try {
      const detail = await fetchResetCredits(auth);
      if (detail.status >= 200 && detail.status < 300) {
        snapshot.resetCredits.credits = mapResetCredits(detail.body);
      }
    } catch {
      // ignore — keep counts-only inventory
    }
  }

  return snapshot;
}

export async function fetchOpenAiUsageForProfile(
  profileId: string,
): Promise<OpenAiUsageSnapshot> {
  return fetchOpenAiUsage({ readAuth: () => readPiCodexAuth(profileId) });
}

/** {@link fetchOpenAiUsageForProfile} through the gateway, on the server lease. */
export async function fetchOpenAiUsageViaGateway(
  profileId: string,
  access: EngineGatewayAccess,
): Promise<OpenAiUsageSnapshot> {
  return fetchOpenAiUsage({
    readAuth: () => readGatewayBackend(profileId, access),
  });
}

/**
 * A gateway's own refusal throws its text: it says nothing about the login,
 * so it never maps to `rejected`, `forbidden` or "Reconnect" (RD-G4-1).
 */
function throwGatewayRefusal(body: unknown): void {
  const refusal = gatewayRefusalText(body);
  if (refusal !== undefined) throw new Error(refusal);
}

/** How a redemption treats OpenAI's "nothing to reset right now" signal. */
export interface RedeemResetOptions {
  /**
   * Default true: re-check `/wham/usage` first and refuse (`notApplicable`,
   * → HTTP 409) unless `applicable_available_count > 0`. False skips the
   * check and spends the credit on whatever the backend does with it — the
   * user's explicit "redeem anyway", and the auto-redeem of a credit that is
   * about to lapse either way.
   */
  requireApplicable?: boolean;
  /**
   * Idempotency key for the consume POST (`redeem_request_id`). A caller that
   * may RETRY the same redemption — the auto-redeem sweep after a failed
   * attempt — passes one stable id per credit so a request that did reach
   * OpenAI is never counted twice; a one-off caller lets a fresh id be minted.
   */
  redeemRequestId?: string;
}

export async function redeemOpenAiResetCreditForProfile(
  profileId: string,
  creditId: string,
  options: RedeemResetOptions = {},
): Promise<OpenAiResetRedeemResult> {
  return redeemOpenAiResetCredit(
    creditId,
    { readAuth: () => readPiCodexAuth(profileId) },
    options,
  );
}

/** {@link redeemOpenAiResetCreditForProfile} through the gateway, on the server lease. */
export async function redeemOpenAiResetCreditViaGateway(
  profileId: string,
  access: EngineGatewayAccess,
  creditId: string,
  options: RedeemResetOptions = {},
): Promise<OpenAiResetRedeemResult> {
  return redeemOpenAiResetCredit(
    creditId,
    { readAuth: () => readGatewayBackend(profileId, access) },
    options,
  );
}

/**
 * Redeems ONE banked reset credit — IRREVERSIBLE: on a 2xx the credit is spent,
 * exactly like clicking the button in the ChatGPT app.
 *
 * By default a safety guard re-checks `/wham/usage` first and refuses unless a
 * reset is currently applicable (`applicable_available_count > 0`), since
 * redeeming when no window is hit may waste the credit; `notApplicable`
 * distinguishes that guarded refusal (→ HTTP 409) from other failures. The
 * guard is opt-out ({@link RedeemResetOptions}) for a deliberate redemption
 * and for a credit that is about to expire.
 */
export async function redeemOpenAiResetCredit(
  creditId: string,
  deps: Partial<OpenAiUsageDeps> = {},
  options: RedeemResetOptions = {},
): Promise<OpenAiResetRedeemResult> {
  const { readAuth, fetchUsage, postConsume, newRequestId } = {
    ...DEFAULT_DEPS,
    ...deps,
  };
  const trimmed = creditId.trim();
  if (!trimmed) throw new Error("A credit id is required to redeem a reset.");

  const auth = await readAuth();
  if (!auth)
    throw new Error(
      "Not signed in to this OpenAI profile. Connect it in Settings.",
    );

  if (options.requireApplicable ?? true) {
    const usage = await fetchUsage(auth);
    throwGatewayRefusal(usage.body);
    if (usage.status === 401 || usage.status === 403) {
      throw new Error(
        "OpenAI rejected this profile login token. Reconnect it in Settings.",
      );
    }
    const applicable = applicableResetCount(usage.body);
    if (!applicable || applicable <= 0) {
      const err = new Error(
        "No reset is applicable right now — you are not currently rate-limited, so redeeming would waste the credit.",
      ) as Error & { notApplicable?: boolean };
      err.notApplicable = true;
      throw err;
    }
  }

  const { status, body } = await postConsume(
    auth,
    trimmed,
    options.redeemRequestId ?? newRequestId(),
  );
  throwGatewayRefusal(body);
  if (status === 401 || status === 403) {
    throw new Error(
      "OpenAI rejected this profile login token. Reconnect it in Settings.",
    );
  }
  if (status < 200 || status >= 300) {
    throw new Error(`Redeeming the reset credit failed (HTTP ${status}).`);
  }
  const obj =
    body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  const credit =
    obj.credit && typeof obj.credit === "object"
      ? (obj.credit as Record<string, unknown>)
      : null;
  const windowsReset = numberOrNull(obj.windows_reset);
  const code = stringOrNull(obj.code);
  return {
    ok:
      (windowsReset ?? 0) > 0 ||
      code === "reset" ||
      stringOrNull(credit?.status) === "redeemed",
    code,
    windowsReset,
    creditId: stringOrNull(credit?.id) ?? trimmed,
    redeemedAt: stringOrNull(credit?.redeemed_at),
  };
}
