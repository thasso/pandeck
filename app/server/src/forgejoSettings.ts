/**
 * Runtime settings for the Forgejo integration. Forgejo is self-hosted, so the
 * instance base URL is user configuration (non-secret) alongside the access
 * token (a user-editable secret entered in Settings → Forgejo). Both are stored
 * privately under `DATA_DIR/settings/forgejo.json` (mode 0600); the token is
 * never echoed back to the browser (the public projection exposes only
 * `tokenConfigured`). This is the sole source of the config — no static/env
 * fallback. Mirrors `githubSettings.ts`.
 */
import { join } from "node:path";
import type {
  ForgejoConnectionStatus,
  ForgejoSettings,
  ForgejoSettingsPatch,
} from "@assistant/shared";
import { DATA_DIR } from "./config.ts";
import {
  type ForgejoApiConfig,
  forgejoRequest,
  normalizeForgejoBaseUrl,
} from "./forgejoClient.ts";
import { createPrivateJsonFile } from "./privateJsonFile.ts";
import { deadlineSignal } from "./httpRetry.ts";
import { sameOrigin } from "./urlOrigin.ts";

const FORGEJO_SETTINGS_PATH = join(DATA_DIR, "settings", "forgejo.json");

interface ForgejoConfigFile {
  enabled?: boolean;
  baseUrl?: string;
  token?: string;
  defaultOwner?: string;
}

type StoredForgejoSettings = {
  enabled: boolean;
  baseUrl: string;
  token: string;
  defaultOwner: string;
};

function normalizeStored(
  parsed: ForgejoConfigFile | undefined,
): StoredForgejoSettings {
  return {
    enabled: Boolean(parsed?.enabled),
    baseUrl:
      typeof parsed?.baseUrl === "string"
        ? normalizeForgejoBaseUrl(parsed.baseUrl)
        : "",
    token: typeof parsed?.token === "string" ? parsed.token : "",
    defaultOwner:
      typeof parsed?.defaultOwner === "string" ? parsed.defaultOwner : "",
  };
}

/**
 * Parsed settings, kept in memory because `getForgejoBaseUrl()` sits on read
 * paths that run per Task link (external-link classification). Every in-process
 * write goes through `updateForgejoSettings`, which refreshes it, so the cache
 * can only go stale if the file is edited underneath a running server.
 */
let cached: StoredForgejoSettings | undefined;

const privateFile = createPrivateJsonFile(
  FORGEJO_SETTINGS_PATH,
  "Forgejo settings",
);

function readPrivate(): StoredForgejoSettings {
  return (cached ??= privateFile.read(normalizeStored));
}

function writePrivate(next: StoredForgejoSettings): void {
  privateFile.write(next);
  cached = next;
}

function publicSettings(settings: StoredForgejoSettings): ForgejoSettings {
  return {
    enabled: settings.enabled,
    baseUrl: settings.baseUrl,
    tokenConfigured: Boolean(settings.token),
    defaultOwner: settings.defaultOwner,
  };
}

export function getForgejoSettings(): ForgejoSettings {
  return publicSettings(readPrivate());
}

export function updateForgejoSettings(
  patch: ForgejoSettingsPatch,
): ForgejoSettings {
  const current = readPrivate();
  const baseUrl =
    patch.baseUrl !== undefined
      ? normalizeForgejoBaseUrl(patch.baseUrl)
      : current.baseUrl;
  // The stored token stays with the origin it was entered for (urlOrigin.ts).
  const keptToken = sameOrigin(current.baseUrl, baseUrl) ? current.token : "";
  const next: StoredForgejoSettings = {
    enabled: patch.enabled ?? current.enabled,
    baseUrl,
    token: patch.clearToken ? "" : patch.token?.trim() || keptToken,
    defaultOwner: (patch.defaultOwner ?? current.defaultOwner).trim(),
  };
  writePrivate(next);
  return publicSettings(next);
}

export function isForgejoConfigured(): boolean {
  const settings = readPrivate();
  return settings.enabled && Boolean(settings.baseUrl);
}

/** Configured instance base URL (normalized, no trailing slash), or empty. */
export function getForgejoBaseUrl(): string {
  return readPrivate().baseUrl;
}

/** Optional default owner (org/user) for tool calls that omit one. */
export function getForgejoDefaultOwner(): string {
  return readPrivate().defaultOwner;
}

/** Forgejo config when enabled + a base URL is set, else null. For features that degrade silently (e.g. worktree CI). */
export function getForgejoConfigIfAvailable(): ForgejoApiConfig | null {
  const settings = readPrivate();
  if (!settings.enabled || !settings.baseUrl) return null;
  return { baseUrl: settings.baseUrl, token: settings.token };
}

/** Full Forgejo config for tools. Throws a Settings hint when disabled or missing the base URL. */
export function getForgejoToolConfig(): ForgejoApiConfig {
  const settings = readPrivate();
  if (!settings.enabled)
    throw new Error(
      "Forgejo tools are disabled. Enable them in Settings → Forgejo.",
    );
  if (!settings.baseUrl)
    throw new Error("Missing Forgejo base URL. Set it in Settings → Forgejo.");
  return { baseUrl: settings.baseUrl, token: settings.token };
}

/** Validate the saved config with a `/version` probe plus an authenticated `/user` call when a token is set. */
export async function testForgejoSettings(
  signal?: AbortSignal,
): Promise<ForgejoConnectionStatus> {
  const settings = readPrivate();
  const checkedAt = Date.now();
  if (!settings.enabled)
    return { ok: true, checkedAt, message: "Forgejo tools are disabled." };
  if (!settings.baseUrl)
    return {
      ok: false,
      checkedAt,
      message: "A Forgejo instance base URL is required.",
    };
  const config: ForgejoApiConfig = {
    baseUrl: settings.baseUrl,
    token: settings.token,
  };
  try {
    const versionRes = await forgejoRequest<{ version?: string }>(
      config,
      "GET",
      "/version",
      {
        signal: deadlineSignal(15_000, signal),
      },
    );
    const version = versionRes.data?.version;
    if (!settings.token) {
      return {
        ok: true,
        checkedAt,
        message: version
          ? `Reached Forgejo ${version} (no token — anonymous read only).`
          : "Reached Forgejo (no token — anonymous read only).",
        ...(version ? { version } : {}),
      };
    }
    const userRes = await forgejoRequest<{ login?: string; username?: string }>(
      config,
      "GET",
      "/user",
      {
        signal: deadlineSignal(15_000, signal),
      },
    );
    const login = userRes.data?.login ?? userRes.data?.username;
    return {
      ok: true,
      checkedAt,
      message: login ? `Authenticated as ${login}.` : "Forgejo token is valid.",
      ...(login ? { login } : {}),
      ...(version ? { version } : {}),
    };
  } catch (err) {
    return {
      ok: false,
      checkedAt,
      message: `Forgejo check failed: ${String(err)}`,
    };
  }
}
