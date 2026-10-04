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
  GoogleConnectionStatus,
  GoogleSettings,
  GoogleSettingsPatch,
} from "@assistant/shared";
import {
  DATA_DIR,
  GOOGLE_OAUTH_CLIENT_ID,
  GOOGLE_OAUTH_CLIENT_SECRET,
  PORT,
  PUBLIC_BASE_URL,
} from "./config.ts";
import { errorText, fileReadErrorText } from "./errors.ts";

const GOOGLE_SETTINGS_PATH = join(DATA_DIR, "settings", "google.json");
const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_OAUTH_CALLBACK_PATH = "/api/google/oauth/callback";
const GMAIL_MODIFY_SCOPE = "https://www.googleapis.com/auth/gmail.modify";

const GOOGLE_SCOPES = [
  "https://www.googleapis.com/auth/calendar.readonly",
  // gmail.modify is the narrow Gmail scope that permits archiving by removing
  // INBOX while retaining the existing read/search access. It cannot delete
  // messages permanently.
  GMAIL_MODIFY_SCOPE,
  "https://www.googleapis.com/auth/drive.readonly",
  "https://www.googleapis.com/auth/meetings.space.readonly",
  // Profile: lets `people/me` resolve the connected user's display name/id so we
  // can reliably identify OUR OWN participation among Meet attendees (Task 171).
  // Granted only after a Google reconnect; without it no conference can be
  // self-matched, so attendance stays UNCONFIRMED rather than being inferred from
  // an accepted invitation plus a conference that happened (Task 224).
  "https://www.googleapis.com/auth/userinfo.profile",
] as const;

const DEFAULTS = {
  enabled: false,
  accountEmail: "",
  refreshToken: "",
  accessToken: "",
  accessTokenExpiresAt: 0,
  grantedScopes: [] as string[],
  oauthState: "",
  oauthStateCreatedAt: 0,
  oauthRedirectUri: "",
  gmailMinutesLabelName: "Minutes",
};

interface GoogleSettingsFile {
  enabled?: boolean;
  accountEmail?: string;
  refreshToken?: string;
  accessToken?: string;
  accessTokenExpiresAt?: number;
  grantedScopes?: string[];
  oauthState?: string;
  oauthStateCreatedAt?: number;
  oauthRedirectUri?: string;
  gmailMinutesLabelName?: string;
}

type StoredGoogleSettings = Required<GoogleSettingsFile>;

export interface GoogleToolConfig extends StoredGoogleSettings {
  clientId: string;
  clientSecret: string;
}

function googleOAuthRedirectUri(publicBaseUrl?: string): string {
  const baseUrl = cleanBaseUrl(
    publicBaseUrl || PUBLIC_BASE_URL || `http://localhost:${PORT}`,
  );
  return `${baseUrl}${GOOGLE_OAUTH_CALLBACK_PATH}`;
}

function googleOAuthClient(): {
  clientId: string;
  clientSecret: string;
  configured: boolean;
} {
  const clientId = GOOGLE_OAUTH_CLIENT_ID.trim();
  const clientSecret = GOOGLE_OAUTH_CLIENT_SECRET.trim();
  return {
    clientId,
    clientSecret,
    configured: Boolean(clientId && clientSecret),
  };
}

function withGoogleOAuthClient(
  settings: StoredGoogleSettings,
): GoogleToolConfig {
  const { clientId, clientSecret } = googleOAuthClient();
  return { ...settings, clientId, clientSecret };
}

function normalizeStored(
  parsed: GoogleSettingsFile | undefined,
): StoredGoogleSettings {
  return {
    enabled: Boolean(parsed?.enabled ?? DEFAULTS.enabled),
    accountEmail:
      typeof parsed?.accountEmail === "string"
        ? parsed.accountEmail
        : DEFAULTS.accountEmail,
    refreshToken:
      typeof parsed?.refreshToken === "string"
        ? parsed.refreshToken
        : DEFAULTS.refreshToken,
    accessToken:
      typeof parsed?.accessToken === "string"
        ? parsed.accessToken
        : DEFAULTS.accessToken,
    accessTokenExpiresAt:
      typeof parsed?.accessTokenExpiresAt === "number"
        ? parsed.accessTokenExpiresAt
        : DEFAULTS.accessTokenExpiresAt,
    grantedScopes: Array.isArray(parsed?.grantedScopes)
      ? [
          ...new Set(
            parsed.grantedScopes.filter((scope) => typeof scope === "string"),
          ),
        ]
      : [...DEFAULTS.grantedScopes],
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
    gmailMinutesLabelName: cleanLabel(
      parsed?.gmailMinutesLabelName,
      DEFAULTS.gmailMinutesLabelName,
    ),
  };
}

function readPrivate(): StoredGoogleSettings {
  if (!existsSync(GOOGLE_SETTINGS_PATH)) return { ...DEFAULTS };
  try {
    const parsed = JSON.parse(
      readFileSync(GOOGLE_SETTINGS_PATH, "utf8"),
    ) as GoogleSettingsFile;
    return normalizeStored(parsed);
  } catch (err) {
    throw new Error(
      `Failed to read Google settings at ${GOOGLE_SETTINGS_PATH}: ${fileReadErrorText(err)}`,
    );
  }
}

function writePrivate(next: StoredGoogleSettings): void {
  mkdirSync(dirname(GOOGLE_SETTINGS_PATH), { recursive: true });
  const tmp = `${GOOGLE_SETTINGS_PATH}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  renameSync(tmp, GOOGLE_SETTINGS_PATH);
}

function publicSettings(
  settings: StoredGoogleSettings,
  publicBaseUrl?: string,
): GoogleSettings {
  const oauthClient = googleOAuthClient();
  return {
    enabled: Boolean(settings.enabled),
    redirectUri: googleOAuthRedirectUri(publicBaseUrl),
    accountEmail: settings.accountEmail || "",
    scopes: [...GOOGLE_SCOPES],
    oauthClientConfigured: oauthClient.configured,
    refreshTokenConfigured: Boolean(settings.refreshToken),
    gmailArchiveAuthorized: settings.grantedScopes.includes(GMAIL_MODIFY_SCOPE),
    gmailMinutesLabelName: cleanLabel(
      settings.gmailMinutesLabelName,
      DEFAULTS.gmailMinutesLabelName,
    ),
  };
}

export function getGoogleSettings(publicBaseUrl?: string): GoogleSettings {
  return publicSettings(readPrivate(), publicBaseUrl);
}

/** True when Google Workspace is enabled, has OAuth client creds, and is authorized. */
export function isGoogleConfigured(): boolean {
  const settings = readPrivate();
  return Boolean(
    settings.enabled && googleOAuthClient().configured && settings.refreshToken,
  );
}

export function updateGoogleSettings(
  patch: GoogleSettingsPatch,
): GoogleSettings {
  const current = readPrivate();
  const clearTokens = patch.clearTokens === true;
  const next: StoredGoogleSettings = {
    ...current,
    enabled: patch.enabled ?? current.enabled,
    accountEmail: clearTokens ? "" : current.accountEmail,
    refreshToken: clearTokens ? "" : current.refreshToken,
    accessToken: clearTokens ? "" : current.accessToken,
    accessTokenExpiresAt: clearTokens ? 0 : current.accessTokenExpiresAt,
    grantedScopes: clearTokens ? [] : current.grantedScopes,
    oauthState: clearTokens ? "" : current.oauthState,
    oauthStateCreatedAt: clearTokens ? 0 : current.oauthStateCreatedAt,
    oauthRedirectUri: clearTokens ? "" : current.oauthRedirectUri,
    gmailMinutesLabelName: cleanLabel(
      patch.gmailMinutesLabelName ?? current.gmailMinutesLabelName,
      DEFAULTS.gmailMinutesLabelName,
    ),
  };
  writePrivate(next);
  return publicSettings(next);
}

export function getGoogleToolConfig(): GoogleToolConfig {
  const settings = readPrivate();
  const oauthClient = googleOAuthClient();
  if (!settings.enabled)
    throw new Error(
      "Google Workspace tools are disabled. Enable them in Settings → Google Workspace.",
    );
  if (!oauthClient.configured) {
    throw new Error(
      "Missing Google OAuth client ID or secret. Configure the client ID in the app config (ASSISTANT_CONFIG) and the secret in ASSISTANT_GOOGLE_OAUTH_CLIENT_SECRET.",
    );
  }
  if (!settings.refreshToken) {
    throw new Error(
      "Google Workspace is not authorized yet. Connect Google Workspace from Settings → Google Workspace.",
    );
  }
  return {
    ...settings,
    clientId: oauthClient.clientId,
    clientSecret: oauthClient.clientSecret,
  };
}

export function createGoogleOAuthStartUrl(publicBaseUrl?: string): string {
  const oauthClient = googleOAuthClient();
  if (!oauthClient.configured) {
    throw new Error(
      "Configure a Google OAuth client ID and secret in app config before starting OAuth.",
    );
  }
  const state = randomBytes(24).toString("base64url");
  const settings = readPrivate();
  const redirectUri = googleOAuthRedirectUri(publicBaseUrl);
  settings.oauthState = state;
  settings.oauthStateCreatedAt = Date.now();
  settings.oauthRedirectUri = redirectUri;
  writePrivate(settings);

  const url = new URL(GOOGLE_AUTH_URL);
  url.searchParams.set("client_id", oauthClient.clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", GOOGLE_SCOPES.join(" "));
  url.searchParams.set("access_type", "offline");
  url.searchParams.set("prompt", "consent");
  url.searchParams.set("include_granted_scopes", "true");
  url.searchParams.set("state", state);
  return url.toString();
}

export async function handleGoogleOAuthCallback(
  query: URLSearchParams,
  publicBaseUrl?: string,
): Promise<{ ok: boolean; message: string }> {
  const error = query.get("error");
  if (error) return { ok: false, message: `Google OAuth failed: ${error}` };
  const code = query.get("code");
  const state = query.get("state");
  if (!code || !state)
    return {
      ok: false,
      message: "Google OAuth callback was missing code or state.",
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
        "Google OAuth state did not match or has expired. Please try again from Settings.",
    };
  }

  const token = await exchangeCode(settings, code, publicBaseUrl);
  settings.refreshToken = token.refresh_token || settings.refreshToken;
  settings.accessToken = token.access_token || "";
  settings.accessTokenExpiresAt = token.expires_in
    ? Date.now() + token.expires_in * 1000
    : 0;
  if (token.scope) settings.grantedScopes = parseGoogleScopes(token.scope);
  settings.oauthState = "";
  settings.oauthStateCreatedAt = 0;

  if (!settings.refreshToken) {
    writePrivate(settings);
    return {
      ok: false,
      message:
        "Google did not return a refresh token. Try again; the app requests offline access with consent.",
    };
  }

  const email = await fetchGoogleAccountEmail(
    withGoogleOAuthClient(settings),
  ).catch(() => "");
  if (email) settings.accountEmail = email;
  writePrivate(settings);
  return {
    ok: true,
    message: email
      ? `Google Workspace authorized for ${email}.`
      : "Google Workspace authorized.",
  };
}

export async function testGoogleSettings(): Promise<GoogleConnectionStatus> {
  const settings = readPrivate();
  const checkedAt = Date.now();
  const details: GoogleConnectionStatus = {
    ok: false,
    checkedAt,
    message: "Google Workspace integration check failed.",
    calendar: { ok: false, message: "Not checked." },
    gmail: { ok: false, message: "Not checked." },
    drive: { ok: false, message: "Not checked." },
    meet: { ok: false, message: "Not checked." },
  };

  if (!googleOAuthClient().configured)
    return {
      ...details,
      message: "Missing OAuth client ID or secret in app config.",
    };
  if (!settings.refreshToken)
    return {
      ...details,
      message:
        "OAuth client configured. Connect Google Workspace to authorize this app.",
    };

  const accessToken = await ensureGoogleAccessToken(
    withGoogleOAuthClient(settings),
  );
  const [calendar, gmail, drive, meet] = await Promise.all([
    testCalendar(accessToken),
    testGmail(accessToken, settings.grantedScopes.includes(GMAIL_MODIFY_SCOPE)),
    testDrive(accessToken),
    testMeet(accessToken),
  ]);
  if (gmail.email && !settings.accountEmail) {
    settings.accountEmail = gmail.email;
    writePrivate(settings);
  }
  const ok = calendar.ok && gmail.ok && drive.ok && meet.ok;
  return {
    ok,
    checkedAt,
    message: ok
      ? settings.enabled
        ? "Google Workspace credentials look good."
        : "Google Workspace authorization works. Enable the tools when you want the Assistant to use them."
      : "One or more Google Workspace checks failed.",
    calendar,
    gmail: { ok: gmail.ok, message: gmail.message },
    drive,
    meet,
  };
}

export async function ensureGoogleAccessToken(
  config: GoogleToolConfig = getGoogleToolConfig(),
): Promise<string> {
  if (config.accessToken && config.accessTokenExpiresAt > Date.now() + 60_000)
    return config.accessToken;
  const token = await refreshAccessToken(config);
  const settings = readPrivate();
  // Disconnected or reconnected while the refresh was out: writing back would
  // restore a grant the user removed.
  if (settings.refreshToken !== config.refreshToken) return token.access_token;
  settings.accessToken = token.access_token;
  settings.accessTokenExpiresAt = Date.now() + token.expires_in * 1000;
  if (token.scope) settings.grantedScopes = parseGoogleScopes(token.scope);
  writePrivate(settings);
  config.accessToken = settings.accessToken;
  config.accessTokenExpiresAt = settings.accessTokenExpiresAt;
  config.grantedScopes = settings.grantedScopes;
  return settings.accessToken;
}

async function exchangeCode(
  settings: StoredGoogleSettings,
  code: string,
  publicBaseUrl?: string,
): Promise<GoogleTokenResponse> {
  const oauthClient = googleOAuthClient();
  return tokenRequest({
    code,
    client_id: oauthClient.clientId,
    client_secret: oauthClient.clientSecret,
    redirect_uri:
      settings.oauthRedirectUri || googleOAuthRedirectUri(publicBaseUrl),
    grant_type: "authorization_code",
  });
}

async function refreshAccessToken(
  settings: GoogleToolConfig,
): Promise<
  GoogleTokenResponse &
    Required<Pick<GoogleTokenResponse, "access_token" | "expires_in">>
> {
  const token = await tokenRequest({
    refresh_token: settings.refreshToken,
    client_id: settings.clientId,
    client_secret: settings.clientSecret,
    grant_type: "refresh_token",
  });
  if (!token.access_token || !token.expires_in)
    throw new Error(
      "Google token refresh response was missing access_token or expires_in.",
    );
  return {
    ...token,
    access_token: token.access_token,
    expires_in: token.expires_in,
  };
}

function parseGoogleScopes(value: string | undefined): string[] {
  return [...new Set((value ?? "").split(/\s+/).filter(Boolean))];
}

interface GoogleTokenResponse {
  access_token?: string;
  expires_in?: number;
  refresh_token?: string;
  scope?: string;
  token_type?: string;
  error?: string;
  error_description?: string;
}

async function tokenRequest(
  params: Record<string, string>,
): Promise<GoogleTokenResponse> {
  const res = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: new URLSearchParams(params),
    signal: AbortSignal.timeout(15_000),
  });
  const json = (await res.json().catch(() => ({}))) as GoogleTokenResponse;
  if (!res.ok)
    throw new Error(
      `Google OAuth token endpoint returned HTTP ${res.status}: ${(json.error_description || json.error || JSON.stringify(json)).slice(0, 400)}`,
    );
  return json;
}

async function fetchGoogleAccountEmail(
  settings: GoogleToolConfig,
): Promise<string> {
  const accessToken = await ensureGoogleAccessToken(settings);
  const gmail = await googleGet<{ emailAddress?: string }>(
    "https://gmail.googleapis.com/gmail/v1/users/me/profile",
    accessToken,
  );
  if (gmail.emailAddress) return gmail.emailAddress;
  const drive = await googleGet<{ user?: { emailAddress?: string } }>(
    "https://www.googleapis.com/drive/v3/about?fields=user(emailAddress)",
    accessToken,
  );
  return drive.user?.emailAddress ?? "";
}

async function testCalendar(
  accessToken: string,
): Promise<{ ok: boolean; message: string }> {
  try {
    await googleGet(
      "https://www.googleapis.com/calendar/v3/users/me/calendarList?maxResults=1",
      accessToken,
    );
    return { ok: true, message: "Calendar API read access works." };
  } catch (err) {
    return { ok: false, message: errorText(err) };
  }
}

async function testGmail(
  accessToken: string,
  archiveAuthorized: boolean,
): Promise<{ ok: boolean; message: string; email?: string }> {
  try {
    const profile = await googleGet<{ emailAddress?: string }>(
      "https://gmail.googleapis.com/gmail/v1/users/me/profile",
      accessToken,
    );
    const account = profile.emailAddress ? ` for ${profile.emailAddress}` : "";
    return {
      ok: archiveAuthorized,
      message: archiveAuthorized
        ? `Gmail API read and archive access works${account}.`
        : `Gmail API read access works${account}, but archive permission is missing. Reauthorize Google Workspace.`,
      ...(profile.emailAddress !== undefined
        ? { email: profile.emailAddress }
        : {}),
    };
  } catch (err) {
    return { ok: false, message: errorText(err) };
  }
}

async function testDrive(
  accessToken: string,
): Promise<{ ok: boolean; message: string }> {
  try {
    const about = await googleGet<{
      user?: { displayName?: string; emailAddress?: string };
    }>(
      "https://www.googleapis.com/drive/v3/about?fields=user(displayName,emailAddress)",
      accessToken,
    );
    const user = about.user?.emailAddress || about.user?.displayName;
    return {
      ok: true,
      message: user
        ? `Drive API read access works for ${user}.`
        : "Drive API read access works.",
    };
  } catch (err) {
    return { ok: false, message: errorText(err) };
  }
}

async function testMeet(
  accessToken: string,
): Promise<{ ok: boolean; message: string }> {
  try {
    await googleGet(
      "https://meet.googleapis.com/v2/conferenceRecords?pageSize=1",
      accessToken,
    );
    return {
      ok: true,
      message: "Google Meet API conference record read access works.",
    };
  } catch (err) {
    return { ok: false, message: errorText(err) };
  }
}

async function googleGet<T>(url: string, accessToken: string): Promise<T> {
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json",
    },
    signal: AbortSignal.timeout(15_000),
  });
  const text = await res.text();
  if (!res.ok)
    throw new Error(
      `Google API returned HTTP ${res.status}: ${text.slice(0, 400)}`,
    );
  return text ? (JSON.parse(text) as T) : ({} as T);
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

function cleanLabel(value: string | undefined, fallback: string): string {
  return value?.trim() || fallback;
}
