/**
 * The resolution chain matters operationally: a wrong answer here is what the
 * user sees as a mysteriously disabled mic button, so the failure messages must
 * name the paths that were actually searched.
 */
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
import type { SpeechToTextSettings } from "@assistant/shared";
import {
  availableSttModels,
  describeSttAvailability,
  resetSttConfigCache,
  resolveSttRuntime,
  selectSttModel,
  sttCatalog,
} from "./sttConfig.ts";

const MODEL_ID = "parakeet-tdt-600m-v2-int8";

let tmp: string;
const savedEnv = { ...process.env };

function settings(
  overrides: Partial<SpeechToTextSettings> = {},
): SpeechToTextSettings {
  return {
    enabled: true,
    modelId: "",
    numThreads: 8,
    idleShutdownSeconds: 600,
    maxUtteranceSeconds: 120,
    vocabulary: [],
    ...overrides,
  };
}

/** Create a directory holding every file the catalog entry promises. */
function writeModelDir(dir: string, { complete = true } = {}): string {
  mkdirSync(dir, { recursive: true });
  const entry = sttCatalog().find((model) => model.id === MODEL_ID)!;
  const files = complete
    ? [entry.encoder, entry.decoder, entry.joiner, entry.tokens]
    : [entry.encoder, entry.tokens];
  for (const file of files) writeFileSync(join(dir, file), "stub");
  return dir;
}

/** A fake recognizer executable discoverable through PATH. */
function writeBinaryOnPath(dir: string): void {
  mkdirSync(dir, { recursive: true });
  const bin = join(dir, "sherpa-onnx-offline-websocket-server");
  writeFileSync(bin, "#!/bin/sh\nexit 0\n");
  chmodSync(bin, 0o755);
  process.env.PATH = `${dir}:${process.env.PATH ?? ""}`;
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "assistant-stt-config-"));
  // A host that actually dictates exports ASSISTANT_STT_* overrides, and an
  // inherited one is just another candidate the resolver honours: drop them all
  // so a test states its own wiring instead of reading the machine's. The chain
  // also reads PATH, set per test where it matters, and the DATA_DIR fallback
  // slot, which `src/test/setup.ts` already points inside a temp dir.
  for (const key of Object.keys(process.env)) {
    if (key.startsWith("ASSISTANT_STT_")) delete process.env[key];
  }
  resetSttConfigCache();
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
  process.env = { ...savedEnv };
  resetSttConfigCache();
});

test("the committed catalog carries the shipped Parakeet model", () => {
  const entry = sttCatalog().find((model) => model.id === MODEL_ID);
  assert.ok(entry, "config/stt-models.json must catalog the shipped model");
  assert.equal(entry.language, "en");
  // The hash is what makes the Nix fetch reproducible; SRI form is required.
  assert.match(entry.sha256, /^sha256-/);
  assert.match(entry.url, /^https:\/\//);
});

test("a model is only available when every promised file is present", () => {
  process.env.ASSISTANT_STT_MODELS = JSON.stringify({
    [MODEL_ID]: writeModelDir(join(tmp, "partial"), { complete: false }),
  });
  assert.deepEqual(
    availableSttModels(),
    [],
    "a half-extracted directory must not count as installed",
  );

  process.env.ASSISTANT_STT_MODELS = JSON.stringify({
    [MODEL_ID]: writeModelDir(join(tmp, "full")),
  });
  assert.deepEqual(
    availableSttModels().map((model) => model.id),
    [MODEL_ID],
  );
});

test("the env map wins over the single-directory override", () => {
  const preferred = writeModelDir(join(tmp, "from-map"));
  process.env.ASSISTANT_STT_MODELS = JSON.stringify({ [MODEL_ID]: preferred });
  process.env.ASSISTANT_STT_MODEL_DIR = writeModelDir(join(tmp, "from-single"));
  assert.equal(selectSttModel(settings())?.dir, preferred);
});

test("the single-directory override is used when no env map is set", () => {
  const single = writeModelDir(join(tmp, "from-single"));
  process.env.ASSISTANT_STT_MODEL_DIR = single;
  assert.equal(selectSttModel(settings())?.dir, single);
});

test("an unknown configured model id is reported as unknown, not as missing files", () => {
  process.env.ASSISTANT_STT_MODELS = JSON.stringify({
    [MODEL_ID]: writeModelDir(join(tmp, "full")),
  });
  writeBinaryOnPath(join(tmp, "bin"));
  const runtime = resolveSttRuntime(settings({ modelId: "not-a-model" }));
  assert.equal(runtime.ok, false);
  assert.match(
    runtime.ok === false ? runtime.reason : "",
    /Unknown speech model id/,
  );
});

test("ASSISTANT_STT_DISABLED beats a fully working host setup", () => {
  // The recognizer is discovered by a PATH lookup, so a preview cannot rely on
  // the host simply not having it: the kill switch must win over discovery.
  process.env.ASSISTANT_STT_MODELS = JSON.stringify({
    [MODEL_ID]: writeModelDir(join(tmp, "full")),
  });
  writeBinaryOnPath(join(tmp, "bin"));
  process.env.ASSISTANT_STT_DISABLED = "1";
  const runtime = resolveSttRuntime(settings());
  assert.equal(runtime.ok, false);
  assert.match(
    runtime.ok === false ? runtime.reason : "",
    /ASSISTANT_STT_DISABLED/,
  );
  const status = describeSttAvailability(settings());
  assert.equal(status.configured, false);
  // No model ids either: they drive the Settings picker, and offering a choice
  // that cannot take effect is worse than an empty list beside the reason.
  assert.deepEqual(status.availableModelIds, []);
});

test("ASSISTANT_STT_DISABLED only disables for truthy values", () => {
  process.env.ASSISTANT_STT_MODELS = JSON.stringify({
    [MODEL_ID]: writeModelDir(join(tmp, "full")),
  });
  writeBinaryOnPath(join(tmp, "bin"));
  for (const value of ["0", "false", ""]) {
    process.env.ASSISTANT_STT_DISABLED = value;
    assert.equal(
      resolveSttRuntime(settings()).ok,
      true,
      `ASSISTANT_STT_DISABLED=${JSON.stringify(value)} must not disable dictation`,
    );
    assert.deepEqual(
      describeSttAvailability(settings()).availableModelIds,
      [MODEL_ID],
      `models must stay listed for ASSISTANT_STT_DISABLED=${JSON.stringify(value)}`,
    );
  }
});

test("a missing recognizer binary is named as the reason", () => {
  process.env.ASSISTANT_STT_MODELS = JSON.stringify({
    [MODEL_ID]: writeModelDir(join(tmp, "full")),
  });
  process.env.PATH = join(tmp, "empty-bin");
  const runtime = resolveSttRuntime(settings());
  assert.equal(runtime.ok, false);
  assert.match(
    runtime.ok === false ? runtime.reason : "",
    /Recognizer not found/,
  );
});

test("missing model files name the directories that were searched", () => {
  writeBinaryOnPath(join(tmp, "bin"));
  const runtime = resolveSttRuntime(settings());
  assert.equal(runtime.ok, false);
  const reason = runtime.ok === false ? runtime.reason : "";
  assert.match(reason, /Searched:/);
  assert.match(
    reason,
    /models[/\\]stt/,
    "the DATA_DIR fallback slot must be listed",
  );
  assert.match(
    reason,
    /stt:model/,
    "dev needs to be told the one command that fixes this",
  );
});

test("a malformed ASSISTANT_STT_MODELS is ignored rather than fatal", () => {
  process.env.ASSISTANT_STT_MODELS = "{not json";
  process.env.ASSISTANT_STT_MODEL_DIR = writeModelDir(join(tmp, "full"));
  assert.equal(selectSttModel(settings())?.id, MODEL_ID);
});

test("availability reports the resolved model and every installed id", () => {
  process.env.ASSISTANT_STT_MODELS = JSON.stringify({
    [MODEL_ID]: writeModelDir(join(tmp, "full")),
  });
  writeBinaryOnPath(join(tmp, "bin"));
  const status = describeSttAvailability(settings({ maxUtteranceSeconds: 90 }));
  assert.equal(status.configured, true);
  assert.equal(status.modelId, MODEL_ID);
  assert.deepEqual(status.availableModelIds, [MODEL_ID]);
  // The client enforces the same bound, so it has to travel with the status.
  assert.equal(status.maxUtteranceSeconds, 90);
  assert.equal(status.reason, undefined);
});

test("an unconfigured instance reports a reason instead of a dead button", () => {
  process.env.PATH = join(tmp, "empty-bin");
  const status = describeSttAvailability(settings());
  assert.equal(status.configured, false);
  assert.ok(status.reason && status.reason.length > 0);
});
