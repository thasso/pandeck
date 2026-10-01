/**
 * Task 93: Memory settings defaults, validation/clamping, and merge semantics.
 * Isolated temp data dir.
 *   pnpm --filter @assistant/server test src/memory/memorySettings.test.ts
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import { DEFAULT_HELPER_MODEL } from "@assistant/shared";

const tmp = mkdtempSync(join(tmpdir(), "memory-settings-test-"));
process.env.ASSISTANT_CWD = tmp;

const { getSettings, updateSettings } = await import("../settings.ts");

test("memory settings: safe defaults", () => {
  const m = getSettings().memory;
  assert.equal(m.loadingEnabled, true);
  assert.equal(m.learningMode, "adaptive");
  assert.equal(m.maintenanceEnabled, true);
  assert.equal(m.maxCards, 8);
  assert.equal(m.maxRenderedChars, 1_200);
  assert.equal(m.maxCallsPerHour, 12);
  assert.equal(m.maxCostPerDayUsd, 1);
  assert.equal(m.processor.provider, DEFAULT_HELPER_MODEL.provider);
  assert.equal(m.processor.modelId, DEFAULT_HELPER_MODEL.modelId);
});

test("memory settings: validate/clamp and preserve merge semantics", () => {
  // Invalid learning mode and out-of-range limits fall back / clamp.
  const patched = updateSettings({
    memory: {
      ...getSettings().memory,
      learningMode: "bogus" as never,
      maxCards: 9_999,
      maxRenderedChars: 1,
      maxCallsPerHour: -5,
      maxCostPerDayUsd: 999,
    },
  }).memory;
  assert.equal(
    patched.learningMode,
    "adaptive",
    "invalid learning mode falls back to default",
  );
  assert.equal(patched.maxCards, 32, "maxCards clamped to max");
  assert.equal(
    patched.maxRenderedChars,
    200,
    "maxRenderedChars clamped to min",
  );
  assert.equal(
    patched.maxCallsPerHour,
    0,
    "calls/hour clamped to min (a ceiling can be 0 but not negative)",
  );
  assert.equal(patched.maxCostPerDayUsd, 50, "cost/day clamped to max");

  // Processor thinking level is enum-validated; an invalid value falls back.
  const badThinking = updateSettings({
    memory: {
      ...getSettings().memory,
      processor: {
        ...DEFAULT_HELPER_MODEL,
        thinkingLevel: "bogus" as never,
      },
    },
  }).memory;
  assert.equal(
    badThinking.processor.thinkingLevel,
    "off",
    "invalid thinking level falls back to default",
  );
  const emptyModel = updateSettings({
    memory: {
      ...getSettings().memory,
      processor: { provider: "", modelId: "", thinkingLevel: "low" },
    },
  }).memory;
  assert.equal(
    emptyModel.processor.provider,
    DEFAULT_HELPER_MODEL.provider,
    "empty provider falls back",
  );
  assert.equal(
    emptyModel.processor.modelId,
    DEFAULT_HELPER_MODEL.modelId,
    "empty model falls back",
  );
  assert.equal(
    emptyModel.processor.thinkingLevel,
    "low",
    "valid thinking level preserved",
  );

  // Merge: updating an unrelated section preserves memory settings.
  updateSettings({
    memory: {
      ...getSettings().memory,
      learningMode: "every-turn",
    },
  });
  updateSettings({ projectsRoot: "~/elsewhere" });
  const after = getSettings().memory;
  assert.equal(
    after.learningMode,
    "every-turn",
    "memory preserved across an unrelated settings update",
  );

  rmSync(tmp, { recursive: true, force: true });
});
