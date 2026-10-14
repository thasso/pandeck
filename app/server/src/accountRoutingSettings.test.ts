import assert from "node:assert/strict";
import { test } from "vitest";
import { getSettings, updateSettings } from "./settings.ts";
import { appSettingsPatchError } from "./validateClientMessage.ts";

test("account routing thresholds default to 90/95 and round-trip through storage", () => {
  const original = getSettings().accountRouting;
  assert.deepEqual(original, {
    fiveHourUsedThreshold: 90,
    weeklyUsedThreshold: 95,
  });
  try {
    const value = { fiveHourUsedThreshold: 75.5, weeklyUsedThreshold: 85 };
    assert.equal(appSettingsPatchError({ accountRouting: value }), null);
    assert.deepEqual(
      updateSettings({ accountRouting: value }).accountRouting,
      value,
    );
    assert.deepEqual(getSettings().accountRouting, value);
    assert.deepEqual(
      updateSettings({
        accountRouting: {
          fiveHourUsedThreshold: -10,
          weeklyUsedThreshold: 105,
        },
      }).accountRouting,
      { fiveHourUsedThreshold: 0, weeklyUsedThreshold: 100 },
    );
    assert.deepEqual(
      updateSettings({
        accountRouting: {
          fiveHourUsedThreshold: NaN,
          weeklyUsedThreshold: Infinity,
        },
      }).accountRouting,
      original,
    );
  } finally {
    updateSettings({ accountRouting: original });
  }
});

test("untrusted threshold patches reject strings and non-finite values", () => {
  for (const accountRouting of [
    { fiveHourUsedThreshold: "90", weeklyUsedThreshold: 95 },
    { fiveHourUsedThreshold: NaN, weeklyUsedThreshold: 95 },
    { fiveHourUsedThreshold: 90, weeklyUsedThreshold: Infinity },
  ])
    assert.ok(appSettingsPatchError({ accountRouting }));
});
