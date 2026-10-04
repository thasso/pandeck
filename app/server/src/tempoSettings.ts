import { randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import type {
  TempoConnectionStatus,
  TempoSettings,
  TempoSettingsPatch,
} from "@assistant/shared";
import {
  DATA_DIR,
  JIRA_HOST,
  PORT,
  PUBLIC_BASE_URL,
  TEMPO_OAUTH_CLIENT_ID,
  TEMPO_OAUTH_CLIENT_SECRET,
} from "./config.ts";
import { getJiraCredsIfAvailable } from "./jiraSettings.ts";
import type { JiraApiConfig } from "./jiraClient.ts";
import { jiraGet } from "./jiraClient.ts";
import { errorText, fileReadErrorText } from "./errors.ts";

const TEMPO_SETTINGS_PATH = join(DATA_DIR, "settings", "tempo.json");
const TEMPO_OAUTH_CALLBACK_PATH = "/api/tempo/oauth/callback";

// Tempo OAuth 2.0 (authorization code): the authorize step is hosted on the Atlassian
// instance (JIRA_HOST) via the Tempo Connect app; the token step is on api.tempo.io.
// Tempo uses `access_type` instead of OAuth scopes; tenant_user authorizes as the user.
const TEMPO_AUTHORIZE_PATH =
  "/plugins/servlet/ac/io.tempo.jira/oauth-authorize/";
const TEMPO_TOKEN_URL = "https://api.tempo.io/oauth/token/";
const TEMPO_ACCESS_TYPE = "tenant_user";

const DEFAULT_API_BASE_URL = "https://api.tempo.io/4";

const DEFAULTS = {
  enabled: false,
  apiBaseUrl: DEFAULT_API_BASE_URL,
  accessToken: "",
  refreshToken: "",
  accessTokenExpiresAt: 0,
  oauthState: "",
  oauthStateCreatedAt: 0,
  oauthRedirectUri: "",
  authorAccountId: "",
};

interface TempoSettingsFile {
  enabled?: boolean;
  apiBaseUrl?: string;
  accessToken?: string;
  refreshToken?: string;
  accessTokenExpiresAt?: number;
  oauthState?: string;
  oauthStateCreatedAt?: number;
  oauthRedirectUri?: string;
  authorAccountId?: string;
}

type StoredTempoSettings = Required<TempoSettingsFile>;

/**
 * Composed Tempo tool config: the Tempo OAuth bearer + API base + author id, plus the
 * Jira credentials (from the Jira integration) used for worklog issue enrichment. `jira`
 * is null when the Jira integration is disabled/unconfigured so tools can degrade.
 */
export interface TempoToolConfig {
  apiBaseUrl: string;
  accessToken: string;
  authorAccountId: string;
  jira: JiraApiConfig | null;
}

/** Fields that only existed in the obsolete combined Jira+Tempo `tempo.json`. */
const LEGACY_COMBINED_KEYS = [
  "tempoToken",
  "atlassianEmail",
  "atlassianToken",
  "jiraHost",
] as const;

/** True when a parsed file still carries any obsolete combined-shape field. */
function isLegacyCombinedFile(
  parsed: Record<string, unknown> | null | undefined,
): boolean {
  if (!parsed || typeof parsed !== "object") return false;
  return LEGACY_COMBINED_KEYS.some((key) => key in parsed);
}

function normalizeStored(
  parsed: TempoSettingsFile | undefined,
): StoredTempoSettings {
  return {
    enabled: Boolean(parsed?.enabled ?? DEFAULTS.enabled),
    apiBaseUrl: cleanUrl(
      parsed?.apiBaseUrl ?? DEFAULTS.apiBaseUrl,
      DEFAULTS.apiBaseUrl,
    ),
    accessToken:
      typeof parsed?.accessToken === "string"
        ? parsed.accessToken
        : DEFAULTS.accessToken,
    refreshToken:
      typeof parsed?.refreshToken === "string"
        ? parsed.refreshToken
        : DEFAULTS.refreshToken,
    accessTokenExpiresAt:
      typeof parsed?.accessTokenExpiresAt === "number"
        ? parsed.accessTokenExpiresAt
        : DEFAULTS.accessTokenExpiresAt,
    oauthState:
      typeof parsed?.oauthState === "string"
        ? parsed.oauthState
        : DEFAULTS.oauthState,
    oauthStateCreatedAt:
      typeof parsed?.oauthStateCreatedAt === "number"
        ? parsed.oauthStateCreatedAt
        : DEFAULTS.oauthStateCreatedAt,
    oauthRedirectUri:
      typeof parsed?.oauthRedirectUri === "string"
        ? parsed.oauthRedirectUri
        : DEFAULTS.oauthRedirectUri,
    authorAccountId:
      typeof parsed?.authorAccountId === "string"
        ? parsed.authorAccountId
        : DEFAULTS.authorAccountId,
  };
}

function readPrivate(): StoredTempoSettings {
  if (!existsSync(TEMPO_SETTINGS_PATH)) return { ...DEFAULTS };
  try {
    const parsed = JSON.parse(readFileSync(TEMPO_SETTINGS_PATH, "utf8")) as
      (TempoSettingsFile & Record<string, unknown>) | null;
    // No migration from the combined Jira+Tempo shape (Task-32 locked decision: wipe
    // stale state, start clean). If the file still carries any obsolete combined field,
    // discard the whole thing and start from fresh Tempo defaults rather than retaining
    // enabled/apiBaseUrl/authorAccountId as if they were current Tempo state.
    if (isLegacyCombinedFile(parsed)) return { ...DEFAULTS };
    return normalizeStored(parsed ?? undefined);
  } catch (err) {
    throw new Error(
      `Failed to read Tempo settings at ${TEMPO_SETTINGS_PATH}: ${fileReadErrorText(err)}`,
    );
  }
}

function writePrivate(next: StoredTempoSettings): void {
  mkdirSync(dirname(TEMPO_SETTINGS_PATH), { recursive: true });
  const tmp = `${TEMPO_SETTINGS_PATH}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  renameSync(tmp, TEMPO_SETTINGS_PATH);
}

function tempoOAuthClient(): {
  clientId: string;
  clientSecret: string;
  configured: boolean;
} {
  const clientId = TEMPO_OAUTH_CLIENT_ID.trim();
  const clientSecret = TEMPO_OAUTH_CLIENT_SECRET.trim();
  return {
    clientId,
    clientSecret,
    configured: Boolean(clientId && clientSecret),
  };
}

function tempoOAuthRedirectUri(publicBaseUrl?: string): string {
  const baseUrl = cleanBaseUrl(
    publicBaseUrl || PUBLIC_BASE_URL || `http://localhost:${PORT}`,
  );
  return `${baseUrl}${TEMPO_OAUTH_CALLBACK_PATH}`;
}

function publicSettings(
  settings: StoredTempoSettings,
  publicBaseUrl?: string,
): TempoSettings {
  return {
    enabled: Boolean(settings.enabled),
    apiBaseUrl: settings.apiBaseUrl || DEFAULT_API_BASE_URL,
    redirectUri: tempoOAuthRedirectUri(publicBaseUrl),
    oauthClientConfigured: tempoOAuthClient().configured,
    refreshTokenConfigured: Boolean(settings.refreshToken),
    authorAccountId: settings.authorAccountId || "",
  };
}

export function getTempoSettings(publicBaseUrl?: string): TempoSettings {
  return publicSettings(readPrivate(), publicBaseUrl);
}

export function updateTempoSettings(
  patch: TempoSettingsPatch,
  publicBaseUrl?: string,
): TempoSettings {
  const current = readPrivate();
  const clearTokens = patch.clearTokens === true;
  const next: StoredTempoSettings = {
    ...current,
    enabled: patch.enabled ?? current.enabled,
    apiBaseUrl: cleanUrl(
      patch.apiBaseUrl ?? current.apiBaseUrl,
      DEFAULT_API_BASE_URL,
    ),
    accessToken: clearTokens ? "" : current.accessToken,
    refreshToken: clearTokens ? "" : current.refreshToken,
    accessTokenExpiresAt: clearTokens ? 0 : current.accessTokenExpiresAt,
    oauthState: clearTokens ? "" : current.oauthState,
    oauthStateCreatedAt: clearTokens ? 0 : current.oauthStateCreatedAt,
    oauthRedirectUri: clearTokens ? "" : current.oauthRedirectUri,
    authorAccountId: clearTokens ? "" : current.authorAccountId,
  };
  writePrivate(next);
  return publicSettings(next, publicBaseUrl);
}

/**
 * Composed Tempo credentials for tools. Throws when Tempo is disabled or not authorized.
 * Refreshes the OAuth access token on demand. The Jira credentials for enrichment are
 * attached when the Jira integration is configured, and null otherwise (tools degrade to
 * raw issue ids).
 */
export async function getTempoToolConfig(): Promise<TempoToolConfig> {
  const settings = readPrivate();
  if (!settings.enabled)
    throw new Error(
      "Tempo tools are disabled. Enable them in Settings → Tempo.",
    );
  if (!settings.accessToken && !settings.refreshToken) {
    throw new Error(
      "Tempo is not authorized yet. Connect Tempo from Settings → Tempo.",
    );
  }
  const accessToken = await ensureTempoAccessToken(settings);
  if (!accessToken)
    throw new Error(
      "Tempo is not authorized yet. Connect Tempo from Settings → Tempo.",
    );
  return {
    apiBaseUrl: settings.apiBaseUrl || DEFAULT_API_BASE_URL,
    accessToken,
    authorAccountId: settings.authorAccountId,
    jira: getJiraCredsIfAvailable(),
  };
}

/**
 * Return a valid Tempo access token, refreshing via the refresh token when the current
 * one is missing or within 60s of expiry. Persists refreshed tokens back to tempo.json.
 */
async function ensureTempoAccessToken(
  settings: StoredTempoSettings = readPrivate(),
): Promise<string> {
  if (
    settings.accessToken &&
    settings.accessTokenExpiresAt > Date.now() + 60_000
  )
    return settings.accessToken;
  if (!settings.refreshToken) return settings.accessToken;
  const oauth = tempoOAuthClient();
  const token = await tempoTokenRequest({
    grant_type: "refresh_token",
    client_id: oauth.clientId,
    client_secret: oauth.clientSecret,
    redirect_uri: settings.oauthRedirectUri || tempoOAuthRedirectUri(),
    refresh_token: settings.refreshToken,
  });
  // A 2xx response with no usable access_token/expires_in must fail loudly rather than
  // returning the already-expired token, so tools/testTempoSettings surface reconnect
  // guidance instead of retrying with a stale bearer.
  if (!token.access_token || !token.expires_in || token.expires_in <= 0) {
    throw new Error(
      "Tempo token refresh response was missing a valid access_token or expires_in. Reconnect Tempo from Settings → Tempo.",
    );
  }
  const fresh = readPrivate();
  fresh.accessToken = token.access_token;
  fresh.accessTokenExpiresAt = Date.now() + token.expires_in * 1000;
  if (token.refresh_token) fresh.refreshToken = token.refresh_token;
  writePrivate(fresh);
  // Keep the caller's snapshot consistent with what we just persisted.
  settings.accessToken = fresh.accessToken;
  settings.accessTokenExpiresAt = fresh.accessTokenExpiresAt;
  settings.refreshToken = fresh.refreshToken;
  return fresh.accessToken;
}

export function createTempoOAuthStartUrl(publicBaseUrl?: string): string {
  const oauth = tempoOAuthClient();
  if (!oauth.configured) {
    throw new Error(
      "Configure a Tempo OAuth client id and secret in app config before connecting Tempo.",
    );
  }
  if (!JIRA_HOST)
    throw new Error(
      "Configure the Atlassian site (jira.host in app config) before connecting Tempo.",
    );
  const state = randomBytes(24).toString("base64url");
  const settings = readPrivate();
  const redirectUri = tempoOAuthRedirectUri(publicBaseUrl);
  settings.oauthState = state;
  settings.oauthStateCreatedAt = Date.now();
  settings.oauthRedirectUri = redirectUri;
  writePrivate(settings);

  const url = new URL(`https://${JIRA_HOST}${TEMPO_AUTHORIZE_PATH}`);
  url.searchParams.set("client_id", oauth.clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("access_type", TEMPO_ACCESS_TYPE);
  url.searchParams.set("state", state);
  return url.toString();
}

export async function handleTempoOAuthCallback(
  query: URLSearchParams,
  publicBaseUrl?: string,
): Promise<{ ok: boolean; message: string }> {
  const error = query.get("error");
  if (error) return { ok: false, message: `Tempo OAuth failed: ${error}` };
  const code = query.get("code");
  const state = query.get("state");
  if (!code || !state)
    return {
      ok: false,
      message: "Tempo OAuth callback was missing code or state.",
    };

  const settings = readPrivate();
  const stateAgeMs = Date.now() - settings.oauthStateCreatedAt;
  if (
    !settings.oauthState ||
    state !== settings.oauthState ||
    stateAgeMs > 10 * 60 * 1000
  ) {
    return {
      ok: false,
      message:
        "Tempo OAuth state did not match or has expired. Please try again from Settings.",
    };
  }

  const oauth = tempoOAuthClient();
  const token = await tempoTokenRequest({
    grant_type: "authorization_code",
    client_id: oauth.clientId,
    client_secret: oauth.clientSecret,
    redirect_uri:
      settings.oauthRedirectUri || tempoOAuthRedirectUri(publicBaseUrl),
    code,
  });
  settings.accessToken = token.access_token || "";
  settings.refreshToken = token.refresh_token || settings.refreshToken;
  settings.accessTokenExpiresAt = token.expires_in
    ? Date.now() + token.expires_in * 1000
    : 0;
  settings.oauthState = "";
  settings.oauthStateCreatedAt = 0;
  writePrivate(settings);

  if (!settings.accessToken) {
    return {
      ok: false,
      message:
        "Tempo did not return an access token. Please try connecting again.",
    };
  }
  return {
    ok: true,
    message: settings.refreshToken
      ? "Tempo authorized."
      : "Tempo authorized (no refresh token was returned; you may need to reconnect when the token expires).",
  };
}

interface TempoTokenResponse {
  access_token?: string;
  token_type?: string;
  expires_in?: number;
  refresh_token?: string;
  error?: string;
  error_description?: string;
}

async function tempoTokenRequest(
  params: Record<string, string>,
): Promise<TempoTokenResponse> {
  const res = await fetch(TEMPO_TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: new URLSearchParams(params),
    signal: AbortSignal.timeout(15_000),
  });
  const json = (await res.json().catch(() => ({}))) as TempoTokenResponse;
  if (!res.ok)
    throw new Error(
      `Tempo OAuth token endpoint returned HTTP ${res.status}: ${(json.error_description || json.error || JSON.stringify(json)).slice(0, 400)}`,
    );
  return json;
}

/**
 * Resolve the Tempo worklog author's Jira accountId, caching it in tempo.json. Requires
 * the Jira integration: worklog author identity comes from Jira `/myself`. Throws a clear
 * message when Jira is unavailable so callers that need an author id fail fast.
 */
export async function resolveTempoAuthorAccountId(
  config: TempoToolConfig,
): Promise<string> {
  if (config.authorAccountId) return config.authorAccountId;
  if (!config.jira) {
    throw new Error(
      "Resolving the Tempo worklog author requires the Jira integration. Enable and configure it in Settings → Jira.",
    );
  }
  const me = await jiraGet<{ accountId?: string }>(
    config.jira,
    "/rest/api/3/myself",
  );
  if (!me.accountId)
    throw new Error(
      "Could not resolve the Jira accountId for the Tempo worklog author.",
    );
  const settings = readPrivate();
  settings.authorAccountId = me.accountId;
  writePrivate(settings);
  config.authorAccountId = me.accountId;
  return me.accountId;
}

export async function testTempoSettings(): Promise<TempoConnectionStatus> {
  const settings = readPrivate();
  const checkedAt = Date.now();
  if (!tempoOAuthClient().configured) {
    return {
      ok: false,
      checkedAt,
      message:
        "Missing Tempo OAuth client ID or secret. Configure the client ID in the app config (ASSISTANT_CONFIG) and the secret in ASSISTANT_TEMPO_OAUTH_CLIENT_SECRET.",
    };
  }
  if (!settings.accessToken && !settings.refreshToken) {
    return {
      ok: false,
      checkedAt,
      message:
        "Tempo is not authorized yet. Connect Tempo from Settings → Tempo.",
    };
  }
  let accessToken: string;
  try {
    accessToken = await ensureTempoAccessToken(settings);
  } catch (err) {
    return {
      ok: false,
      checkedAt,
      message: `Tempo token refresh failed: ${errorText(err)}. Try reconnecting Tempo from Settings → Tempo.`,
    };
  }
  if (!accessToken) {
    return {
      ok: false,
      checkedAt,
      message:
        "Tempo is not authorized yet. Connect Tempo from Settings → Tempo.",
    };
  }
  const today = new Date().toISOString().slice(0, 10);
  const url = new URL(
    `${(settings.apiBaseUrl || DEFAULT_API_BASE_URL).replace(/\/$/, "")}/worklogs`,
  );
  url.searchParams.set("from", today);
  url.searchParams.set("to", today);
  url.searchParams.set("limit", "1");
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json",
    },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    return {
      ok: false,
      checkedAt,
      message: `Tempo API returned HTTP ${res.status}: ${(await res.text()).slice(0, 240)}`,
    };
  }
  return { ok: true, checkedAt, message: "Tempo authorization looks good." };
}

function cleanUrl(value: string, fallback: string): string {
  const trimmed = value.trim() || fallback;
  try {
    const url = new URL(trimmed);
    return url.toString().replace(/\/$/, "");
  } catch {
    return fallback;
  }
}

function cleanBaseUrl(value: string): string {
  const trimmed = value.trim() || `http://localhost:${PORT}`;
  try {
    const url = new URL(trimmed);
    url.pathname = url.pathname.replace(/\/+$/, "");
    url.search = "";
    url.hash = "";
    return url.toString().replace(/\/$/, "");
  } catch {
    return `http://localhost:${PORT}`;
  }
}
