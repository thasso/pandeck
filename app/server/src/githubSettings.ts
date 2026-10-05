/**
 * Runtime settings for the GitHub integration tools. The personal access token
 * (a classic PAT) is a user-editable secret entered in Settings → GitHub and
 * stored privately under `DATA_DIR/settings/github.json` (mode 0600); it is
 * never echoed back to the browser (the public projection exposes only
 * `tokenConfigured`). This is the sole source of the token — no static/env
 * fallback. Mirrors `jiraSettings.ts`/`context7Settings.ts`.
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import type {
  GithubConnectionStatus,
  GithubSettings,
  GithubSettingsPatch,
} from "@assistant/shared";
import { DATA_DIR } from "./config.ts";
import {
  containerRuntimeStatus,
  type RegistryCredential,
} from "./containerImages.ts";
import {
  GITHUB_API_BASE,
  type GithubApiConfig,
  githubRequest,
  resolveAuthenticatedLogin,
} from "./githubClient.ts";
import { fileReadErrorText } from "./errors.ts";
import { deadlineSignal } from "./httpRetry.ts";

/** Scope a classic PAT needs so GHCR (`ghcr.io`) accepts a container pull. */
const PACKAGE_READ_SCOPE = "read:packages";

const GITHUB_SETTINGS_PATH = join(DATA_DIR, "settings", "github.json");

interface GithubConfigFile {
  enabled?: boolean;
  token?: string;
  defaultOwner?: string;
  packageProxyEnabled?: boolean;
}

type StoredGithubSettings = {
  enabled: boolean;
  token: string;
  defaultOwner: string;
  packageProxyEnabled: boolean;
};

function normalizeStored(
  parsed: GithubConfigFile | undefined,
): StoredGithubSettings {
  return {
    enabled: Boolean(parsed?.enabled),
    token: typeof parsed?.token === "string" ? parsed.token : "",
    defaultOwner:
      typeof parsed?.defaultOwner === "string" ? parsed.defaultOwner : "",
    // Defaults ON: the proxy is how builds reach private package registries
    // without a token, so it follows the integration unless switched off.
    packageProxyEnabled: parsed?.packageProxyEnabled !== false,
  };
}

function readPrivate(): StoredGithubSettings {
  if (!existsSync(GITHUB_SETTINGS_PATH)) return normalizeStored(undefined);
  try {
    return normalizeStored(
      JSON.parse(
        readFileSync(GITHUB_SETTINGS_PATH, "utf8"),
      ) as GithubConfigFile,
    );
  } catch (err) {
    throw new Error(
      `Failed to read GitHub settings at ${GITHUB_SETTINGS_PATH}: ${fileReadErrorText(err)}`,
    );
  }
}

function writePrivate(next: StoredGithubSettings): void {
  mkdirSync(dirname(GITHUB_SETTINGS_PATH), { recursive: true });
  const tmp = `${GITHUB_SETTINGS_PATH}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  renameSync(tmp, GITHUB_SETTINGS_PATH);
}

function publicSettings(settings: StoredGithubSettings): GithubSettings {
  return {
    enabled: settings.enabled,
    tokenConfigured: Boolean(settings.token),
    defaultOwner: settings.defaultOwner,
    packageProxyEnabled: settings.packageProxyEnabled,
  };
}

export function getGithubSettings(): GithubSettings {
  return publicSettings(readPrivate());
}

export function updateGithubSettings(
  patch: GithubSettingsPatch,
): GithubSettings {
  const current = readPrivate();
  const next: StoredGithubSettings = {
    enabled: patch.enabled ?? current.enabled,
    token: patch.clearToken ? "" : patch.token?.trim() || current.token,
    defaultOwner: (patch.defaultOwner ?? current.defaultOwner).trim(),
    packageProxyEnabled:
      patch.packageProxyEnabled ?? current.packageProxyEnabled,
  };
  writePrivate(next);
  return publicSettings(next);
}

/** Optional default owner (org/user) for tool calls that omit one. */
export function getGithubDefaultOwner(): string {
  return readPrivate().defaultOwner;
}

/** GitHub config when enabled + configured, else null. For features that degrade silently (e.g. worktree CI). */
export function getGithubConfigIfAvailable(): GithubApiConfig | null {
  const settings = readPrivate();
  if (!settings.enabled || !settings.token) return null;
  return { token: settings.token, apiBaseUrl: GITHUB_API_BASE };
}

/** Full GitHub config for tools. Throws a Settings hint when disabled or missing the token. */
export function getGithubToolConfig(): GithubApiConfig {
  const settings = readPrivate();
  if (!settings.enabled)
    throw new Error(
      "GitHub tools are disabled. Enable them in Settings → GitHub.",
    );
  if (!settings.token)
    throw new Error(
      "Missing GitHub token. Add a personal access token in Settings → GitHub.",
    );
  return { token: settings.token, apiBaseUrl: GITHUB_API_BASE };
}

/**
 * GitHub registry credential for server-side use: container pulls
 * (`containerImages.ts`) and the package proxy (`packageProxy/`). Server-side
 * only: never projected to clients, tools, or agent environments. Returns null
 * when the GitHub integration is off or has no token.
 */
export async function getGithubRegistryCredential(
  signal?: AbortSignal,
): Promise<RegistryCredential | null> {
  const settings = readPrivate();
  if (!settings.enabled || !settings.token) return null;
  const login = await resolveAuthenticatedLogin(
    { token: settings.token, apiBaseUrl: GITHUB_API_BASE },
    signal,
  );
  // The registries authenticate by token; the login only makes it attributable.
  return { username: login ?? "x-access-token", token: settings.token };
}

/** Validate the saved token with a minimal `/user` call. */
export async function testGithubSettings(
  signal?: AbortSignal,
): Promise<GithubConnectionStatus> {
  const settings = readPrivate();
  const checkedAt = Date.now();
  if (!settings.enabled)
    return { ok: true, checkedAt, message: "GitHub tools are disabled." };
  if (!settings.token)
    return {
      ok: false,
      checkedAt,
      message: "A GitHub personal access token is required.",
    };
  try {
    const res = await githubRequest<{ login?: string }>(
      { token: settings.token, apiBaseUrl: GITHUB_API_BASE },
      "GET",
      "/user",
      { signal: deadlineSignal(15_000, signal) },
    );
    const login = res.data?.login;
    const base = login
      ? `Authenticated as ${login}.`
      : "GitHub token is valid.";
    return {
      ok: true,
      checkedAt,
      message: `${base} ${await containerPullReadiness(res.scopes)} ${await packageProxyReadiness()}`,
      ...(login ? { login } : {}),
      ...(res.scopes ? { scopes: res.scopes } : {}),
    };
  } catch (err) {
    return {
      ok: false,
      checkedAt,
      message: `GitHub token check failed: ${String(err)}`,
    };
  }
}

/**
 * One sentence about server-side GHCR container pulls (`container_image_pull`):
 * whether a container runtime is reachable and whether the token carries the
 * package-read scope. Reported here so the same token check diagnoses both.
 */
async function containerPullReadiness(
  scopes: string[] | null,
): Promise<string> {
  const runtime = await containerRuntimeStatus();
  if (!runtime.available) {
    return `Container image pulls unavailable: ${runtime.reason || "no container runtime on the server"}.`;
  }
  const version = runtime.version ? ` ${runtime.version}` : "";
  if (!scopes)
    return `Container image pulls ready (docker${version}); the token reports no scopes, so ${PACKAGE_READ_SCOPE} could not be verified.`;
  return scopes.includes(PACKAGE_READ_SCOPE)
    ? `Container image pulls ready (docker${version}, token has ${PACKAGE_READ_SCOPE}).`
    : `Container image pulls will fail for private GHCR images: the token is missing the ${PACKAGE_READ_SCOPE} scope.`;
}

/**
 * One sentence about the package proxy (`packageProxy/`). Imported lazily so
 * this settings module stays free of a cycle with the proxy, which reads the
 * credential from here.
 */
async function packageProxyReadiness(): Promise<string> {
  try {
    const { packageProxyStatus } =
      await import("./packageProxy/packageProxy.ts");
    const status = packageProxyStatus();
    if (!status.running)
      return `Package proxy off: ${status.reason ?? "not running"}.`;
    const jvm = status.jvmConfigured
      ? ""
      : ` JVM builds are NOT proxied (${status.reason ?? "no JVM truststore"}).`;
    return `Package proxy on ${status.url} for ${status.hosts?.join(", ")}.${jvm}`;
  } catch (err) {
    return `Package proxy status unavailable: ${String(err)}.`;
  }
}
