/**
 * Runtime settings for the Context7 docs-search tools (`context7_resolve_library`,
 * `context7_get_docs`). The API key is a user-editable secret entered in
 * Settings → Context7 and stored privately under `DATA_DIR/settings/context7.json`
 * (mode 0600); it is never echoed back to the browser (the public projection
 * exposes only `apiKeyConfigured`). This is the sole source of the key — there
 * is no static/env fallback.
 */
import { applyPatch } from "@assistant/shared";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type {
  Context7ConnectionStatus,
  Context7Settings,
  Context7SettingsPatch,
} from "@assistant/shared";
import { DATA_DIR } from "./config.ts";
import { fileReadErrorText } from "./errors.ts";

const CONTEXT7_SETTINGS_DIR = join(DATA_DIR, "settings");
const CONTEXT7_CONFIG_PATH = join(CONTEXT7_SETTINGS_DIR, "context7.json");

/** Shared base URL for the Context7 v2 REST API (tools + connection test). */
export const CONTEXT7_API_BASE = "https://context7.com/api/v2";

interface Context7ConfigFile {
  enabled?: boolean;
  apiKey?: string;
}

function readFile(): Context7ConfigFile {
  if (!existsSync(CONTEXT7_CONFIG_PATH)) return {};
  try {
    const parsed = JSON.parse(
      readFileSync(CONTEXT7_CONFIG_PATH, "utf8"),
    ) as Context7ConfigFile;
    return parsed ?? {};
  } catch (err) {
    throw new Error(
      `Failed to read Context7 config at ${CONTEXT7_CONFIG_PATH}: ${fileReadErrorText(err)}`,
    );
  }
}

function writeFile(config: Context7ConfigFile): void {
  mkdirSync(CONTEXT7_SETTINGS_DIR, { recursive: true });
  const tmp = `${CONTEXT7_CONFIG_PATH}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(config, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  renameSync(tmp, CONTEXT7_CONFIG_PATH);
}

function normalizeConfig(config: Context7ConfigFile): Context7ConfigFile {
  return {
    enabled: config.enabled === true,
    ...(typeof config.apiKey === "string" && config.apiKey.trim()
      ? { apiKey: config.apiKey.trim() }
      : {}),
  };
}

function publicSettings(config: Context7ConfigFile): Context7Settings {
  const normalized = normalizeConfig(config);
  return {
    enabled: normalized.enabled === true,
    apiKeyConfigured: Boolean(normalized.apiKey),
  };
}

export function getContext7Settings(): Context7Settings {
  return publicSettings(readFile());
}

export function updateContext7Settings(
  patch: Context7SettingsPatch,
): Context7Settings {
  const current = normalizeConfig(readFile());
  // See braveSettings: `clearApiKey` must REMOVE the key, not blank it.
  const next: Context7ConfigFile = applyPatch(current, {
    ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
    ...(patch.clearApiKey ? { apiKey: undefined } : {}),
    ...(patch.apiKey && patch.apiKey.trim()
      ? { apiKey: patch.apiKey.trim() }
      : {}),
  });
  writeFile(normalizeConfig(next));
  return getContext7Settings();
}

/**
 * The real key for tool code, guarded by the enable+configured gate. Throws a
 * user-actionable error (surfaced to the agent) when Context7 is unusable.
 */
export function getContext7ToolConfig(): { apiKey: string } {
  const config = normalizeConfig(readFile());
  if (!config.enabled) {
    throw new Error(
      "Context7 docs search is disabled. Enable it in Settings → Context7.",
    );
  }
  if (!config.apiKey) {
    throw new Error(
      "Context7 is not configured: add a Context7 API key in Settings → Context7.",
    );
  }
  return { apiKey: config.apiKey };
}

/** Validate the saved key with a minimal live library search. */
export async function testContext7Settings(): Promise<Context7ConnectionStatus> {
  const config = normalizeConfig(readFile());
  const checkedAt = Date.now();
  if (!config.enabled) {
    return {
      ok: true,
      checkedAt,
      message: "Context7 docs search is disabled.",
    };
  }
  if (!config.apiKey) {
    return { ok: false, checkedAt, message: "A Context7 API key is required." };
  }
  const url = new URL(`${CONTEXT7_API_BASE}/libs/search`);
  url.searchParams.set("libraryName", "react");
  const res = await fetch(url, {
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${config.apiKey}`,
    },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    const body = (await res.text().catch(() => "")).slice(0, 300);
    return {
      ok: false,
      checkedAt,
      message: `Context7 returned HTTP ${res.status}. ${body}`.trim(),
    };
  }
  return { ok: true, checkedAt, message: "Context7 API key is valid." };
}
