import assert from "node:assert/strict";
import { test } from "vitest";
import {
  DEFAULT_SESSION_PEER_PROMPT_MAX_HOPS,
  MAX_SESSION_PEER_PROMPT_MAX_HOPS,
  MIN_SESSION_PEER_PROMPT_MAX_HOPS,
} from "@assistant/shared";
import { getSettings, updateSettings } from "./settings.ts";
import { validateClientMessage } from "./validateClientMessage.ts";

test("appearance settings default to separators + stats on, per-request off", () => {
  const { appearance } = getSettings();
  assert.deepEqual(appearance, {
    separatorBeforeFinalResponse: true,
    separatorAtTurnEnd: true,
    turnStatsRow: true,
    turnStatsPerRequest: false,
  });
});

test("peer-prompt hop limit defaults high and persists a bounded runtime setting", () => {
  const original = getSettings().sessionPeerPromptMaxHops;
  assert.equal(original, DEFAULT_SESSION_PEER_PROMPT_MAX_HOPS);
  try {
    assert.equal(
      updateSettings({ sessionPeerPromptMaxHops: 0 }).sessionPeerPromptMaxHops,
      MIN_SESSION_PEER_PROMPT_MAX_HOPS,
    );
    assert.equal(
      updateSettings({ sessionPeerPromptMaxHops: 12.6 })
        .sessionPeerPromptMaxHops,
      13,
    );
    assert.equal(
      updateSettings({ sessionPeerPromptMaxHops: 10_000 })
        .sessionPeerPromptMaxHops,
      MAX_SESSION_PEER_PROMPT_MAX_HOPS,
    );
    assert.equal(
      getSettings().sessionPeerPromptMaxHops,
      MAX_SESSION_PEER_PROMPT_MAX_HOPS,
    );
    assert.equal(
      validateClientMessage({
        type: "updateSettings",
        patch: { sessionPeerPromptMaxHops: "50" },
      }).ok,
      false,
    );
  } finally {
    updateSettings({ sessionPeerPromptMaxHops: original });
  }
});

test("updateSettings persists and normalizes the appearance patch", () => {
  const updated = updateSettings({
    appearance: {
      separatorBeforeFinalResponse: false,
      separatorAtTurnEnd: true,
      turnStatsRow: true,
      turnStatsPerRequest: true,
      knowledgePanelEnabled: false,
      worktreePanelEnabled: false,
    },
  });
  assert.equal(updated.appearance.separatorBeforeFinalResponse, false);
  assert.equal(updated.appearance.turnStatsPerRequest, true);
  // Round-trips through storage.
  assert.deepEqual(getSettings().appearance, updated.appearance);
});

test("worktree fetch cadence defaults, rejects malformed values, and caps at one day", () => {
  const original = getSettings().worktrees;
  try {
    for (const [value, expected] of [
      [0, 0],
      [12, 12],
      [-1, 10],
      [1.5, 10],
      [Number.NaN, 10],
      [10_000, 24 * 60],
    ] as const) {
      const updated = updateSettings({
        worktrees: { ...original, remoteFetchMinutes: value },
      });
      assert.equal(updated.worktrees.remoteFetchMinutes, expected);
    }
  } finally {
    updateSettings({ worktrees: original });
  }
});

test("normalizeAppearanceSettings coerces non-boolean and fills missing fields with defaults", () => {
  const appearanceValue = {
    turnStatsRow: false,
    // Non-boolean values fall back to their default.
    separatorAtTurnEnd: "yes" as unknown as boolean,
  } as Parameters<typeof updateSettings>[0]["appearance"];
  const updated = updateSettings({
    // A partial/dirty patch (e.g. from an older client) must not corrupt the shape.
    ...(appearanceValue !== undefined ? { appearance: appearanceValue } : {}),
  });
  assert.equal(updated.appearance.turnStatsRow, false);
  assert.equal(
    updated.appearance.separatorAtTurnEnd,
    true,
    "non-boolean coerced to default",
  );
  assert.equal(
    updated.appearance.separatorBeforeFinalResponse,
    true,
    "missing field filled with default",
  );
  assert.equal(
    updated.appearance.turnStatsPerRequest,
    false,
    "missing field filled with default",
  );
});
