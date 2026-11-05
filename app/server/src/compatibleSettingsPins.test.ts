/**
 * Rule P over the persisted settings (`docs/account-routing.md`): a pinned
 * compatible model names its own account, at every boot and every write; an
 * Automatic entry stays Automatic, and every other pin is untouched.
 */
import assert from "node:assert/strict";
import { readFileSync, rmSync, statSync } from "node:fs";
import { afterEach, test } from "vitest";
import {
  APP_SETTINGS_PATH,
  readStoredAppSettings,
  writeStoredAppSettings,
} from "./appSettingsFile.ts";
import {
  applyAccountPinRuleDeep,
  normalizeCompatibleSettingsPins,
} from "./compatibleSettingsPins.ts";

const COMPATIBLE = "openai-compatible-0123456789ab";

afterEach(() => {
  rmSync(APP_SETTINGS_PATH, { force: true });
});

test("a compatible model's pin becomes its account wherever it sits", () => {
  const settings = {
    naming: {
      provider: "openai-compatible",
      modelId: "qwen3",
      credentialProfileId: "default",
    },
    peerSpawnRuntimes: [
      {
        id: "r1",
        provider: COMPATIBLE,
        modelId: "m",
        credentialProfileId: "cp_0123456789abcdef",
      },
      { id: "r2", provider: COMPATIBLE, modelId: "m" },
      { id: "r3", provider: COMPATIBLE, modelId: "m", credentialProfileId: "" },
      {
        id: "r4",
        provider: "openai-codex",
        modelId: "gpt",
        credentialProfileId: "cp_0123456789abcdef",
      },
    ],
  };
  assert.deepEqual(applyAccountPinRuleDeep(settings), {
    naming: {
      provider: "openai-compatible",
      modelId: "qwen3",
      credentialProfileId: "openai-compatible",
    },
    peerSpawnRuntimes: [
      {
        id: "r1",
        provider: COMPATIBLE,
        modelId: "m",
        credentialProfileId: COMPATIBLE,
      },
      // Automatic stays Automatic.
      { id: "r2", provider: COMPATIBLE, modelId: "m" },
      { id: "r3", provider: COMPATIBLE, modelId: "m", credentialProfileId: "" },
      // Any other kind's exact pin is never rewritten.
      {
        id: "r4",
        provider: "openai-codex",
        modelId: "gpt",
        credentialProfileId: "cp_0123456789abcdef",
      },
    ],
  });
});

test("the boot pass rewrites the stored settings only when a pin changes", () => {
  normalizeCompatibleSettingsPins();
  assert.throws(() => statSync(APP_SETTINGS_PATH), { code: "ENOENT" });

  writeStoredAppSettings({
    naming: { provider: "openai-codex", modelId: "gpt" },
  });
  const untouched = readFileSync(APP_SETTINGS_PATH, "utf8");
  const before = statSync(APP_SETTINGS_PATH).mtimeMs;
  normalizeCompatibleSettingsPins();
  assert.equal(readFileSync(APP_SETTINGS_PATH, "utf8"), untouched);
  assert.equal(statSync(APP_SETTINGS_PATH).mtimeMs, before);

  writeStoredAppSettings({
    naming: {
      provider: COMPATIBLE,
      modelId: "m",
      credentialProfileId: "default",
    },
  });
  normalizeCompatibleSettingsPins();
  assert.deepEqual(readStoredAppSettings(), {
    naming: {
      provider: COMPATIBLE,
      modelId: "m",
      credentialProfileId: COMPATIBLE,
    },
  });
  // Idempotent.
  const once = readFileSync(APP_SETTINGS_PATH, "utf8");
  normalizeCompatibleSettingsPins();
  assert.equal(readFileSync(APP_SETTINGS_PATH, "utf8"), once);
});
