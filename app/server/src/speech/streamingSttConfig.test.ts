import assert from "node:assert/strict";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "vitest";
import { DEFAULT_SPEECH_CONVERSATION_SETTINGS } from "@assistant/shared";
import { availableSttModels, resetSttConfigCache } from "./sttConfig.ts";
import {
  describeConversationAvailability,
  probeStreamingRecognizer,
  resolveStreamingSttRuntime,
} from "./streamingSttConfig.ts";

const id = "nemotron-streaming-en-560ms-int8";
const savedEnv = { ...process.env };
let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "streaming-stt-config-"));
  for (const key of Object.keys(process.env))
    if (key.startsWith("ASSISTANT_STT_")) delete process.env[key];
  process.env.PATH = dir;
  resetSttConfigCache();
});
afterEach(() => {
  process.env = { ...savedEnv };
  resetSttConfigCache();
  rmSync(dir, { recursive: true, force: true });
});

function host(version = "1.13.8"): void {
  const bin = join(dir, "sherpa-onnx-online-websocket-server");
  writeFileSync(bin, "stub");
  const versionBin = join(dir, "sherpa-onnx-version");
  writeFileSync(
    versionBin,
    `#!/bin/sh\necho 'sherpa-onnx version : ${version}'\n`,
  );
  chmodSync(versionBin, 0o755);
  process.env.ASSISTANT_STT_STREAMING_SERVER_BIN = bin;
  const model = join(dir, "model");
  mkdirSync(model);
  for (const file of [
    "encoder.int8.onnx",
    "decoder.int8.onnx",
    "joiner.int8.onnx",
    "tokens.txt",
  ])
    writeFileSync(join(model, file), "stub");
  process.env.ASSISTANT_STT_MODELS = JSON.stringify({ [id]: model });
}

test("accepts >=1.13.5, caches the probe, and projects the streaming model separately", async () => {
  host("1.13.5");
  const runtime = await resolveStreamingSttRuntime(
    DEFAULT_SPEECH_CONVERSATION_SETTINGS,
  );
  assert.equal(runtime.ok, true);
  assert.deepEqual(
    describeConversationAvailability(DEFAULT_SPEECH_CONVERSATION_SETTINGS),
    {
      configured: true,
      modelId: id,
      recognizerVersion: "1.13.5",
      availableModelIds: [id],
    },
  );
  writeFileSync(join(dir, "sherpa-onnx-version"), "broken");
  assert.equal((await probeStreamingRecognizer()).ok, true);
  assert.deepEqual(
    availableSttModels(),
    [],
    "streaming weights cannot become offline dictation models",
  );
});

test.each(["1.13.3", "1.13.4", "0.99.9"])(
  "rejects old sherpa %s with an actionable reason",
  async (version) => {
    host(version);
    const runtime = await resolveStreamingSttRuntime(
      DEFAULT_SPEECH_CONVERSATION_SETTINGS,
    );
    assert.equal(runtime.ok, false);
    assert.match(
      !runtime.ok ? runtime.reason : "",
      /requires sherpa-onnx >= 1\.13\.5/,
    );
  },
);

test.each(["1.13.8", "1.14.0", "2.0.0"])(
  "accepts sherpa %s",
  async (version) => {
    host(version);
    assert.equal(
      (await resolveStreamingSttRuntime(DEFAULT_SPEECH_CONVERSATION_SETTINGS))
        .ok,
      true,
    );
  },
);

test("missing and malformed version reports disable conversation only", async () => {
  host("unparseable");
  const result = await probeStreamingRecognizer();
  assert.equal(result.ok, false);
  assert.match(!result.ok ? result.reason : "", /Cannot verify/);
});

test("kill switch wins over discovery and hides available models", async () => {
  host();
  process.env.ASSISTANT_STT_DISABLED = "1";
  assert.equal((await probeStreamingRecognizer()).ok, false);
  assert.deepEqual(
    describeConversationAvailability(DEFAULT_SPEECH_CONVERSATION_SETTINGS)
      .availableModelIds,
    [],
  );
});

test("missing binary, missing files and an offline selection report distinct reasons", async () => {
  assert.match(
    describeConversationAvailability(DEFAULT_SPEECH_CONVERSATION_SETTINGS)
      .reason!,
    /Recognizer not found/,
  );
  host();
  await probeStreamingRecognizer();
  assert.match(
    describeConversationAvailability({
      ...DEFAULT_SPEECH_CONVERSATION_SETTINGS,
      modelId: "parakeet-tdt-600m-v2-int8",
    }).reason!,
    /Unknown streaming/,
  );
  process.env.ASSISTANT_STT_MODELS = "{}";
  assert.match(
    describeConversationAvailability(DEFAULT_SPEECH_CONVERSATION_SETTINGS)
      .reason!,
    /model files not found/,
  );
});

test("streaming single-dir override never supplies the offline recognizer", async () => {
  host();
  process.env.ASSISTANT_STT_STREAMING_MODEL_DIR = join(dir, "model");
  delete process.env.ASSISTANT_STT_MODELS;
  assert.equal(
    (await resolveStreamingSttRuntime(DEFAULT_SPEECH_CONVERSATION_SETTINGS)).ok,
    true,
  );
  assert.deepEqual(availableSttModels(), []);
});
