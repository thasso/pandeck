import assert from "node:assert/strict";
import { test } from "vitest";
import { getSettings, updateSettings } from "./settings.ts";
import { appSettingsPatchError } from "./validateClientMessage.ts";

test("the handoff cap defaults to 16,000 tokens and clamps to 1,000–64,000", () => {
  const original = getSettings().sessionSwitching;
  assert.deepEqual(original, { handoffTokenCap: 16_000 });
  try {
    assert.equal(
      appSettingsPatchError({ sessionSwitching: { handoffTokenCap: 8_000 } }),
      null,
    );
    assert.deepEqual(
      updateSettings({ sessionSwitching: { handoffTokenCap: 8_000 } })
        .sessionSwitching,
      { handoffTokenCap: 8_000 },
    );
    assert.deepEqual(getSettings().sessionSwitching, {
      handoffTokenCap: 8_000,
    });
    assert.equal(
      updateSettings({ sessionSwitching: { handoffTokenCap: 10 } })
        .sessionSwitching.handoffTokenCap,
      1_000,
    );
    assert.equal(
      updateSettings({ sessionSwitching: { handoffTokenCap: 1e9 } })
        .sessionSwitching.handoffTokenCap,
      64_000,
    );
    assert.equal(
      updateSettings({ sessionSwitching: { handoffTokenCap: 2_500.6 } })
        .sessionSwitching.handoffTokenCap,
      2_501,
    );
    assert.equal(
      updateSettings({ sessionSwitching: { handoffTokenCap: NaN } })
        .sessionSwitching.handoffTokenCap,
      16_000,
    );
  } finally {
    updateSettings({ sessionSwitching: original });
  }
});

test("an untrusted handoff cap patch must be a finite number", () => {
  for (const handoffTokenCap of ["16000", NaN, Infinity])
    assert.ok(
      appSettingsPatchError({
        sessionSwitching: { handoffTokenCap },
      } as never),
    );
});
