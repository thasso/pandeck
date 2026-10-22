import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, afterEach, expect, test } from "vitest";
import { KOKORO_ENGLISH_VOICES } from "@assistant/shared";
import {
  describeTtsAvailability,
  probeTtsRuntime,
  resolveTtsRuntime,
} from "./ttsConfig.ts";

const env = { ...process.env };
let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tts-config-"));
  for (const name of Object.keys(process.env))
    if (name.startsWith("ASSISTANT_TTS_") || name === "ASSISTANT_STT_DISABLED")
      delete process.env[name];
  process.env.PATH = dir;
});
afterEach(() => {
  process.env = { ...env };
  rmSync(dir, { recursive: true, force: true });
});
function host(exit = 0) {
  const python = join(dir, "python3");
  writeFileSync(python, `#!/bin/sh\nexit ${exit}\n`);
  chmodSync(python, 0o755);
  process.env.ASSISTANT_TTS_PYTHON = python;
  process.env.ASSISTANT_TTS_MODEL_DIR = dir;
  for (const file of [
    "model.onnx",
    "voices.bin",
    "tokens.txt",
    "lexicon-us-en.txt",
    "lexicon-gb-en.txt",
  ])
    writeFileSync(join(dir, file), "stub");
  for (const name of ["dict", "espeak-ng-data"]) mkdirSync(join(dir, name));
}

test("host runtime is optional with a useful reason, independent of dictation", async () => {
  expect(describeTtsAvailability().reason).toMatch(/Python runtime not found/);
  host(1);
  await probeTtsRuntime();
  expect(describeTtsAvailability().reason).toMatch(/cannot import sherpa_onnx/);
});

test("probe imports no model, caches the capability and requires the complete fp32 directory", async () => {
  host();
  expect(resolveTtsRuntime()).toMatchObject({
    ok: false,
    reason: expect.stringMatching(/Checking/),
  });
  await probeTtsRuntime();
  expect(resolveTtsRuntime()).toEqual({
    ok: true,
    python: join(dir, "python3"),
    modelDir: dir,
    modelId: "kokoro-v1-fp32",
  });
  expect(describeTtsAvailability()).toMatchObject({
    configured: true,
    availableVoices: KOKORO_ENGLISH_VOICES.map((voice) => voice.name),
  });
  writeFileSync(join(dir, "python3"), "broken");
  await probeTtsRuntime();
  expect(resolveTtsRuntime().ok).toBe(true);
  rmSync(join(dir, "model.onnx"));
  writeFileSync(join(dir, "model.int8.onnx"), "not an fp32 substitute");
  expect(describeTtsAvailability().reason).toMatch(/complete fp32/);
});

test.each(["ASSISTANT_TTS_DISABLED", "ASSISTANT_STT_DISABLED"])(
  "%s disables inference even with a configured runtime",
  async (key) => {
    host();
    process.env[key] = "1";
    await probeTtsRuntime();
    expect(resolveTtsRuntime()).toEqual({
      ok: false,
      reason: "Speech synthesis is disabled for this instance.",
    });
  },
);
