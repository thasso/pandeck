/**
 * Claude account usage through the credential gateway (G4b), with no CLI
 * child: one `GET /anthropic/api/oauth/usage` on the profile's server lease.
 * The gateway puts the profile's access token on it and nothing refreshes it.
 * The server reads the profile's `.credentials.json` only for its
 * `subscriptionType` label (RD-G4-4), never a token.
 *
 * The raw body is translated as the CLI's usage control request does
 * (`mapClaudeUsageResponse`); a body without a recognisable 5-hour or weekly
 * window is unavailable usage, never a credential state.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ClaudeUsageSnapshot } from "@assistant/shared/usage";
import { claudeConfigDir } from "../credentialProfiles.ts";
import { gatewayRefusalText } from "../providerErrors.ts";
import type { EngineGatewayAccess } from "../workerProtocol/engineMethods.ts";
import {
  CLAUDE_USAGE_TIMEOUT_TEXT,
  mapClaudeUsageResponse,
} from "./usageQuery.ts";

/** Injectable dependencies so tests never touch the real filesystem or network. */
export interface ClaudeGatewayUsageDeps {
  readSubscriptionType: (profileId: string) => Promise<string | null>;
  fetch: typeof fetch;
  now: () => number;
}

/** The profile's `claudeAiOauth.subscriptionType`, or null; never anything else. */
export async function readClaudeSubscriptionType(
  profileId: string,
): Promise<string | null> {
  try {
    const parsed: unknown = JSON.parse(
      await readFile(
        join(claudeConfigDir(profileId), ".credentials.json"),
        "utf8",
      ),
    );
    const oauth = (parsed as { claudeAiOauth?: unknown } | null)?.claudeAiOauth;
    const label =
      oauth && typeof oauth === "object"
        ? (oauth as { subscriptionType?: unknown }).subscriptionType
        : undefined;
    return typeof label === "string" ? label : null;
  } catch {
    return null;
  }
}

const DEFAULT_DEPS: ClaudeGatewayUsageDeps = {
  readSubscriptionType: readClaudeSubscriptionType,
  // Looked up per call, so a test's stubbed global is the one used.
  fetch: (input, init) => fetch(input, init),
  now: () => Date.now(),
};

/** U-G4b-1's text for an upstream non-2xx the gateway did not answer itself. */
function usageFailureText(status: number): string {
  return status === 401
    ? "Claude did not accept the usage request."
    : `Claude usage request failed (HTTP ${status}).`;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isWindow(value: unknown): boolean {
  return (
    isObject(value) &&
    (value.utilization === null ||
      (typeof value.utilization === "number" &&
        Number.isFinite(value.utilization))) &&
    (value.resets_at === undefined ||
      value.resets_at === null ||
      typeof value.resets_at === "string")
  );
}

/** The CLI's usability check, narrowed to the two windows every reader uses. */
function isRecognisedShape(body: unknown): body is Record<string, unknown> {
  if (!isObject(body)) return false;
  const slot = (value: unknown): boolean =>
    value === undefined || value === null || isWindow(value);
  return (
    slot(body.five_hour) &&
    slot(body.seven_day) &&
    (isWindow(body.five_hour) || isWindow(body.seven_day))
  );
}

/** A numeric `resets_at` is epoch seconds; a string is kept verbatim. */
function resetOf(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  const date = new Date(value * 1000);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/**
 * The CLI's `model_scoped` rows from `limits[]`: every `weekly_scoped` row
 * naming a model. The CLI's feature-flag allowlist is not reproduced.
 */
function modelScopedOf(limits: unknown): Record<string, unknown>[] {
  if (!Array.isArray(limits)) return [];
  return limits.flatMap((row: unknown) => {
    if (!isObject(row) || row.kind !== "weekly_scoped") return [];
    const scope = isObject(row.scope) ? row.scope : undefined;
    const model = scope && isObject(scope.model) ? scope.model : undefined;
    if (typeof model?.display_name !== "string") return [];
    return [
      {
        display_name: model.display_name,
        utilization: row.percent ?? null,
        resets_at: resetOf(row.resets_at),
      },
    ];
  });
}

const NO_SESSION: ClaudeUsageSnapshot["session"] = {
  totalCostUsd: 0,
  totalApiDurationMs: 0,
  totalDurationMs: 0,
};

/** The raw `/api/oauth/usage` body as the CLI's usage control request reports it. */
export function mapClaudeUsageBody(
  body: unknown,
  subscriptionType: string | null,
  fetchedAt: number,
): ClaudeUsageSnapshot {
  if (!isRecognisedShape(body))
    return {
      fetchedAt,
      subscriptionType,
      rateLimitsAvailable: false,
      fiveHour: null,
      weekly: null,
      limits: [],
      modelScoped: [],
      extraUsage: null,
      session: NO_SESSION,
    };
  return {
    ...mapClaudeUsageResponse({
      subscription_type: subscriptionType,
      rate_limits_available: true,
      rate_limits: { ...body, model_scoped: modelScopedOf(body.limits) },
      session: {},
    }),
    fetchedAt,
  };
}

/**
 * The profile's usage on its server lease. A refusal the gateway answered
 * itself throws its text whatever the status; any other non-2xx throws
 * U-G4b-1's text, never the upstream's own prose. Nothing is retried.
 */
export async function fetchClaudeUsageViaGateway(
  profileId: string,
  access: EngineGatewayAccess,
  timeoutMs: number,
  deps: Partial<ClaudeGatewayUsageDeps> = {},
): Promise<ClaudeUsageSnapshot> {
  const { readSubscriptionType, fetch, now } = { ...DEFAULT_DEPS, ...deps };
  const subscriptionType = await readSubscriptionType(profileId);
  const signal = AbortSignal.timeout(timeoutMs);
  let status: number;
  let body: unknown;
  try {
    const res = await fetch(`${access.baseUrl}/anthropic/api/oauth/usage`, {
      headers: {
        Authorization: `Bearer ${access.leaseToken}`,
        "anthropic-beta": "oauth-2025-04-20",
        Accept: "application/json",
        "User-Agent": "personal-assistant",
      },
      signal,
    });
    status = res.status;
    const text = await res.text();
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  } catch (err) {
    // The signal is the timeout's alone, whatever error a runtime raises.
    if (signal.aborted) throw new Error(CLAUDE_USAGE_TIMEOUT_TEXT);
    throw err instanceof Error ? err : new Error(String(err));
  }
  const refusal = gatewayRefusalText(body);
  if (refusal !== undefined) throw new Error(refusal);
  if (status < 200 || status > 299) throw new Error(usageFailureText(status));
  return mapClaudeUsageBody(body, subscriptionType, now());
}
