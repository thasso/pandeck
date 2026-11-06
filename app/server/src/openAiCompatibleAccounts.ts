/**
 * The endpoint half of an OpenAI-compatible account (`docs/settings.md`): its
 * base URL, optional key, thinking format and discovered models, in the
 * account's own private `credential-profiles/<id>/endpoint.json` (0600, its
 * directory 0700). The registry (`credentialProfiles.ts`) holds the account's
 * name, enabled switch, enterprise flag and priority, like any other.
 *
 * The key never leaves the server: summaries carry `apiKeyConfigured`, a
 * discovery failure is redacted, and the key stays with the origin it was
 * entered for (`urlOrigin.ts`).
 */
import {
  applyPatch,
  OPENAI_COMPATIBLE_THINKING_FORMATS,
  type OpenAiCompatibleConnectionStatus,
  type OpenAiCompatibleEndpointSummary,
  type OpenAiCompatibleModelInfo,
  type OpenAiCompatibleThinkingFormat,
} from "@assistant/shared";
import {
  normalizeOpenAiCompatibleBaseUrl,
  openAiCompatibleApiKeyError,
  openAiCompatibleBaseUrlError,
} from "@assistant/shared/openAiCompatibleValidation";
import { join } from "node:path";
import { credentialProfileRoot } from "./credentialProfilePaths.ts";
import { errorText } from "./errors.ts";
import { createPrivateJsonFile } from "./privateJsonFile.ts";
import { deadlineSignal } from "./httpRetry.ts";
import { sameOrigin } from "./urlOrigin.ts";

/** The key registered for an endpoint that has none: it pairs no credential. */
export const OPENAI_COMPATIBLE_KEYLESS = "none";

/** An account's endpoint as the server holds it, key included. */
export interface OpenAiCompatibleEndpoint {
  baseUrl: string;
  apiKey?: string;
  thinkingFormat: OpenAiCompatibleThinkingFormat;
  models: OpenAiCompatibleModelInfo[];
}

/** A validated endpoint edit. Secret fields are write-only. */
export interface OpenAiCompatibleEndpointPatch {
  baseUrl?: string;
  thinkingFormat?: OpenAiCompatibleThinkingFormat;
  apiKey?: string;
  clearApiKey?: boolean;
}

/** The account's private endpoint file. */
export function openAiCompatibleEndpointPath(profileId: string): string {
  return join(credentialProfileRoot(profileId), "endpoint.json");
}

function endpointFile(profileId: string) {
  return createPrivateJsonFile(
    openAiCompatibleEndpointPath(profileId),
    "OpenAI-compatible endpoint",
    { privateDirectory: "enforce" },
  );
}

/** The stored endpoint, normalized; an empty one when the file is absent. */
export function readOpenAiCompatibleEndpoint(
  profileId: string,
): OpenAiCompatibleEndpoint {
  return endpointFile(profileId).read((parsed: unknown) =>
    normalizeOpenAiCompatibleEndpoint(parsed),
  );
}

export function writeOpenAiCompatibleEndpoint(
  profileId: string,
  endpoint: OpenAiCompatibleEndpoint,
): void {
  endpointFile(profileId).write(normalizeOpenAiCompatibleEndpoint(endpoint));
}

export function openAiCompatibleEndpointSummary(
  endpoint: OpenAiCompatibleEndpoint,
): OpenAiCompatibleEndpointSummary {
  return {
    baseUrl: endpoint.baseUrl,
    apiKeyConfigured: Boolean(endpoint.apiKey),
    thinkingFormat: endpoint.thinkingFormat,
    models: endpoint.models,
  };
}

/** Ready to run: it has somewhere to send requests and something to run there. */
export function openAiCompatibleEndpointReady(
  endpoint: OpenAiCompatibleEndpoint,
): boolean {
  return Boolean(endpoint.baseUrl) && endpoint.models.length > 0;
}

function normalizeBaseUrl(baseUrl: unknown): string {
  return typeof baseUrl === "string"
    ? normalizeOpenAiCompatibleBaseUrl(baseUrl)
    : "";
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
 * So a stored `reasoning` is always recomputed on read. Also reads the former
 * settings file's fields (`migrateOpenAiCompatibleSettingsToAccount`).
 */
export function normalizeOpenAiCompatibleEndpoint(
  raw: unknown,
): OpenAiCompatibleEndpoint {
  const config = isRecord(raw) ? raw : {};
  const thinkingFormat = normalizeThinkingFormat(config.thinkingFormat);
  const reasoning = thinkingFormat !== "none";
  const models = Array.isArray(config.models)
    ? (config.models as Array<Partial<OpenAiCompatibleModelInfo>>)
        .map((model) => normalizeModel(model, reasoning))
        .filter((model): model is OpenAiCompatibleModelInfo => Boolean(model))
    : [];
  return {
    baseUrl: normalizeBaseUrl(config.baseUrl),
    ...(typeof config.apiKey === "string" && config.apiKey
      ? { apiKey: config.apiKey }
      : {}),
    thinkingFormat,
    models,
  };
}

/**
 * Apply an edit. Discovered ids belong to the server that listed them, so a
 * new base URL starts with none; the stored key stays with the origin it was
 * entered for, so a new origin drops it unless the same edit sets one.
 */
export function patchedOpenAiCompatibleEndpoint(
  current: OpenAiCompatibleEndpoint,
  patch: OpenAiCompatibleEndpointPatch,
): OpenAiCompatibleEndpoint {
  const baseUrl =
    patch.baseUrl !== undefined ? normalizeBaseUrl(patch.baseUrl) : undefined;
  const endpointChanged = baseUrl !== undefined && baseUrl !== current.baseUrl;
  // Compare the value that would be saved, not a form's trailing slash or
  // whitespace. Unchanged legacy values are deliberately not revalidated.
  if (endpointChanged) {
    const error = openAiCompatibleBaseUrlError(baseUrl);
    if (error) throw new Error(error);
  }
  const apiKey =
    patch.apiKey === current.apiKey ? patch.apiKey : patch.apiKey?.trim();
  if (apiKey && apiKey !== current.apiKey) {
    const error = openAiCompatibleApiKeyError(apiKey);
    if (error) throw new Error(error);
  }
  const originChanged =
    endpointChanged && !sameOrigin(current.baseUrl, baseUrl);
  // See braveSettings: `clearApiKey` must REMOVE the key, not blank it.
  const next = applyPatch(current, {
    ...(baseUrl !== undefined ? { baseUrl } : {}),
    ...(endpointChanged ? { models: [] } : {}),
    ...(patch.thinkingFormat !== undefined
      ? { thinkingFormat: normalizeThinkingFormat(patch.thinkingFormat) }
      : {}),
    ...(patch.clearApiKey || originChanged ? { apiKey: undefined } : {}),
    ...(apiKey ? { apiKey } : {}),
  });
  return normalizeOpenAiCompatibleEndpoint(next);
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

/**
 * The account's provider as pi's registry takes it, under the account's own
 * id; undefined until it has a base URL and models.
 */
export function openAiCompatibleProviderConfig(
  endpoint: OpenAiCompatibleEndpoint,
  name: string,
): OpenAiCompatibleProviderConfigForRegistry | undefined {
  if (!openAiCompatibleEndpointReady(endpoint)) return undefined;
  const compat = compatFor(endpoint.thinkingFormat);
  return {
    name,
    baseUrl: endpoint.baseUrl,
    // Pi only offers a provider that has a key. A local server commonly takes
    // none and ignores the header, so an unset key sends a placeholder.
    apiKey: endpoint.apiKey ?? OPENAI_COMPATIBLE_KEYLESS,
    api: "openai-completions",
    compat,
    models: endpoint.models.map((model) => ({
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

/**
 * Discover the account's models from its endpoint's `/models` and store them.
 * `stillExists` is asked before the write, so a discovery that outlives its
 * account's deletion never recreates its directory.
 */
export async function testOpenAiCompatibleEndpoint(
  profileId: string,
  options: { signal?: AbortSignal; stillExists: () => boolean },
): Promise<OpenAiCompatibleConnectionStatus> {
  const endpoint = readOpenAiCompatibleEndpoint(profileId);
  const checkedAt = Date.now();
  if (!endpoint.baseUrl) {
    return {
      ok: false,
      checkedAt,
      message: "A base URL is required.",
      models: endpoint.models,
    };
  }

  let discovered: OpenAiCompatibleModelInfo[];
  try {
    discovered = await discoverModels(
      endpoint.baseUrl,
      endpoint.apiKey,
      options.signal,
    );
  } catch (err) {
    // A status, not a throw: the caller still answers with the account's
    // current card, which matters after an endpoint change cleared the models.
    return {
      ok: false,
      checkedAt,
      message: `Model discovery failed: ${redactCredentials(errorText(err), endpoint)}`,
      models: endpoint.models,
    };
  }
  // A cancelled test stores nothing, and discovery answers only for the
  // endpoint it asked: the file is read again so a change saved while the
  // request was out (another URL or key) is kept, not overwritten.
  options.signal?.throwIfAborted();
  if (!options.stillExists()) throw new Error("Credential profile not found.");
  const current = readOpenAiCompatibleEndpoint(profileId);
  if (
    current.baseUrl !== endpoint.baseUrl ||
    current.apiKey !== endpoint.apiKey
  )
    return {
      ok: false,
      checkedAt,
      message:
        "The endpoint changed during discovery. Test again to discover models for the new settings.",
      models: current.models,
    };
  const next = normalizeOpenAiCompatibleEndpoint({
    ...current,
    models: discovered,
  });
  writeOpenAiCompatibleEndpoint(profileId, next);
  return {
    ok: true,
    checkedAt,
    message:
      next.models.length === 1
        ? "Discovered 1 model."
        : `Discovered ${next.models.length} models.`,
    models: next.models,
  };
}

/**
 * A status is secret-free, but a failure message carries text the endpoint
 * chose: an error body may echo the Authorization it received, and a base URL
 * may carry `user:password@`. Both are cut before it leaves the server.
 */
function redactCredentials(
  message: string,
  endpoint: Pick<OpenAiCompatibleEndpoint, "apiKey" | "baseUrl">,
): string {
  let redacted = message;
  const secrets = [endpoint.apiKey];
  try {
    const url = new URL(endpoint.baseUrl);
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
    // Recomputed from the thinking format on normalization.
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
