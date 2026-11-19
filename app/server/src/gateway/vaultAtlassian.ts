/**
 * The vault's Atlassian OAuth 2.0 (3LO) client (Task-1411, plan v02 step 1),
 * modelled on `claudeRenewal.ts`. The code exchange and every refresh go only
 * to `https://auth.atlassian.com/oauth/token` as JSON bodies; the site list
 * only to `https://api.atlassian.com/oauth/token/accessible-resources` with
 * the new access token. A test overrides where to connect, the CA and the
 * deadline, never the URL, `Host` or TLS name, so neither a code, a refresh
 * token, the client secret nor an access token can go anywhere else.
 * Redirects are not followed (`vaultHttps.ts`).
 *
 * Results are typed: `rejected` is Atlassian refusing the grant, `unreachable`
 * everything else, each with a fixed reason for the vault's log (a status, an
 * errno code or a fixed word), never response text or any token.
 */
import type { OAuthClient } from "./integrationClients.ts";
import {
  MAX_EXPIRES_IN_S,
  isToken,
  vaultCall,
  type VaultEndpoint,
} from "./vaultHttps.ts";
import { isAtlassianSite, isCloudId } from "./vaultMethods.ts";

const AUTH_HOST = "auth.atlassian.com";
const API_HOST = "api.atlassian.com";
const TOKEN_PATH = "/oauth/token";
const RESOURCES_PATH = "/oauth/token/accessible-resources";
const MAX_SCOPE_CHARS = 2_048;

/** Where to connect instead of Atlassian's hosts (tests): never the URL. */
export type AtlassianEndpoint = VaultEndpoint;

/** A validated token answer; held in memory only. */
interface AtlassianTokens {
  accessToken: string;
  /** Absent only when Atlassian did not rotate it. */
  refreshToken: string | undefined;
  expiresInS: number;
  scope: string | undefined;
}

type Failure = { kind: "rejected" } | { kind: "unreachable"; code: string };

export type AtlassianTokenResult =
  { kind: "ok"; tokens: AtlassianTokens } | Failure;

export type AtlassianResourcesResult =
  { kind: "ok"; resources: unknown[] } | Failure;

export type SiteChoice =
  | { ok: true; site: string; cloudId: string }
  | { ok: false; site: "missing" | "ambiguous" };

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function parseTokens(body: string): AtlassianTokens | undefined {
  let parsed: Record<string, unknown> | undefined;
  try {
    parsed = record(JSON.parse(body));
  } catch {
    return undefined;
  }
  if (!parsed) return undefined;
  const {
    access_token: access,
    refresh_token: refresh,
    expires_in: expiresIn,
    scope,
  } = parsed;
  if (!isToken(access)) return undefined;
  if (refresh !== undefined && !isToken(refresh)) return undefined;
  if (
    typeof expiresIn !== "number" ||
    !Number.isFinite(expiresIn) ||
    expiresIn <= 0 ||
    expiresIn > MAX_EXPIRES_IN_S
  )
    return undefined;
  if (
    scope !== undefined &&
    (typeof scope !== "string" || scope.length > MAX_SCOPE_CHARS)
  )
    return undefined;
  return {
    accessToken: access,
    refreshToken: refresh,
    expiresInS: expiresIn,
    scope,
  };
}

/**
 * An exchange refusal: a 4xx other than a timeout or rate limit.
 * Refresh has a narrower refusal list: only 400/401/403 reject its grant.
 */
function isExchangeRefusal(status: number): boolean {
  return status >= 400 && status < 500 && status !== 408 && status !== 429;
}

async function tokenGrant(
  grant: Record<string, string>,
  endpoint: AtlassianEndpoint | undefined,
  isRejectedStatus: (status: number) => boolean,
): Promise<AtlassianTokenResult> {
  const body = JSON.stringify(grant);
  const answer = await vaultCall(
    AUTH_HOST,
    {
      method: "POST",
      path: TOKEN_PATH,
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body),
      },
      body,
    },
    endpoint,
  );
  if (answer.kind === "unreachable") return answer;
  if (isRejectedStatus(answer.status)) return { kind: "rejected" };
  if (answer.status < 200 || answer.status >= 300)
    return { kind: "unreachable", code: String(answer.status) };
  const tokens = parseTokens(answer.body);
  return tokens
    ? { kind: "ok", tokens }
    : { kind: "unreachable", code: "bad_response" };
}

/**
 * The authorization-code exchange. An answer without a refresh token (no
 * `offline_access` granted) is `rejected`: the vault could not refresh it.
 */
export async function exchangeAtlassianCode(
  client: OAuthClient,
  grant: { code: string; redirectUri: string },
  endpoint: AtlassianEndpoint | undefined,
): Promise<AtlassianTokenResult> {
  const result = await tokenGrant(
    {
      grant_type: "authorization_code",
      client_id: client.clientId,
      client_secret: client.clientSecret,
      code: grant.code,
      redirect_uri: grant.redirectUri,
    },
    endpoint,
    isExchangeRefusal,
  );
  return result.kind === "ok" && result.tokens.refreshToken === undefined
    ? { kind: "rejected" }
    : result;
}

/** One refresh; Atlassian rotates the refresh token with each. */
export function refreshAtlassian(
  client: OAuthClient,
  refreshToken: string,
  endpoint: AtlassianEndpoint | undefined,
): Promise<AtlassianTokenResult> {
  return tokenGrant(
    {
      grant_type: "refresh_token",
      client_id: client.clientId,
      client_secret: client.clientSecret,
      refresh_token: refreshToken,
    },
    endpoint,
    (status) => status === 400 || status === 401 || status === 403,
  );
}

/** The sites the access token reaches, as Atlassian lists them. */
export async function atlassianResources(
  accessToken: string,
  endpoint: AtlassianEndpoint | undefined,
): Promise<AtlassianResourcesResult> {
  const answer = await vaultCall(
    API_HOST,
    {
      method: "GET",
      path: RESOURCES_PATH,
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${accessToken}`,
      },
    },
    endpoint,
  );
  if (answer.kind === "unreachable") return answer;
  if (answer.status === 401 || answer.status === 403)
    return { kind: "rejected" };
  if (answer.status < 200 || answer.status >= 300)
    return { kind: "unreachable", code: String(answer.status) };
  try {
    const parsed: unknown = JSON.parse(answer.body);
    if (Array.isArray(parsed)) return { kind: "ok", resources: parsed };
  } catch {
    // Below.
  }
  return { kind: "unreachable", code: "bad_response" };
}

/** An entry's site host, lowercase, when it is an Atlassian Cloud site. */
function siteOf(url: unknown): string | undefined {
  if (typeof url !== "string") return undefined;
  try {
    const parsed = new URL(url);
    const host = parsed.host.toLowerCase();
    return parsed.protocol === "https:" && isAtlassianSite(host)
      ? host
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Picks the site from accessible-resources. Entries are grouped into sites by
 * host (Jira and Confluence list one site twice); entries without an Atlassian
 * Cloud host or a UUID id are ignored, and a site whose entries name different
 * ids is ambiguous. With `preset` that site, else the only one.
 */
export function selectAtlassianSite(
  resources: readonly unknown[],
  preset: string | undefined,
): SiteChoice {
  const sites = new Map<string, Set<string>>();
  for (const entry of resources) {
    const fields = record(entry);
    const site = siteOf(fields?.url);
    const id =
      typeof fields?.id === "string" ? fields.id.toLowerCase() : undefined;
    if (!site || !isCloudId(id)) continue;
    const ids = sites.get(site) ?? new Set<string>();
    ids.add(id);
    sites.set(site, ids);
  }
  let site: string;
  if (preset !== undefined) {
    site = preset.toLowerCase();
    if (!sites.has(site)) return { ok: false, site: "missing" };
  } else if (sites.size === 0) return { ok: false, site: "missing" };
  else if (sites.size > 1) return { ok: false, site: "ambiguous" };
  else site = [...sites.keys()][0]!;
  const ids = sites.get(site)!;
  if (ids.size !== 1) return { ok: false, site: "ambiguous" };
  return { ok: true, site, cloudId: [...ids][0]! };
}
