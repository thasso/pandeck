/**
 * Where the speech-to-text runtime and model weights come from.
 *
 * Three layers, three owners:
 *  - the model *catalog* (`config/stt-models.json`) is committed source, shared
 *    with `flake.nix` and the dev `stt:model` script so a URL/hash is never
 *    written twice;
 *  - the model *location* is deployment wiring injected as env
 *    (`ASSISTANT_STT_MODELS`, a JSON `id → dir` map, or the single-directory
 *    `ASSISTANT_STT_MODEL_DIR`), never user settings — weights belong outside the
 *    Borg-snapshotted `DATA_DIR`;
 *  - model *choice and behavior* are user settings (`speechToText.modelId`), and
 *    deliberately name an id rather than a path so the Settings UI can never
 *    point the recognizer at an arbitrary directory.
 *
 * Nothing here downloads anything, and nothing here is deployed by the app:
 * dictation is an OPTIONAL HOST CAPABILITY. The operator provides the recognizer
 * (on PATH) and the weights (in a directory); this module discovers them and
 * reports a reason when it cannot, which is what disables the mic button.
 * `ASSISTANT_STT_DISABLED` beats discovery entirely — see resolveSttRuntime. Dev
 * runs `pnpm run stt:model` once (a `nix build --out-link` into the fallback
 * slot).
 */
import { existsSync, readFileSync } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";
import type {
  SpeechToTextSettings,
  SpeechToTextStatus,
} from "@assistant/shared";
import { CWD, DATA_DIR } from "../config.ts";
import { PACKAGED_CONFIG_DIR } from "../runtimeAssets.ts";

/** Recognizer executable name; a warm long-lived process, not a per-utterance CLI. */
const SERVER_BIN = "sherpa-onnx-offline-websocket-server";

/** One catalog entry from `config/stt-models.json`. */
export interface SttModelCatalogEntry {
  id: string;
  label: string;
  language: string;
  url: string;
  sha256: string;
  stripPrefix: string;
  encoder: string;
  decoder: string;
  joiner: string;
  tokens: string;
}

/** A model whose files were all found on disk, ready to hand to the recognizer. */
export interface ResolvedSttModel {
  id: string;
  label: string;
  dir: string;
  encoder: string;
  decoder: string;
  joiner: string;
  tokens: string;
}

/** Catalog path: prefer the agent workspace's copy, else the one bundled with the build. */
function catalogPath(): string {
  const fromEnv = process.env.ASSISTANT_STT_CATALOG?.trim();
  if (fromEnv) return fromEnv;
  const cwdPath = join(CWD, "config", "stt-models.json");
  return existsSync(cwdPath)
    ? cwdPath
    : join(PACKAGED_CONFIG_DIR, "stt-models.json");
}

let catalogCache: SttModelCatalogEntry[] | undefined;

/** Parsed catalog, or an empty list when the file is missing/unreadable. */
export function sttCatalog(): SttModelCatalogEntry[] {
  if (catalogCache) return catalogCache;
  const path = catalogPath();
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as {
      models?: unknown;
    };
    const models = Array.isArray(parsed.models) ? parsed.models : [];
    catalogCache = models.filter(isCatalogEntry);
  } catch {
    catalogCache = [];
  }
  return catalogCache;
}

/** Test seam: drop the memoized catalog so a changed file/env is picked up. */
export function resetSttConfigCache(): void {
  catalogCache = undefined;
}

function isCatalogEntry(value: unknown): value is SttModelCatalogEntry {
  if (typeof value !== "object" || value === null) return false;
  const entry = value as Record<string, unknown>;
  return [
    "id",
    "label",
    "language",
    "url",
    "sha256",
    "stripPrefix",
    "encoder",
    "decoder",
    "joiner",
    "tokens",
  ].every(
    (key) =>
      typeof entry[key] === "string" && (entry[key] as string).length > 0,
  );
}

/**
 * Directories to search for each catalogued model, most authoritative first:
 * the deployment's env map, a single-directory override (handy inside
 * `nix shell nixpkgs#sherpa-onnx`), then the dev fallback slot under DATA_DIR.
 */
function candidateDirs(entry: SttModelCatalogEntry): string[] {
  const dirs: string[] = [];
  const fromMap = envModelMap()[entry.id];
  if (fromMap) dirs.push(fromMap);
  const single = process.env.ASSISTANT_STT_MODEL_DIR?.trim();
  if (single) dirs.push(single);
  dirs.push(join(DATA_DIR, "models", "stt", entry.id));
  return dirs;
}

/** `ASSISTANT_STT_MODELS` as a `{ id: dir }` map; `{}` when unset or malformed. */
function envModelMap(): Record<string, string> {
  const raw = process.env.ASSISTANT_STT_MODELS?.trim();
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
      return {};
    const out: Record<string, string> = {};
    for (const [id, dir] of Object.entries(parsed)) {
      if (typeof dir === "string" && dir.trim()) out[id] = dir.trim();
    }
    return out;
  } catch {
    return {};
  }
}

/**
 * First directory holding every file the catalog entry promises. A partially
 * extracted or wrong directory counts as missing rather than being handed to the
 * recognizer, which would fail much later with an opaque error.
 */
function resolveModel(
  entry: SttModelCatalogEntry,
): ResolvedSttModel | undefined {
  for (const dir of candidateDirs(entry)) {
    const files = {
      encoder: join(dir, entry.encoder),
      decoder: join(dir, entry.decoder),
      joiner: join(dir, entry.joiner),
      tokens: join(dir, entry.tokens),
    };
    if (Object.values(files).every((file) => existsSync(file))) {
      return { id: entry.id, label: entry.label, dir, ...files };
    }
  }
  return undefined;
}

/** Every catalogued model present on this instance. */
export function availableSttModels(): ResolvedSttModel[] {
  return sttCatalog()
    .map(resolveModel)
    .filter((model): model is ResolvedSttModel => model !== undefined);
}

/** Whether this instance is forbidden to dictate regardless of what it can find. */
function isSttDisabled(): boolean {
  const raw = process.env.ASSISTANT_STT_DISABLED?.trim();
  return raw !== undefined && raw !== "" && raw !== "0" && raw !== "false";
}

/** Recognizer executable: explicit env override, else a PATH lookup. */
function resolveSttBinary(): string | undefined {
  const fromEnv = process.env.ASSISTANT_STT_SERVER_BIN?.trim();
  if (fromEnv) return existsSync(fromEnv) ? fromEnv : undefined;
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, SERVER_BIN);
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

/** The model to use: the configured id when present, else the first available. */
export function selectSttModel(
  settings: SpeechToTextSettings,
): ResolvedSttModel | undefined {
  const models = availableSttModels();
  const wanted = settings.modelId.trim();
  if (wanted) return models.find((model) => model.id === wanted);
  return models[0];
}

/**
 * Binary + model together, or a reason the pair could not be assembled.
 *
 * `ASSISTANT_STT_DISABLED` is checked FIRST and beats discovery. Dictation is an
 * optional host capability found by a PATH lookup, so an instance that must not
 * dictate — a PR preview, which would warm its own ~1.9 GB recognizer — cannot
 * rely on the recognizer being absent from the host.
 */
export function resolveSttRuntime(
  settings: SpeechToTextSettings,
):
  | { ok: true; binary: string; model: ResolvedSttModel }
  | { ok: false; reason: string } {
  if (isSttDisabled()) {
    return {
      ok: false,
      reason:
        "Dictation is disabled for this instance (ASSISTANT_STT_DISABLED).",
    };
  }
  const binary = resolveSttBinary();
  if (!binary) {
    return {
      ok: false,
      reason: `Recognizer not found: ${SERVER_BIN} is not on PATH and ASSISTANT_STT_SERVER_BIN is unset.`,
    };
  }
  const model = selectSttModel(settings);
  if (!model) {
    const wanted = settings.modelId.trim();
    const catalog = sttCatalog();
    if (catalog.length === 0)
      return {
        ok: false,
        reason: "No speech models are catalogued in config/stt-models.json.",
      };
    if (wanted && !catalog.some((entry) => entry.id === wanted)) {
      return {
        ok: false,
        reason: `Unknown speech model id "${wanted}". Catalogued: ${catalog.map((e) => e.id).join(", ")}.`,
      };
    }
    const searched = candidateDirs(
      wanted ? catalog.find((e) => e.id === wanted)! : catalog[0]!,
    );
    return {
      ok: false,
      reason: `Speech model files not found. Searched: ${searched.join(", ")}. Run \`pnpm run stt:model\` in dev, or install weights on the host and point ASSISTANT_STT_MODEL_DIR at them (\`nix build .#stt-model-${wanted || catalog[0]!.id}\` builds a hash-verified copy).`,
    };
  }
  return { ok: true, binary, model };
}

/** Status projection for `ready`, so the composer can explain a disabled mic button. */
export function describeSttAvailability(
  settings: SpeechToTextSettings,
): SpeechToTextStatus {
  // A disabled instance advertises NO models, even though it could discover
  // them: the ids drive the Settings model picker, and offering a choice that
  // cannot take effect is worse than an empty list next to the reason.
  const available = isSttDisabled()
    ? []
    : availableSttModels().map((model) => model.id);
  const runtime = resolveSttRuntime(settings);
  return {
    configured: runtime.ok,
    ...(runtime.ok
      ? { modelId: runtime.model.id }
      : { reason: runtime.reason }),
    availableModelIds: available,
    maxUtteranceSeconds: settings.maxUtteranceSeconds,
  };
}

/**
 * Where the recognizer writes its own log. Verified to contain only
 * connect/disconnect lines (no transcripts), but it appends forever — so keep it
 * out of the backed-up `DATA_DIR` unless explicitly redirected.
 */
export function sttLogPath(): string {
  const fromEnv = process.env.ASSISTANT_STT_LOG?.trim();
  if (fromEnv) return isAbsolute(fromEnv) ? fromEnv : join(CWD, fromEnv);
  return join(process.env.TMPDIR?.trim() || "/tmp", "assistant-stt.log");
}
