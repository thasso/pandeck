/**
 * Runtime settings for the Context7 docs-search tools (`context7_resolve_library`,
 * `context7_get_docs`). The API key is a user-editable secret entered in
 * Settings → Context7 and stored privately under `DATA_DIR/settings/context7.json`
 * (mode 0600); it is never echoed back to the browser (the public projection
 * exposes only `apiKeyConfigured`). This is the sole source of the key — there
 * is no static/env fallback. Its senders read it through the secret store
 * (`secretStore.ts`), which holds the one origin it may go to.
 */
import { applyPatch } from "@assistant/shared";
import { join } from "node:path";
import type {
  Context7ConnectionStatus,
  Context7Settings,
  Context7SettingsPatch,
} from "@assistant/shared";
import { DATA_DIR } from "./config.ts";
import { createPrivateJsonFile } from "./privateJsonFile.ts";
import { deadlineSignal } from "./httpRetry.ts";
import { secretStore } from "./secretStore.ts";

const CONTEXT7_SETTINGS_DIR = join(DATA_DIR, "settings");
const CONTEXT7_CONFIG_PATH = join(CONTEXT7_SETTINGS_DIR, "context7.json");

/** Shared base URL for the Context7 v2 REST API (tools + connection test). */
export const CONTEXT7_API_BASE = "https://context7.com/api/v2";

interface Context7ConfigFile {
  enabled?: boolean;
  apiKey?: string;
}

const privateFile = createPrivateJsonFile(
  CONTEXT7_CONFIG_PATH,
  "Context7 config",
);
const writeFile = privateFile.write;

function readFile(): Context7ConfigFile {
  return privateFile.read(
    (parsed: Context7ConfigFile | undefined) => parsed ?? {},
  );
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
 * The real key for tool code to send to `destination`, guarded by the
 * enable+configured gate. Throws a user-actionable error (surfaced to the
 * agent) when Context7 is unusable.
 */
export async function getContext7ToolConfig(
  destination: URL,
): Promise<{ apiKey: string }> {
  const config = normalizeConfig(readFile());
  if (!config.enabled) {
    throw new Error(
      "Context7 docs search is disabled. Enable it in Settings → Context7.",
    );
  }
  const apiKey = await secretStore.read("context7.apiKey", destination);
  if (!apiKey) {
    throw new Error(
      "Context7 is not configured: add a Context7 API key in Settings → Context7.",
    );
  }
  return { apiKey };
}

/** Validate the saved key with a minimal live library search. */
export async function testContext7Settings(
  signal?: AbortSignal,
): Promise<Context7ConnectionStatus> {
  const config = normalizeConfig(readFile());
  const checkedAt = Date.now();
  if (!config.enabled) {
    return {
      ok: true,
      checkedAt,
      message: "Context7 docs search is disabled.",
    };
  }
  const url = new URL(`${CONTEXT7_API_BASE}/libs/search`);
  url.searchParams.set("libraryName", "react");
  const apiKey = await secretStore.read("context7.apiKey", url);
  if (!apiKey) {
    return { ok: false, checkedAt, message: "A Context7 API key is required." };
  }
  const res = await fetch(url, {
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    signal: deadlineSignal(15_000, signal),
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
