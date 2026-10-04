import {
  applyPatch,
  OPENAI_COMPATIBLE_THINKING_FORMATS,
} from "@assistant/shared";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type {
  OpenAiCompatibleConnectionStatus,
  OpenAiCompatibleModelInfo,
  OpenAiCompatibleSettings,
  OpenAiCompatibleSettingsPatch,
  OpenAiCompatibleThinkingFormat,
} from "@assistant/shared";
import { DATA_DIR } from "./config.ts";
import { errorText, fileReadErrorText } from "./errors.ts";
import { deadlineSignal } from "./httpRetry.ts";

const OPENAI_COMPATIBLE_SETTINGS_DIR = join(DATA_DIR, "settings");
const OPENAI_COMPATIBLE_CONFIG_PATH = join(
  OPENAI_COMPATIBLE_SETTINGS_DIR,
  "openai-compatible.json",
);
const DEFAULT_NAME = "OpenAI-compatible";

interface OpenAiCompatibleConfigFile {
  enabled?: boolean;
  name?: string;
  baseUrl?: string;
  apiKey?: string;
  thinkingFormat?: OpenAiCompatibleThinkingFormat;
  models?: OpenAiCompatibleModelInfo[];
}

interface NormalizedConfig {
  enabled: boolean;
  name: string;
  baseUrl: string;
  apiKey?: string;
  thinkingFormat: OpenAiCompatibleThinkingFormat;
  models: OpenAiCompatibleModelInfo[];
}

function readFile(): OpenAiCompatibleConfigFile {
  if (!existsSync(OPENAI_COMPATIBLE_CONFIG_PATH)) return {};
  try {
    const parsed = JSON.parse(
      readFileSync(OPENAI_COMPATIBLE_CONFIG_PATH, "utf8"),
    ) as OpenAiCompatibleConfigFile;
    return parsed ?? {};
  } catch (err) {
    throw new Error(
      `Failed to read OpenAI-compatible provider config at ${OPENAI_COMPATIBLE_CONFIG_PATH}: ${fileReadErrorText(err)}`,
    );
  }
}

function writeFile(config: OpenAiCompatibleConfigFile): void {
  mkdirSync(OPENAI_COMPATIBLE_SETTINGS_DIR, { recursive: true });
  const tmp = `${OPENAI_COMPATIBLE_CONFIG_PATH}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  renameSync(tmp, OPENAI_COMPATIBLE_CONFIG_PATH);
}

function normalizeBaseUrl(baseUrl: string | undefined): string {
  return (baseUrl ?? "").trim().replace(/\/+$/, "");
}

function normalizeName(name: string | undefined): string {
  return (name ?? "").trim() || DEFAULT_NAME;
}

function normalizeThinkingFormat(
  value: unknown,
): OpenAiCompatibleThinkingFormat {
  return (
    OPENAI_COMPATIBLE_THINKING_FORMATS.find((format) => format === value) ??
    "none"
  );
}

function normalizeModel(
  model: Partial<OpenAiCompatibleModelInfo> | undefined,
  reasoning: boolean,
): OpenAiCompatibleModelInfo | undefined {
  if (!model || typeof model.id !== "string" || !model.id.trim())
    return undefined;
  const id = model.id.trim();
  const input: Array<"text" | "image"> =
    Array.isArray(model.input) && model.input.length > 0
      ? ([
          ...new Set(
            model.input.filter(
              (value) => value === "text" || value === "image",
            ),
          ),
        ] as Array<"text" | "image">)
      : ["text"];
  return {
    id,
    name:
      typeof model.name === "string" && model.name.trim()
        ? model.name.trim()
        : id,
    input: input.length > 0 ? input : ["text"],
    contextWindow: positiveInteger(model.contextWindow) ?? 128_000,
    maxTokens: positiveInteger(model.maxTokens) ?? 16_384,
    reasoning,
    ...(typeof model.ownedBy === "string" && model.ownedBy
      ? { ownedBy: model.ownedBy }
      : {}),
    ...(typeof model.status === "string" && model.status
      ? { status: model.status }
      : {}),
    ...(typeof model.parameterCount === "number" &&
    Number.isFinite(model.parameterCount)
      ? { parameterCount: model.parameterCount }
      : {}),
    ...(typeof model.sizeBytes === "number" && Number.isFinite(model.sizeBytes)
      ? { sizeBytes: model.sizeBytes }
      : {}),
  };
}

/**
 * Whether a model reasons follows the endpoint's thinking format rather than a
 * guess from its id: with a format set, pi offers thinking levels and sends
 * them the way that format expects; with "none" it sends no thinking control.
 * So a stored `reasoning` is always recomputed on read.
 */
function normalizeConfig(config: OpenAiCompatibleConfigFile): NormalizedConfig {
  const thinkingFormat = normalizeThinkingFormat(config.thinkingFormat);
  const reasoning = thinkingFormat !== "none";
  const models = Array.isArray(config.models)
    ? config.models
        .map((model) => normalizeModel(model, reasoning))
        .filter((model): model is OpenAiCompatibleModelInfo => Boolean(model))
    : [];
  return {
    enabled: config.enabled === true,
    name: normalizeName(config.name),
    baseUrl: normalizeBaseUrl(config.baseUrl),
    ...(typeof config.apiKey === "string" && config.apiKey
      ? { apiKey: config.apiKey }
      : {}),
    thinkingFormat,
    models,
  };
}

export function getOpenAiCompatibleSettings(): OpenAiCompatibleSettings {
  const config = normalizeConfig(readFile());
  return {
    enabled: config.enabled,
    name: config.name,
    baseUrl: config.baseUrl,
    apiKeyConfigured: Boolean(config.apiKey),
    thinkingFormat: config.thinkingFormat,
    models: config.models,
  };
}

/** Just the display name: one small read, for projections that need no models. */
export function getOpenAiCompatibleName(): string {
  return normalizeName(readFile().name);
}

export function updateOpenAiCompatibleSettings(
  patch: OpenAiCompatibleSettingsPatch,
): OpenAiCompatibleSettings {
  const current = normalizeConfig(readFile());
  const baseUrl =
    patch.baseUrl !== undefined ? normalizeBaseUrl(patch.baseUrl) : undefined;
  // Discovered ids belong to the server that listed them. A new endpoint starts
  // with none, so a failed discovery cannot leave the old ids registered
  // against it.
  const endpointChanged = baseUrl !== undefined && baseUrl !== current.baseUrl;
  // See braveSettings: `clearApiKey` must REMOVE the key, not blank it.
  const next: OpenAiCompatibleConfigFile = applyPatch(current, {
    ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
    ...(patch.name !== undefined ? { name: normalizeName(patch.name) } : {}),
    ...(baseUrl !== undefined ? { baseUrl } : {}),
    ...(endpointChanged ? { models: [] } : {}),
    ...(patch.thinkingFormat !== undefined
      ? { thinkingFormat: normalizeThinkingFormat(patch.thinkingFormat) }
      : {}),
    ...(patch.clearApiKey ? { apiKey: undefined } : {}),
    ...(patch.apiKey && patch.apiKey.trim()
      ? { apiKey: patch.apiKey.trim() }
      : {}),
  });
  writeFile(normalizeConfig(next));
  return getOpenAiCompatibleSettings();
}

interface OpenAiCompatibleCompat {
  thinkingFormat?: Exclude<OpenAiCompatibleThinkingFormat, "none">;
  supportsReasoningEffort: boolean;
  maxTokensField: "max_tokens";
}

interface RegistryModelConfig {
  id: string;
  name: string;
  reasoning: boolean;
  input: ("text" | "image")[];
  cost: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
  };
  contextWindow: number;
  maxTokens: number;
  compat: OpenAiCompatibleCompat;
}

export interface OpenAiCompatibleProviderConfigForRegistry {
  name: string;
  baseUrl: string;
  apiKey: string;
  api: "openai-completions";
  compat: OpenAiCompatibleCompat;
  models: RegistryModelConfig[];
}

/**
 * Pi's URL-based auto-detection knows nothing about a self-hosted endpoint, so
 * the conservative choices are explicit: `max_tokens`, which OpenAI-compatible
 * servers accept, and `reasoning_effort` only for the format built on it.
 */
function compatFor(
  thinkingFormat: OpenAiCompatibleThinkingFormat,
): OpenAiCompatibleCompat {
  return {
    ...(thinkingFormat !== "none" ? { thinkingFormat } : {}),
    supportsReasoningEffort: thinkingFormat === "openai",
    maxTokensField: "max_tokens",
  };
}

export function getOpenAiCompatibleProviderConfigForRegistry():
  OpenAiCompatibleProviderConfigForRegistry | undefined {
  const config = normalizeConfig(readFile());
  if (!config.enabled || !config.baseUrl || config.models.length === 0)
    return undefined;
  const compat = compatFor(config.thinkingFormat);
  return {
    name: config.name,
    baseUrl: config.baseUrl,
    // Pi only offers a provider that has a key. A local server commonly takes
    // none and ignores the header, so an unset key sends a placeholder.
    apiKey: config.apiKey ?? "none",
    api: "openai-completions",
    compat,
    models: config.models.map((model) => ({
      id: model.id,
      name: model.name,
      reasoning: model.reasoning,
      input: model.input,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: model.contextWindow,
      maxTokens: model.maxTokens,
      // Dynamic ModelRegistry.registerProvider applies compat only from the
      // model definition (unlike models.json parsing, which merges provider
      // compat), so every model carries it.
      compat,
    })),
  };
}

export async function testOpenAiCompatibleSettings(
  signal?: AbortSignal,
): Promise<OpenAiCompatibleConnectionStatus> {
  const config = normalizeConfig(readFile());
  const checkedAt = Date.now();
  if (!config.enabled) {
    return {
      ok: true,
      checkedAt,
      message: `${config.name} provider is disabled.`,
      models: config.models,
    };
  }
  if (!config.baseUrl) {
    return {
      ok: false,
      checkedAt,
      message: "A base URL is required.",
      models: config.models,
    };
  }

  let discovered: OpenAiCompatibleModelInfo[];
  try {
    discovered = await discoverModels(config.baseUrl, config.apiKey, signal);
  } catch (err) {
    // A status, not a throw: the caller still re-syncs the registry and sends
    // fresh settings, which matters after an endpoint change cleared the models.
    return {
      ok: false,
      checkedAt,
      message: `Model discovery failed: ${redactCredentials(errorText(err), config)}`,
      models: config.models,
    };
  }
  // A cancelled test stores nothing, and discovery answers only for the
  // endpoint it asked: the config is read again so a change saved while the
  // request was out (disabled, another URL or key) is kept, not overwritten.
  signal?.throwIfAborted();
  const current = normalizeConfig(readFile());
  if (current.baseUrl !== config.baseUrl || current.apiKey !== config.apiKey)
    return {
      ok: false,
      checkedAt,
      message:
        "The provider settings changed during discovery. Test again to discover models for the new settings.",
      models: current.models,
    };
  const next = normalizeConfig({ ...current, models: discovered });
  writeFile(next);
  return {
    ok: true,
    checkedAt,
    message:
      next.models.length === 1
        ? `Discovered 1 ${config.name} model.`
        : `Discovered ${next.models.length} ${config.name} models.`,
    models: next.models,
  };
}

/**
 * Settings status is secret-free, but a failure message carries text the
 * endpoint chose: an error body may echo the Authorization it received, and a
 * base URL may carry `user:password@`. Both are cut before it leaves the server.
 */
function redactCredentials(
  message: string,
  config: Pick<NormalizedConfig, "apiKey" | "baseUrl">,
): string {
  let redacted = message;
  const secrets = [config.apiKey];
  try {
    const url = new URL(config.baseUrl);
    secrets.push(url.password, decodeURIComponent(url.password));
    secrets.push(url.username, decodeURIComponent(url.username));
  } catch {
    // Not a URL: nothing to take apart.
  }
  for (const secret of secrets)
    if (secret) redacted = redacted.split(secret).join("[redacted]");
  return redacted;
}

async function discoverModels(
  baseUrl: string,
  apiKey: string | undefined,
  signal?: AbortSignal,
): Promise<OpenAiCompatibleModelInfo[]> {
  const url = `${normalizeBaseUrl(baseUrl)}/models`;
  const res = await fetch(url, {
    ...(apiKey ? { headers: { Authorization: `Bearer ${apiKey}` } } : {}),
    signal: deadlineSignal(15_000, signal),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(
      `${url} returned HTTP ${res.status}: ${text.slice(0, 500)}`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch (err) {
    throw new Error(`${url} returned invalid JSON: ${String(err)}`);
  }
  const data =
    isRecord(parsed) && Array.isArray(parsed.data) ? parsed.data : [];
  return data
    .map(modelFromApi)
    .filter((model): model is OpenAiCompatibleModelInfo => Boolean(model));
}

/**
 * One `/models` entry. Only `id` is standard; the rest are optional server
 * extensions read when present: llama.cpp's `meta` (context size, parameter
 * count, file size) and `status`, and `architecture.input_modalities` as
 * OpenRouter-style servers report it.
 */
function modelFromApi(raw: unknown): OpenAiCompatibleModelInfo | undefined {
  if (!isRecord(raw) || typeof raw.id !== "string" || !raw.id.trim())
    return undefined;
  const architecture = isRecord(raw.architecture)
    ? raw.architecture
    : undefined;
  const meta = isRecord(raw.meta) ? raw.meta : undefined;
  const status =
    isRecord(raw.status) && typeof raw.status.value === "string"
      ? raw.status.value
      : undefined;
  const input = inputModalities(architecture?.input_modalities);
  const contextWindow =
    positiveInteger(meta?.n_ctx) ??
    positiveInteger(meta?.n_ctx_train) ??
    128_000;
  const id = raw.id.trim();
  return {
    id,
    name: id,
    input,
    contextWindow,
    maxTokens: Math.min(contextWindow, 16_384),
    // Recomputed from the thinking format by normalizeConfig.
    reasoning: false,
    ...(typeof raw.owned_by === "string" && raw.owned_by
      ? { ownedBy: raw.owned_by }
      : {}),
    ...(status ? { status } : {}),
    ...(positiveInteger(meta?.n_params)
      ? { parameterCount: positiveInteger(meta?.n_params)! }
      : {}),
    ...(positiveInteger(meta?.size)
      ? { sizeBytes: positiveInteger(meta?.size)! }
      : {}),
  };
}

function inputModalities(value: unknown): Array<"text" | "image"> {
  if (!Array.isArray(value)) return ["text"];
  const mapped = value
    .map((item) => (typeof item === "string" ? item.toLowerCase() : ""))
    .filter(
      (item): item is "text" | "image" => item === "text" || item === "image",
    );
  return mapped.length > 0 ? [...new Set(mapped)] : ["text"];
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
