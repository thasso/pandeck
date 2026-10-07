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
  SlackSettings,
  SlackSettingsPatch,
} from "@assistant/shared";
import {
  DATA_DIR,
  PORT,
  PUBLIC_BASE_URL,
  SLACK_STATIC_CONFIG,
} from "./config.ts";
import { fileReadErrorText } from "./errors.ts";
import { userTimeZone } from "./userProfile.ts";

const SLACK_SETTINGS_PATH = join(DATA_DIR, "settings", "slack.json");
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

function readPrivate(): Required<typeof DEFAULTS> {
  if (existsSync(SLACK_SETTINGS_PATH)) {
    try {
      const parsed = JSON.parse(
        readFileSync(SLACK_SETTINGS_PATH, "utf8"),
      ) as SlackSettingsFile;
      return normalizePrivate(parsed ?? {});
    } catch (err) {
      throw new Error(
        `Failed to read Slack settings at ${SLACK_SETTINGS_PATH}: ${fileReadErrorText(err)}`,
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

function publicSettings(settings: Required<typeof DEFAULTS>): SlackSettings {
  return {
    enabled: Boolean(settings.enabled),
    oauthClientConfigured: Boolean(
      SLACK_STATIC_CONFIG.clientId && SLACK_STATIC_CONFIG.clientSecret,
    ),
    userTokenConfigured: Boolean(settings.userToken),
    botTokenConfigured: Boolean(settings.botToken),
    connected: Boolean(settings.userToken && settings.botToken),
  };
}

export function getSlackSettings(): SlackSettings {
  return publicSettings(readPrivate());
}

/** Secret-free runtime identity projection. */
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

export function updateSlackSettings(patch: SlackSettingsPatch): SlackSettings {
  const current = readPrivate();
  const clearUser = patch.clearUserToken || patch.disconnect;
  const clearBot = patch.clearBotToken || patch.disconnect;
  const next: Required<typeof DEFAULTS> = {
    ...current,
    enabled: patch.enabled ?? current.enabled,
    userToken: clearUser ? "" : patch.userToken?.trim() || current.userToken,
    botToken: clearBot ? "" : patch.botToken?.trim() || current.botToken,
    accountUserId: clearUser ? "" : current.accountUserId,
    botUserId: clearBot ? "" : current.botUserId,
    grantedUserScopes: clearUser ? "" : current.grantedUserScopes,
    grantedBotScopes: clearBot ? "" : current.grantedBotScopes,
    oauthState: current.oauthState,
    oauthStateCreatedAt: current.oauthStateCreatedAt,
  };
  writePrivate(next);

  return publicSettings(next);
}

/** Public Web API tools receive only personal OAuth fields. */
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

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, Math.floor(value)));
}
