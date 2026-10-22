import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import type {
  SpeechConversationSettings,
  SpeechConversationStatus,
} from "@assistant/shared";
import { CWD } from "../config.ts";
import { brokerExecFile } from "../spawnBroker.ts";
import {
  availableSttModels,
  isSttDisabled,
  resolveSpeechBinary,
  sttCatalog,
  type ResolvedSttModel,
} from "./sttConfig.ts";

const SERVER_BIN = "sherpa-onnx-online-websocket-server";
const MIN_VERSION = "1.13.5";
type VersionResult =
  { ok: true; version: string } | { ok: false; reason: string };
let versionCache:
  | { key: string; pending: Promise<VersionResult>; result?: VersionResult }
  | undefined;

function binary(): string | undefined {
  return resolveSpeechBinary(SERVER_BIN, "ASSISTANT_STT_STREAMING_SERVER_BIN");
}

function versionBinary(server: string): string {
  return (
    process.env.ASSISTANT_STT_VERSION_BIN?.trim() ||
    join(dirname(server), "sherpa-onnx-version")
  );
}

function versionKey(server: string): string {
  return `${server}\n${versionBinary(server)}`;
}

/** Probe once at boot through the spawn broker, never on a synchronous settings read. */
export async function probeStreamingRecognizer(): Promise<VersionResult> {
  if (isSttDisabled())
    return {
      ok: false,
      reason:
        "Conversation is disabled for this instance (ASSISTANT_STT_DISABLED).",
    };
  const server = binary();
  if (!server)
    return {
      ok: false,
      reason: `Recognizer not found: ${SERVER_BIN}. Set ASSISTANT_STT_STREAMING_SERVER_BIN or PATH.`,
    };
  const key = versionKey(server);
  if (versionCache?.key === key) return versionCache.pending;
  const cache: NonNullable<typeof versionCache> = {
    key,
    pending: checkVersion(versionBinary(server)),
  };
  versionCache = cache;
  cache.result = await cache.pending;
  return cache.result;
}

async function checkVersion(file: string): Promise<VersionResult> {
  const unavailable = `Cannot verify sherpa-onnx version. Conversation requires >= ${MIN_VERSION}; provide sherpa-onnx-version next to the online server or set ASSISTANT_STT_VERSION_BIN.`;
  if (!existsSync(file)) return { ok: false, reason: unavailable };
  try {
    const result = await brokerExecFile({
      file,
      args: [],
      cwd: CWD,
      env: process.env,
      encoding: "utf8",
      maxBuffer: 16_384,
      signal: AbortSignal.timeout(5_000),
    });
    if (result.error) return { ok: false, reason: unavailable };
    const match = /sherpa-onnx version\s*:\s*(\d+)\.(\d+)\.(\d+)/.exec(
      `${result.stdout}\n${result.stderr}`,
    );
    if (!match) return { ok: false, reason: unavailable };
    const version = `${match[1]}.${match[2]}.${match[3]}`;
    const [major, minor, patch] = [
      Number(match[1]),
      Number(match[2]),
      Number(match[3]),
    ];
    if (
      major! < 1 ||
      (major === 1 && (minor! < 13 || (minor === 13 && patch! < 5)))
    ) {
      return {
        ok: false,
        reason: `Conversation requires sherpa-onnx >= ${MIN_VERSION}; found ${version}. Older versions drop streaming subwords. Offline dictation is still available.`,
      };
    }
    return { ok: true, version };
  } catch {
    return { ok: false, reason: unavailable };
  }
}

type Runtime =
  | { ok: true; binary: string; model: ResolvedSttModel; version: string }
  | { ok: false; reason: string };

function resolveWithVersion(
  settings: SpeechConversationSettings,
  version: VersionResult | undefined,
): Runtime {
  if (isSttDisabled())
    return {
      ok: false,
      reason:
        "Conversation is disabled for this instance (ASSISTANT_STT_DISABLED).",
    };
  const server = binary();
  if (!server)
    return {
      ok: false,
      reason: `Recognizer not found: ${SERVER_BIN}. Set ASSISTANT_STT_STREAMING_SERVER_BIN or PATH.`,
    };
  if (!version)
    return { ok: false, reason: "Checking streaming recognizer version." };
  if (!version.ok) return version;
  const models = availableSttModels("streaming");
  const wanted = settings.modelId.trim();
  const model = wanted
    ? models.find((entry) => entry.id === wanted)
    : models[0];
  if (!model) {
    const catalog = sttCatalog().filter((entry) => entry.mode === "streaming");
    if (wanted && !catalog.some((entry) => entry.id === wanted))
      return {
        ok: false,
        reason: `Unknown streaming speech model id "${wanted}".`,
      };
    return {
      ok: false,
      reason:
        "Streaming speech model files not found. Set ASSISTANT_STT_MODELS (id to directory map) or ASSISTANT_STT_STREAMING_MODEL_DIR, or run `pnpm run stt:model nemotron-streaming-en-560ms-int8`.",
    };
  }
  return { ok: true, binary: server, model, version: version.version };
}

export async function resolveStreamingSttRuntime(
  settings: SpeechConversationSettings,
): Promise<Runtime> {
  return resolveWithVersion(settings, await probeStreamingRecognizer());
}

/** Synchronous, secret-free ready/settings projection, after the startup probe. */
export function describeConversationAvailability(
  settings: SpeechConversationSettings,
): SpeechConversationStatus {
  const server = binary();
  const version =
    server && versionCache?.key === versionKey(server)
      ? versionCache.result
      : undefined;
  const runtime = resolveWithVersion(settings, version);
  return {
    configured: runtime.ok,
    ...(runtime.ok
      ? { modelId: runtime.model.id, recognizerVersion: runtime.version }
      : { reason: runtime.reason }),
    availableModelIds: isSttDisabled()
      ? []
      : availableSttModels("streaming").map((entry) => entry.id),
  };
}
