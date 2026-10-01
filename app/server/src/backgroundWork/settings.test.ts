import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import {
  BACKGROUND_WORK_SETTINGS_RANGES,
  DEFAULT_BACKGROUND_WORK_SETTINGS,
  normalizeBackgroundWorkSettings,
} from "@assistant/shared";

const dataDir = mkdtempSync(join(tmpdir(), "background-work-settings-test-"));
process.env.DATA_DIR = dataDir;
process.env.ASSISTANT_CWD = dataDir;

const { getSettings, updateSettings } = await import("../settings.ts");
const {
  BACKGROUND_WORK_SETTINGS_GENERATION_COUNT,
  backgroundWorkSettingsGeneration,
  resolveBackgroundWorkSettings,
} = await import("./settings.ts");

const RANGES = BACKGROUND_WORK_SETTINGS_RANGES;

test("an unconfigured install gets the shipped defaults", () => {
  assert.deepEqual(normalizeBackgroundWorkSettings(undefined), {
    enabled: true,
    ownerSessionCap: 7,
    taskLifetimeMinutes: 60,
    claudeEmptyHostGraceSeconds: 30,
  });
  assert.deepEqual(
    getSettings().backgroundWork,
    DEFAULT_BACKGROUND_WORK_SETTINGS,
  );
});

test("each numeric range accepts its bounds and clamps past them", () => {
  for (const [field, range] of Object.entries(RANGES) as Array<
    [keyof typeof RANGES, { min: number; max: number }]
  >) {
    for (const accepted of [range.min, range.max])
      assert.equal(
        normalizeBackgroundWorkSettings({ [field]: accepted })[field],
        accepted,
        `${field} must accept ${accepted}`,
      );
    assert.equal(
      normalizeBackgroundWorkSettings({ [field]: range.min - 1 })[field],
      range.min,
      `${field} below its range clamps up`,
    );
    assert.equal(
      normalizeBackgroundWorkSettings({ [field]: range.max + 1 })[field],
      range.max,
      `${field} above its range clamps down`,
    );
    // Anything that is not a number at all falls back rather than clamping to
    // a bound, so a corrupted file reads as "unconfigured", not as "minimum".
    assert.equal(
      normalizeBackgroundWorkSettings({
        [field]: "12" as unknown as number,
      })[field],
      DEFAULT_BACKGROUND_WORK_SETTINGS[field],
      `${field} rejects a non-numeric value`,
    );
    assert.equal(
      normalizeBackgroundWorkSettings({ [field]: Number.NaN })[field],
      DEFAULT_BACKGROUND_WORK_SETTINGS[field],
      `${field} rejects NaN`,
    );
  }
  assert.equal(
    normalizeBackgroundWorkSettings({ enabled: "yes" as unknown as boolean })
      .enabled,
    true,
  );
  assert.equal(
    normalizeBackgroundWorkSettings({ enabled: false }).enabled,
    false,
  );
});

test("a persisted patch is normalized on the way in and back out", () => {
  const saved = updateSettings({
    backgroundWork: {
      enabled: true,
      ownerSessionCap: 999,
      taskLifetimeMinutes: 1,
      claudeEmptyHostGraceSeconds: 45,
    },
  });
  assert.deepEqual(saved.backgroundWork, {
    enabled: true,
    ownerSessionCap: RANGES.ownerSessionCap.max,
    taskLifetimeMinutes: RANGES.taskLifetimeMinutes.min,
    claudeEmptyHostGraceSeconds: 45,
  });
  assert.deepEqual(getSettings().backgroundWork, saved.backgroundWork);
});

test("the snapshot converts to the store's units and identifies its values", () => {
  updateSettings({
    backgroundWork: {
      enabled: true,
      ownerSessionCap: 3,
      taskLifetimeMinutes: 15,
      claudeEmptyHostGraceSeconds: 5,
    },
  });
  const snapshot = resolveBackgroundWorkSettings();
  assert.deepEqual(snapshot, {
    enabled: true,
    ownerSessionCap: 3,
    taskLifetimeMs: 15 * 60_000,
    claudeEmptyHostGraceMs: 5_000,
    generation: backgroundWorkSettingsGeneration({
      enabled: true,
      ownerSessionCap: 3,
      taskLifetimeMinutes: 15,
      claudeEmptyHostGraceSeconds: 5,
    }),
  });
  assert.ok(Number.isSafeInteger(snapshot.generation));
  assert.ok(snapshot.generation >= 0);

  // Equal values, equal generation — the property a restart depends on.
  assert.equal(resolveBackgroundWorkSettings().generation, snapshot.generation);
  updateSettings({
    backgroundWork: {
      enabled: true,
      ownerSessionCap: 4,
      taskLifetimeMinutes: 15,
      claudeEmptyHostGraceSeconds: 5,
    },
  });
  assert.notEqual(
    resolveBackgroundWorkSettings().generation,
    snapshot.generation,
  );
});

test("the generation is injective over the whole normalized domain", () => {
  // Exhaustive, because "no two cards collide" is the only useful statement: a
  // sampled check is exactly what let an earlier hash through.
  // 17.3M cards, so the loop body stays free of assertions: a per-card
  // `assert` call costs far more than the packing it checks. Failures are
  // collected and reported after it.
  const seen = new Uint8Array(BACKGROUND_WORK_SETTINGS_GENERATION_COUNT);
  const failures: string[] = [];
  let counted = 0;
  let max = -1;
  for (const enabled of [false, true])
    for (
      let ownerSessionCap = RANGES.ownerSessionCap.min;
      ownerSessionCap <= RANGES.ownerSessionCap.max;
      ownerSessionCap += 1
    )
      for (
        let taskLifetimeMinutes = RANGES.taskLifetimeMinutes.min;
        taskLifetimeMinutes <= RANGES.taskLifetimeMinutes.max;
        taskLifetimeMinutes += 1
      )
        for (
          let claudeEmptyHostGraceSeconds =
            RANGES.claudeEmptyHostGraceSeconds.min;
          claudeEmptyHostGraceSeconds <= RANGES.claudeEmptyHostGraceSeconds.max;
          claudeEmptyHostGraceSeconds += 1
        ) {
          const generation = backgroundWorkSettingsGeneration({
            enabled,
            ownerSessionCap,
            taskLifetimeMinutes,
            claudeEmptyHostGraceSeconds,
          });
          const where = `cap ${ownerSessionCap}, lifetime ${taskLifetimeMinutes}, grace ${claudeEmptyHostGraceSeconds}, enabled ${enabled}`;
          if (
            generation < 0 ||
            generation >= BACKGROUND_WORK_SETTINGS_GENERATION_COUNT
          )
            failures.push(`${generation} is outside the domain (${where})`);
          else if (seen[generation] === 1)
            failures.push(`${generation} collides (${where})`);
          seen[generation] = 1;
          counted += 1;
          if (generation > max) max = generation;
        }
  assert.deepEqual(failures.slice(0, 5), []);
  assert.equal(counted, BACKGROUND_WORK_SETTINGS_GENERATION_COUNT);
  // Onto as well as one-to-one: the packing wastes no index, so it stays well
  // inside the store's safe-integer column.
  assert.equal(max, BACKGROUND_WORK_SETTINGS_GENERATION_COUNT - 1);
  assert.ok(max < 2 ** 31);
});

test("the two cards an FNV-1a hash aliased get distinct generations", () => {
  // The exact pair a reviewer found colliding under the previous encoding.
  const first = backgroundWorkSettingsGeneration({
    enabled: true,
    ownerSessionCap: 1,
    taskLifetimeMinutes: 307,
    claudeEmptyHostGraceSeconds: 96,
  });
  const second = backgroundWorkSettingsGeneration({
    enabled: true,
    ownerSessionCap: 1,
    taskLifetimeMinutes: 539,
    claudeEmptyHostGraceSeconds: 214,
  });
  assert.notEqual(first, second);
});

test("an out-of-range card packs as the card it normalizes to", () => {
  // The function is total: a caller that skipped normalization cannot land on
  // another card's index.
  assert.equal(
    backgroundWorkSettingsGeneration({
      enabled: true,
      ownerSessionCap: 999,
      taskLifetimeMinutes: 0,
      claudeEmptyHostGraceSeconds: -5,
    }),
    backgroundWorkSettingsGeneration({
      enabled: true,
      ownerSessionCap: RANGES.ownerSessionCap.max,
      taskLifetimeMinutes: RANGES.taskLifetimeMinutes.min,
      claudeEmptyHostGraceSeconds: RANGES.claudeEmptyHostGraceSeconds.min,
    }),
  );
});
