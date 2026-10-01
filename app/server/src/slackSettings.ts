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
  SlackConnectionStatus,
  SlackHuddleConnectionStatus,
  SlackSettings,
  SlackSettingsPatch,
} from "@assistant/shared";
import {
  DATA_DIR,
  PORT,
  PUBLIC_BASE_URL,
  SLACK_STATIC_CONFIG,
} from "./config.ts";
import { errorText } from "./errors.ts";
import { userTimeZone } from "./userProfile.ts";

const SLACK_SETTINGS_PATH = join(DATA_DIR, "settings", "slack.json");
const SLACK_HUDDLE_SETTINGS_PATH = join(
  DATA_DIR,
  "settings",
  "slack-huddles.json",
);
const SLACK_SETTINGS_RESPONSE_LIMIT_BYTES = 256_000;
const SLACK_SETTINGS_REQUEST_TIMEOUT_MS = 15_000;

/** A deployment-pinned Slack zone, else the user's profile timezone. */
function slackTimeZone(): string {
  return (
    process.env.SLACK_TIMEZONE || SLACK_STATIC_CONFIG.timezone || userTimeZone()
  );
}

const DEFAULTS = {
  enabled: false,
  userToken: "",
  botToken: "",
  accountUserId: "",
  botUserId: "",
  grantedUserScopes: "",
  grantedBotScopes: "",
  oauthState: "",
  oauthStateCreatedAt: 0,
};

const HUDDLE_DEFAULTS = {
  enabled: false,
  clientToken: "",
  clientCookieD: "",
};

interface SlackSettingsFile {
  enabled?: boolean;
  userToken?: string;
  botToken?: string;
  accountUserId?: string;
  botUserId?: string;
  grantedUserScopes?: string;
  grantedBotScopes?: string;
  oauthState?: string;
  oauthStateCreatedAt?: number;
  clientToken?: string;
  clientCookieD?: string;
}

export interface SlackPublicApiConfig {
  enabled: boolean;
  token: string;
  tokenMode: "user";
  workspaceHost: string;
  teamId: string;
  timezone: string;
  defaultMaxResults: number;
  grantedUserScopes: string[];
  source: string;
}

export interface SlackToolConfig {
  enabled: boolean;
  token: string;
  tokenMode: "user" | "bot";
  workspaceHost: string;
  teamId: string;
  timezone: string;
  defaultMaxResults: number;
  userTokenConfigured: boolean;
  botTokenConfigured: boolean;
  source: string;
}

/**
 * Non-throwing config for the day-scan Slack SIGNAL collector (Task 140). Unlike
 * `getSlackPublicApiConfig`, it returns null when Slack is disabled/unconfigured
 * (readiness → skipped, not failed) and carries the user's own account id so the
 * collector can scope to mentions/own-authored messages/saved items only.
 */
export interface SlackDaySignalConfig {
  token: string;
  accountUserId: string;
  workspaceHost: string;
  teamId: string;
  timezone: string;
}

export function getSlackDaySignalConfig(): SlackDaySignalConfig | null {
  const settings = readPrivate();
  if (!settings.enabled) return null;
  const token = process.env.SLACK_USER_TOKEN || settings.userToken;
  if (!token || token.includes("your-")) return null;
  return {
    token,
    accountUserId: settings.accountUserId,
    workspaceHost: SLACK_STATIC_CONFIG.workspaceHost,
    teamId: SLACK_STATIC_CONFIG.teamId,
    timezone: slackTimeZone(),
  };
}

/** Dedicated projection for the experimental Huddle tool; no other caller receives browser credentials. */
export interface SlackHuddleConfig {
  enabled: true;
  workspaceHost: string;
  teamId: string;
  timezone: string;
  defaultMaxResults: number;
  clientToken: string;
  clientCookieD: string;
  userToken?: string;
  accountUserId?: string;
  source: "experimental-browser-session";
}

function readPrivate(): Required<typeof DEFAULTS> {
  if (existsSync(SLACK_SETTINGS_PATH)) {
    try {
      const parsed = JSON.parse(
        readFileSync(SLACK_SETTINGS_PATH, "utf8"),
      ) as SlackSettingsFile;
      return normalizePrivate(parsed ?? {});
    } catch (err) {
      throw new Error(
        `Failed to read Slack settings at ${SLACK_SETTINGS_PATH}: ${String(err)}`,
      );
    }
  }

  return { ...DEFAULTS };
}

function writePrivate(next: Required<typeof DEFAULTS>): void {
  mkdirSync(dirname(SLACK_SETTINGS_PATH), { recursive: true });
  const tmp = `${SLACK_SETTINGS_PATH}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  renameSync(tmp, SLACK_SETTINGS_PATH);
}

function readHuddlePrivate(): Required<typeof HUDDLE_DEFAULTS> {
  if (existsSync(SLACK_HUDDLE_SETTINGS_PATH)) {
    try {
      const parsed = JSON.parse(
        readFileSync(SLACK_HUDDLE_SETTINGS_PATH, "utf8"),
      ) as SlackSettingsFile;
      return normalizeHuddlePrivate(parsed);
    } catch (err) {
      throw new Error(
        `Failed to read Slack Huddle settings at ${SLACK_HUDDLE_SETTINGS_PATH}: ${String(err)}`,
      );
    }
  }
  return { ...HUDDLE_DEFAULTS };
}

function writeHuddlePrivate(next: Required<typeof HUDDLE_DEFAULTS>): void {
  mkdirSync(dirname(SLACK_HUDDLE_SETTINGS_PATH), { recursive: true });
  const tmp = `${SLACK_HUDDLE_SETTINGS_PATH}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  renameSync(tmp, SLACK_HUDDLE_SETTINGS_PATH);
}

function normalizeHuddlePrivate(
  settings: SlackSettingsFile,
): Required<typeof HUDDLE_DEFAULTS> {
  return {
    enabled: Boolean(settings.enabled),
    clientToken: String(settings.clientToken ?? "").trim(),
    clientCookieD: String(settings.clientCookieD ?? "").trim(),
  };
}

function normalizePrivate(
  settings: SlackSettingsFile,
): Required<typeof DEFAULTS> {
  const userToken = settings.userToken ?? "";
  const botToken = settings.botToken ?? "";
  return {
    enabled: Boolean(settings.enabled),
    userToken: userToken.trim(),
    botToken: botToken.trim(),
    accountUserId: String(settings.accountUserId ?? "").trim(),
    botUserId: String(settings.botUserId ?? "").trim(),
    grantedUserScopes: String(settings.grantedUserScopes ?? "").trim(),
    grantedBotScopes: String(settings.grantedBotScopes ?? "").trim(),
    oauthState: String(settings.oauthState ?? DEFAULTS.oauthState),
    oauthStateCreatedAt: Number(
      settings.oauthStateCreatedAt ?? DEFAULTS.oauthStateCreatedAt,
    ),
  };
}

function publicSettings(
  settings: Required<typeof DEFAULTS>,
  huddles: Required<typeof HUDDLE_DEFAULTS> = readHuddlePrivate(),
): SlackSettings {
  const effectiveClientToken =
    process.env.SLACK_CLIENT_TOKEN || huddles.clientToken;
  const effectiveClientCookie =
    process.env.SLACK_CLIENT_COOKIE_D ||
    extractDCookie(process.env.SLACK_CLIENT_COOKIE || "") ||
    huddles.clientCookieD;
  return {
    enabled: Boolean(settings.enabled),
    oauthClientConfigured: Boolean(
      SLACK_STATIC_CONFIG.clientId && SLACK_STATIC_CONFIG.clientSecret,
    ),
    userTokenConfigured: Boolean(settings.userToken),
    botTokenConfigured: Boolean(settings.botToken),
    huddlesEnabled: huddles.enabled,
    clientTokenConfigured: Boolean(effectiveClientToken),
    clientCookieConfigured: Boolean(effectiveClientCookie),
  };
}

export function getSlackSettings(): SlackSettings {
  return publicSettings(readPrivate());
}

/** Secret-free normal-runtime identity projection; never reads Huddle storage. */
export function getSlackRuntimeSettings(): {
  enabled: boolean;
  accountUserId: string;
  botUserId: string;
} {
  const settings = readPrivate();
  return {
    enabled: settings.enabled,
    accountUserId: settings.accountUserId,
    botUserId: settings.botUserId,
  };
}

/** Secret-free Huddle capability gate for tool exposure/settings reconciliation. */
export function getSlackHuddleCapabilitySettings(): Pick<
  SlackSettings,
  "huddlesEnabled" | "clientTokenConfigured" | "clientCookieConfigured"
> {
  const settings = readHuddlePrivate();
  const clientToken = process.env.SLACK_CLIENT_TOKEN || settings.clientToken;
  const clientCookieD =
    process.env.SLACK_CLIENT_COOKIE_D ||
    extractDCookie(process.env.SLACK_CLIENT_COOKIE || "") ||
    settings.clientCookieD;
  return {
    huddlesEnabled: settings.enabled,
    clientTokenConfigured: Boolean(clientToken),
    clientCookieConfigured: Boolean(clientCookieD),
  };
}

export function updateSlackSettings(patch: SlackSettingsPatch): SlackSettings {
  const current = readPrivate();
  const next: Required<typeof DEFAULTS> = {
    ...current,
    enabled: patch.enabled ?? current.enabled,
    userToken: patch.clearUserToken
      ? ""
      : patch.userToken?.trim() || current.userToken,
    botToken: patch.clearBotToken
      ? ""
      : patch.botToken?.trim() || current.botToken,
    accountUserId: patch.clearUserToken ? "" : current.accountUserId,
    botUserId: patch.clearBotToken ? "" : current.botUserId,
    grantedUserScopes: patch.clearUserToken ? "" : current.grantedUserScopes,
    grantedBotScopes: patch.clearBotToken ? "" : current.grantedBotScopes,
    oauthState: current.oauthState,
    oauthStateCreatedAt: current.oauthStateCreatedAt,
  };
  writePrivate(next);

  const huddleCurrent = readHuddlePrivate();
  const huddleNext: Required<typeof HUDDLE_DEFAULTS> = {
    enabled: patch.huddlesEnabled ?? huddleCurrent.enabled,
    clientToken: patch.clearClientToken
      ? ""
      : patch.clientToken?.trim() || huddleCurrent.clientToken,
    clientCookieD: patch.clearClientCookie
      ? ""
      : patch.clientCookieD?.trim() || huddleCurrent.clientCookieD,
  };
  if (JSON.stringify(huddleNext) !== JSON.stringify(huddleCurrent))
    writeHuddlePrivate(huddleNext);
  return publicSettings(next, huddleNext);
}

/** Public Web API tools receive only personal OAuth fields; browser-session fields never cross this boundary. */
export function getSlackPublicApiConfig(): SlackPublicApiConfig {
  const settings = readPrivate();
  if (!settings.enabled)
    throw new Error(
      "Slack tools are disabled. Enable them in Settings → Slack.",
    );
  const token = process.env.SLACK_USER_TOKEN || settings.userToken;
  if (!token || token.includes("your-")) {
    throw new Error(
      "Missing Slack personal user token. Connect the Slack app in Settings → Slack.",
    );
  }
  return {
    enabled: true,
    token,
    tokenMode: "user",
    workspaceHost: SLACK_STATIC_CONFIG.workspaceHost,
    teamId: SLACK_STATIC_CONFIG.teamId,
    timezone: slackTimeZone(),
    defaultMaxResults: clamp(
      Number(
        process.env.SLACK_MAX_RESULTS || SLACK_STATIC_CONFIG.defaultMaxResults,
      ),
      1,
      100,
    ),
    grantedUserScopes: settings.grantedUserScopes
      .split(",")
      .map((scope) => scope.trim())
      .filter(Boolean),
    source: "personal-user-oauth",
  };
}

export function getSlackToolConfig(
  tokenMode: "user" | "bot" = "user",
): SlackToolConfig {
  const settings = readPrivate();
  if (!settings.enabled)
    throw new Error(
      "Slack tools are disabled. Enable them in Settings → Slack.",
    );
  const envUserToken = process.env.SLACK_USER_TOKEN || "";
  const envBotToken = process.env.SLACK_BOT_TOKEN || "";
  const userToken = envUserToken || settings.userToken;
  const botToken = envBotToken || settings.botToken;
  const resolvedMode = tokenMode;
  const token = resolvedMode === "bot" ? botToken : userToken;
  if (!token || token.includes("your-")) {
    throw new Error(
      `Missing Slack ${resolvedMode} token. Connect the Slack app or configure personal user access in Settings → Slack.`,
    );
  }
  return {
    enabled: settings.enabled,
    token,
    tokenMode: resolvedMode,
    workspaceHost: SLACK_STATIC_CONFIG.workspaceHost,
    teamId: SLACK_STATIC_CONFIG.teamId,
    timezone: slackTimeZone(),
    defaultMaxResults: clamp(
      Number(
        process.env.SLACK_MAX_RESULTS || SLACK_STATIC_CONFIG.defaultMaxResults,
      ),
      1,
      100,
    ),
    userTokenConfigured: Boolean(envUserToken || settings.userToken),
    botTokenConfigured: Boolean(envBotToken || settings.botToken),
    source: "assistant-settings",
  };
}

export function getSlackHuddleConfig(): SlackHuddleConfig {
  const settings = readPrivate();
  const huddles = readHuddlePrivate();
  if (!huddles.enabled)
    throw new Error(
      "Experimental Slack Huddle history is disabled. Enable it in Settings → Slack Huddles.",
    );
  const clientToken = process.env.SLACK_CLIENT_TOKEN || huddles.clientToken;
  const clientCookieD =
    process.env.SLACK_CLIENT_COOKIE_D ||
    extractDCookie(process.env.SLACK_CLIENT_COOKIE || "") ||
    huddles.clientCookieD;
  if (!clientToken || !clientCookieD)
    throw new Error(
      "Missing Slack Huddle browser session. Paste a huddles.history cURL in Settings → Slack Huddles.",
    );
  const userToken =
    process.env.SLACK_USER_TOKEN || settings.userToken || undefined;
  return {
    enabled: true,
    workspaceHost: SLACK_STATIC_CONFIG.workspaceHost,
    teamId: SLACK_STATIC_CONFIG.teamId,
    timezone: slackTimeZone(),
    defaultMaxResults: clamp(
      Number(
        process.env.SLACK_MAX_RESULTS || SLACK_STATIC_CONFIG.defaultMaxResults,
      ),
      1,
      100,
    ),
    clientToken,
    clientCookieD,
    ...(userToken ? { userToken } : {}),
    ...(settings.accountUserId
      ? { accountUserId: settings.accountUserId }
      : {}),
    source: "experimental-browser-session",
  };
}

const SLACK_OAUTH_CALLBACK_PATH = "/api/slack/oauth/callback";

function slackOAuthRedirectUri(publicBaseUrl?: string): string {
  const base = (
    publicBaseUrl ||
    PUBLIC_BASE_URL ||
    `http://localhost:${PORT}`
  ).replace(/\/+$/, "");
  return `${base}${SLACK_OAUTH_CALLBACK_PATH}`;
}

export function createSlackOAuthStartUrl(publicBaseUrl?: string): string {
  if (
    !SLACK_STATIC_CONFIG.clientId ||
    !SLACK_STATIC_CONFIG.clientSecret ||
    SLACK_STATIC_CONFIG.botScopes.length === 0
  ) {
    throw new Error(
      "Configure the Slack app client ID and bot scopes in the app config (ASSISTANT_CONFIG), and provide the client secret through ASSISTANT_SLACK_CLIENT_SECRET before starting OAuth.",
    );
  }
  const settings = readPrivate();
  settings.oauthState = randomBytes(24).toString("base64url");
  settings.oauthStateCreatedAt = Date.now();
  writePrivate(settings);
  const url = new URL("https://slack.com/oauth/v2/authorize");
  url.searchParams.set("client_id", SLACK_STATIC_CONFIG.clientId);
  url.searchParams.set("scope", SLACK_STATIC_CONFIG.botScopes.join(","));
  url.searchParams.set("user_scope", SLACK_STATIC_CONFIG.userScopes.join(","));
  url.searchParams.set("redirect_uri", slackOAuthRedirectUri(publicBaseUrl));
  url.searchParams.set("state", settings.oauthState);
  url.searchParams.set("team", SLACK_STATIC_CONFIG.teamId);
  return url.toString();
}

export async function handleSlackOAuthCallback(
  query: URLSearchParams,
  publicBaseUrl?: string,
): Promise<{ ok: boolean; message: string }> {
  const code = query.get("code");
  const state = query.get("state");
  const settings = readPrivate();
  if (
    !state ||
    state !== settings.oauthState ||
    Date.now() - settings.oauthStateCreatedAt > 10 * 60 * 1000
  ) {
    return {
      ok: false,
      message:
        "Slack OAuth state did not match or has expired. Please try again from Settings.",
    };
  }
  // Consume state before any network work so concurrent callbacks cannot exchange
  // the same authorization attempt twice. A failed exchange starts a fresh sign-in.
  settings.oauthState = "";
  settings.oauthStateCreatedAt = 0;
  writePrivate(settings);
  const error = query.get("error");
  if (error) return { ok: false, message: `Slack OAuth failed: ${error}` };
  if (!code)
    return {
      ok: false,
      message:
        "Slack OAuth did not return an authorization code. Please try again from Settings.",
    };
  const body = new URLSearchParams({
    client_id: SLACK_STATIC_CONFIG.clientId,
    client_secret: SLACK_STATIC_CONFIG.clientSecret,
    code,
    redirect_uri: slackOAuthRedirectUri(publicBaseUrl),
  });
  const res = await fetch("https://slack.com/api/oauth.v2.access", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body,
    signal: AbortSignal.timeout(SLACK_SETTINGS_REQUEST_TIMEOUT_MS),
  });
  const text = await readBoundedSettingsResponse(res, "Slack OAuth");
  const json = JSON.parse(text) as {
    ok?: boolean;
    error?: string;
    access_token?: string;
    scope?: string;
    bot_user_id?: string;
    team?: { id?: string; name?: string };
    authed_user?: { id?: string; scope?: string; access_token?: string };
  };
  if (!res.ok || !json.ok || !json.access_token) {
    writePrivate(settings);
    return {
      ok: false,
      message: `Slack OAuth token exchange failed: ${json.error ?? `HTTP ${res.status}`}`,
    };
  }
  if (
    json.team?.id &&
    SLACK_STATIC_CONFIG.teamId &&
    json.team.id !== SLACK_STATIC_CONFIG.teamId
  ) {
    writePrivate(settings);
    return {
      ok: false,
      message:
        "Slack authorized a different workspace. Please sign in with the configured workspace.",
    };
  }
  if (!json.authed_user?.access_token) {
    writePrivate(settings);
    return {
      ok: false,
      message: "Slack OAuth did not return the requested personal user token.",
    };
  }
  settings.botToken = json.access_token;
  settings.userToken = json.authed_user.access_token;
  settings.accountUserId = json.authed_user.id ?? "";
  settings.botUserId = json.bot_user_id ?? "";
  settings.grantedUserScopes = json.authed_user.scope ?? "";
  settings.grantedBotScopes = json.scope ?? "";
  settings.enabled = true;
  writePrivate(settings);
  return {
    ok: true,
    message: `Slack app connected${json.team?.name ? ` to ${json.team.name}` : ""}.`,
  };
}

export async function testSlackSettings(): Promise<SlackConnectionStatus> {
  const settings = readPrivate();
  const checkedAt = Date.now();
  if (!settings.enabled)
    return { ok: false, checkedAt, message: "Slack is disabled." };

  const user = settings.userToken
    ? await testToken(settings.userToken).catch(() => ({ ok: false }))
    : { ok: false };
  const bot = settings.botToken
    ? await testToken(settings.botToken).catch(() => ({ ok: false }))
    : { ok: false };
  const search = settings.userToken
    ? await testPersonalSearch(settings.userToken).catch(() => ({ ok: false }))
    : { ok: false };
  const ok =
    user.ok && bot.ok && search.ok && Boolean(SLACK_STATIC_CONFIG.appToken);
  return {
    ok,
    checkedAt,
    message: ok
      ? "Slack connection looks good."
      : "Slack needs attention. Sign out and connect Slack again.",
  };
}

export async function testSlackHuddleSettings(): Promise<SlackHuddleConnectionStatus> {
  const checkedAt = Date.now();
  try {
    const result = await testHuddles(getSlackHuddleConfig());
    return { ok: result.ok, checkedAt, message: result.message };
  } catch (err) {
    return { ok: false, checkedAt, message: errorText(err) };
  }
}

async function testToken(
  token: string,
): Promise<{ ok: boolean; message: string }> {
  const body = new URLSearchParams();
  const res = await fetch("https://slack.com/api/auth.test", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body,
    signal: AbortSignal.timeout(SLACK_SETTINGS_REQUEST_TIMEOUT_MS),
  });
  const text = await readBoundedSettingsResponse(
    res,
    "Slack authentication check",
  );
  if (!res.ok)
    return {
      ok: false,
      message: `Slack HTTP ${res.status}: ${text.slice(0, 240)}`,
    };
  const json = JSON.parse(text) as {
    ok?: boolean;
    error?: string;
    user?: string;
    team?: string;
    url?: string;
  };
  if (!json.ok)
    return {
      ok: false,
      message: `Slack API rejected token: ${json.error ?? text.slice(0, 240)}`,
    };
  const who = json.user ? `${json.user}` : "Slack token";
  const team = json.team ? ` on ${json.team}` : "";
  return { ok: true, message: `${who} authenticated${team}.` };
}

async function testPersonalSearch(
  token: string,
): Promise<{ ok: boolean; message: string }> {
  const body = new URLSearchParams({
    query: '"personal-assistant-connection-check-7f83d4"',
    count: "1",
    page: "1",
    sort: "timestamp",
    sort_dir: "desc",
  });
  const res = await fetch("https://slack.com/api/search.messages", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body,
    signal: AbortSignal.timeout(SLACK_SETTINGS_REQUEST_TIMEOUT_MS),
  });
  const text = await readBoundedSettingsResponse(
    res,
    "Slack personal search check",
  );
  if (!res.ok) return { ok: false, message: `Slack search HTTP ${res.status}` };
  const json = JSON.parse(text) as { ok?: boolean };
  if (!json.ok)
    return { ok: false, message: "Slack personal search is unavailable." };
  return { ok: true, message: "Slack personal search works." };
}

async function testHuddles(
  settings: SlackHuddleConfig,
): Promise<{ ok: boolean; message: string }> {
  const params = browserClientParams(settings, { limit: "1" });
  const res = await fetch(
    `https://${settings.workspaceHost}/api/huddles.history?${params}`,
    {
      headers: browserClientHeaders(settings, "assistant-slack-huddles/1.0"),
      signal: AbortSignal.timeout(SLACK_SETTINGS_REQUEST_TIMEOUT_MS),
    },
  );
  const text = await readBoundedSettingsResponse(res, "Slack Huddle check");
  if (!res.ok)
    return { ok: false, message: `Slack huddles HTTP ${res.status}.` };
  const json = JSON.parse(text) as {
    ok?: boolean;
    error?: string;
    huddles?: unknown[];
  };
  if (!json.ok)
    return {
      ok: false,
      message: `Slack huddles rejected credentials: ${json.error ?? text.slice(0, 240)}`,
    };
  return {
    ok: true,
    message: `Slack huddles client credentials accepted (${json.huddles?.length ?? 0} recent returned).`,
  };
}

function browserClientParams(
  settings: Pick<SlackHuddleConfig, "teamId">,
  values: Record<string, string>,
): URLSearchParams {
  return new URLSearchParams({ ...values, slack_route: settings.teamId });
}

function browserClientHeaders(
  settings: Pick<SlackHuddleConfig, "clientToken" | "clientCookieD">,
  userAgent: string,
): Record<string, string> {
  return {
    Authorization: `Bearer ${settings.clientToken}`,
    Cookie: `d=${settings.clientCookieD}`,
    Accept: "application/json, text/plain, */*",
    "User-Agent": `Mozilla/5.0 ${userAgent}`,
    "X-Requested-With": "XMLHttpRequest",
  };
}

async function readBoundedSettingsResponse(
  response: Response,
  label: string,
): Promise<string> {
  const declared = Number(response.headers.get("content-length"));
  if (
    Number.isFinite(declared) &&
    declared > SLACK_SETTINGS_RESPONSE_LIMIT_BYTES
  ) {
    await response.body?.cancel().catch(() => {});
    throw new Error(`${label} response exceeded the safety limit.`);
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = "";
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > SLACK_SETTINGS_RESPONSE_LIMIT_BYTES) {
        await reader.cancel().catch(() => {});
        throw new Error(`${label} response exceeded the safety limit.`);
      }
      text += decoder.decode(next.value, { stream: true });
    }
    return text + decoder.decode();
  } finally {
    reader.releaseLock();
  }
}

function extractDCookie(cookie: string): string {
  const match = cookie.match(/(?:^|;\s*)d=([^;]+)/);
  return match?.[1]?.trim() ?? "";
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, Math.floor(value)));
}
