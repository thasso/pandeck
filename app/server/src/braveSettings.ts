/**
 * Runtime settings for the `web_search` tool (Brave Search API). The API key is
 * a user-editable secret entered in Settings → Web Search and stored privately
 * under `DATA_DIR/settings/brave.json` (mode 0600); it is never echoed back to
 * the browser (the public projection exposes only `apiKeyConfigured`). This is
 * the sole source of the key — there is no static/env fallback.
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
  BraveConnectionStatus,
  BraveSettings,
  BraveSettingsPatch,
} from "@assistant/shared";
import { DATA_DIR } from "./config.ts";
import { fileReadErrorText } from "./errors.ts";
import { deadlineSignal } from "./httpRetry.ts";

const BRAVE_SETTINGS_DIR = join(DATA_DIR, "settings");
const BRAVE_CONFIG_PATH = join(BRAVE_SETTINGS_DIR, "brave.json");
const BRAVE_ENDPOINT = "https://api.search.brave.com/res/v1/web/search";

interface BraveConfigFile {
  enabled?: boolean;
  apiKey?: string;
}

function readFile(): BraveConfigFile {
  if (!existsSync(BRAVE_CONFIG_PATH)) return {};
  try {
    const parsed = JSON.parse(
      readFileSync(BRAVE_CONFIG_PATH, "utf8"),
    ) as BraveConfigFile;
    return parsed ?? {};
  } catch (err) {
    throw new Error(
      `Failed to read Brave config at ${BRAVE_CONFIG_PATH}: ${fileReadErrorText(err)}`,
    );
  }
}

function writeFile(config: BraveConfigFile): void {
  mkdirSync(BRAVE_SETTINGS_DIR, { recursive: true });
  const tmp = `${BRAVE_CONFIG_PATH}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(config, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  renameSync(tmp, BRAVE_CONFIG_PATH);
}

function normalizeConfig(config: BraveConfigFile): BraveConfigFile {
  return {
    enabled: config.enabled === true,
    ...(typeof config.apiKey === "string" && config.apiKey.trim()
      ? { apiKey: config.apiKey.trim() }
      : {}),
  };
}

function publicSettings(config: BraveConfigFile): BraveSettings {
  const normalized = normalizeConfig(config);
  return {
    enabled: normalized.enabled === true,
    apiKeyConfigured: Boolean(normalized.apiKey),
  };
}

export function getBraveSettings(): BraveSettings {
  return publicSettings(readFile());
}

export function updateBraveSettings(patch: BraveSettingsPatch): BraveSettings {
  const current = normalizeConfig(readFile());
  // `applyPatch`, not a spread: `clearApiKey` must REMOVE the stored key, and a
  // plain spread would leave it present-and-undefined.
  const next: BraveConfigFile = applyPatch(current, {
    ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
    ...(patch.clearApiKey ? { apiKey: undefined } : {}),
    ...(patch.apiKey && patch.apiKey.trim()
      ? { apiKey: patch.apiKey.trim() }
      : {}),
  });
  writeFile(normalizeConfig(next));
  return getBraveSettings();
}

/**
 * The real key for tool code, guarded by the enable+configured gate. Throws a
 * user-actionable error (surfaced to the agent) when web search is unusable.
 */
export function getBraveToolConfig(): { apiKey: string } {
  const config = normalizeConfig(readFile());
  if (!config.enabled) {
    throw new Error(
      "Web search is disabled. Enable it in Settings → Web Search.",
    );
  }
  if (!config.apiKey) {
    throw new Error(
      "Web search is not configured: add a Brave Search API key in Settings → Web Search.",
    );
  }
  return { apiKey: config.apiKey };
}

/** Validate the saved key with a minimal live query. */
export async function testBraveSettings(
  signal?: AbortSignal,
): Promise<BraveConnectionStatus> {
  const config = normalizeConfig(readFile());
  const checkedAt = Date.now();
  if (!config.enabled) {
    return { ok: true, checkedAt, message: "Web search is disabled." };
  }
  if (!config.apiKey) {
    return {
      ok: false,
      checkedAt,
      message: "A Brave Search API key is required.",
    };
  }
  const url = new URL(BRAVE_ENDPOINT);
  url.searchParams.set("q", "test");
  url.searchParams.set("count", "1");
  const res = await fetch(url, {
    headers: {
      Accept: "application/json",
      "Accept-Encoding": "gzip",
      "X-Subscription-Token": config.apiKey,
    },
    signal: deadlineSignal(15_000, signal),
  });
  if (!res.ok) {
    const body = (await res.text().catch(() => "")).slice(0, 300);
    return {
      ok: false,
      checkedAt,
      message: `Brave Search returned HTTP ${res.status}. ${body}`.trim(),
    };
  }
  return { ok: true, checkedAt, message: "Brave Search API key is valid." };
}
