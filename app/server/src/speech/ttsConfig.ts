import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  KOKORO_ENGLISH_VOICES,
  type SpeechSynthesisStatus,
} from "@assistant/shared";
import { CWD, DATA_DIR } from "../config.ts";
import { PACKAGED_CONFIG_DIR } from "../runtimeAssets.ts";
import { brokerExecFile } from "../spawnBroker.ts";
import { resolveSpeechBinary } from "./sttConfig.ts";

interface TtsModel {
  id: string;
  required: string[];
}
export type TtsRuntime =
  | { ok: true; python: string; modelDir: string; modelId: string }
  | { ok: false; reason: string };
let probe:
  { key: string; pending: Promise<boolean>; available?: boolean } | undefined;

function python(): string | undefined {
  return resolveSpeechBinary("python3", "ASSISTANT_TTS_PYTHON");
}
function disabled(): boolean {
  return [
    process.env.ASSISTANT_TTS_DISABLED,
    process.env.ASSISTANT_STT_DISABLED,
  ].some((v) => v === "1" || v === "true");
}
function models(): TtsModel[] {
  // A checkout's catalog is authoritative in dev; packages use their own assets.
  const local = join(CWD, "config", "tts-models.json");
  try {
    const value = JSON.parse(
      readFileSync(
        existsSync(local)
          ? local
          : join(PACKAGED_CONFIG_DIR, "tts-models.json"),
        "utf8",
      ),
    ) as { models: TtsModel[] };
    return value.models.filter(
      (entry) =>
        typeof entry.id === "string" &&
        Array.isArray(entry.required) &&
        entry.required.every((file) => typeof file === "string"),
    );
  } catch {
    return [];
  }
}

/** Cheap startup capability probe, no model load and no runtime dependency in the app closure. */
export async function probeTtsRuntime(): Promise<void> {
  if (disabled()) return;
  const file = python();
  if (!file) return;
  if (probe?.key === file) return probe.pending.then(() => {});
  const current: NonNullable<typeof probe> = {
    key: file,
    pending: (async () => {
      try {
        const result = await brokerExecFile({
          file,
          args: [
            "-c",
            "import sherpa_onnx, numpy; assert all(hasattr(sherpa_onnx, name) for name in ('OfflineTtsKokoroModelConfig', 'OfflineTtsModelConfig', 'OfflineTtsConfig', 'OfflineTts', 'GenerationConfig'))",
          ],
          cwd: CWD,
          env: process.env,
          encoding: "utf8",
          maxBuffer: 16384,
          signal: AbortSignal.timeout(10000),
        });
        return !result.error;
      } catch {
        return false;
      }
    })(),
  };
  probe = current;
  current.available = await current.pending;
}

export function resolveTtsRuntime(): TtsRuntime {
  if (disabled())
    return {
      ok: false,
      reason: "Speech synthesis is disabled for this instance.",
    };
  const file = python();
  if (!file)
    return {
      ok: false,
      reason:
        "Python runtime not found. Set ASSISTANT_TTS_PYTHON to a Python with sherpa_onnx.",
    };
  if (probe?.key !== file || probe.available === undefined)
    return {
      ok: false,
      reason: "Checking Python sherpa_onnx speech synthesis capability.",
    };
  if (!probe.available)
    return {
      ok: false,
      reason:
        "Python cannot import sherpa_onnx with Kokoro support. Set ASSISTANT_TTS_PYTHON to a runtime with python3Packages.sherpa-onnx, then restart.",
    };
  for (const model of models()) {
    const dir =
      process.env.ASSISTANT_TTS_MODEL_DIR?.trim() ||
      join(DATA_DIR, "models", "tts", model.id);
    if (
      model.required.every((name) => {
        try {
          const stat = statSync(join(dir, name));
          return name === "dict" || name === "espeak-ng-data"
            ? stat.isDirectory()
            : stat.isFile();
        } catch {
          return false;
        }
      })
    )
      return { ok: true, python: file, modelDir: dir, modelId: model.id };
  }
  return {
    ok: false,
    reason:
      "Kokoro model files not found. Set ASSISTANT_TTS_MODEL_DIR or run `pnpm run tts:model`. The complete fp32 model directory is required.",
  };
}

export function describeTtsAvailability(): SpeechSynthesisStatus {
  const runtime = resolveTtsRuntime();
  return {
    configured: runtime.ok,
    ...(runtime.ok ? { modelId: runtime.modelId } : { reason: runtime.reason }),
    availableVoices: KOKORO_ENGLISH_VOICES.map((voice) => voice.name),
  };
}
