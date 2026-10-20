/** Compaction-window ranges, clamping and the user's refusal wording. */
import { expect, test } from "vitest";
import {
  COMPACTION_WINDOW_AGENT_FLOOR,
  spawnCompactionWindow,
  compactionWindowEstimateNote,
  compactionWindowRange,
  compactionWindowUserRefusal,
  effectiveCompactionWindow,
  sessionCompactionWindowState,
  type CompactionWindowCapability,
} from "./compactionWindow.ts";
import { HARNESSES } from "./harnesses.ts";
import { CLAUDE_SDK_MODELS } from "./protocol.ts";

const claude = HARNESSES["claude-sdk"]
  .compactionWindow as CompactionWindowCapability;
const pi = HARNESSES.pi.compactionWindow as CompactionWindowCapability;

test("both harnesses declare the capability; the agent floor is 100k", () => {
  expect(claude).toEqual({ mapping: "window", min: 100_000, max: 1_000_000 });
  expect(pi).toEqual({
    mapping: "reserve",
    summaryCostNote: true,
    defaultReserve: 16_384,
  });
  expect(COMPACTION_WINDOW_AGENT_FLOOR).toBe(100_000);
});

test("spawn rows refuse outside the agent range, re-picks clamp and definitions use the user range", () => {
  const available = { range: { min: 1, max: 200_000 } };
  for (const tokens of [99_999, 1.5, 220_000])
    expect(
      spawnCompactionWindow(available, {
        tokens,
        source: "row",
        rowAbove: "refuse",
      }),
    ).toHaveProperty("refused");
  expect(
    spawnCompactionWindow(available, {
      tokens: 220_000,
      source: "row",
      rowAbove: "clamp",
    }),
  ).toMatchObject({ tokens: 200_000 });
  expect(
    spawnCompactionWindow(
      { range: { min: 1, max: 82_000 } },
      { tokens: 150_000, source: "row", rowAbove: "clamp" },
    ),
  ).toHaveProperty("refused");
  expect(
    spawnCompactionWindow(available, {
      tokens: 12_000,
      source: "definition",
      rowAbove: "refuse",
    }),
  ).toEqual({ tokens: 12_000 });
  expect(
    spawnCompactionWindow(available, {
      tokens: 260_000,
      source: "definition",
      rowAbove: "clamp",
      ceiling: 150_000,
    }),
  ).toMatchObject({ tokens: 150_000 });
  expect(
    spawnCompactionWindow(
      { unavailable: "empty" },
      { tokens: 12_000, source: "definition", rowAbove: "refuse" },
    ),
  ).toMatchObject({ tokens: null });
});

test("estimate notes explain actual differences and discard stale empty-range explanations", () => {
  const note = compactionWindowEstimateNote(
    { tokens: null, note: "No compaction window was set: no range" },
    12_000,
  );
  expect(note).toContain("12,000");
  expect(note).toContain("estimate");
  expect(note).not.toContain("No compaction window was set");
  expect(compactionWindowEstimateNote({ tokens: 250_000 }, 200_000)).toMatch(
    /250,000.*200,000/,
  );
  expect(compactionWindowEstimateNote({ tokens: 150_000 }, null)).toContain(
    "Not set",
  );
  expect(
    compactionWindowEstimateNote({ tokens: 150_000 }, 150_000),
  ).toBeUndefined();
  expect(
    compactionWindowEstimateNote(
      { tokens: 200_000, note: "On approval: clamped" },
      200_000,
    ),
  ).toBe("On approval: clamped");
  expect(
    compactionWindowEstimateNote(
      { tokens: null, note: "old" },
      null,
      "actual empty range",
    ),
  ).toBe("actual empty range");
  expect(compactionWindowEstimateNote(undefined, 100_000, "clamped")).toBe(
    "clamped",
  );
});

test("Claude: 100k up to the model window, never above 1M", () => {
  expect(compactionWindowRange(claude, { contextWindow: 1_000_000 })).toEqual({
    range: { min: 100_000, max: 1_000_000 },
  });
  expect(compactionWindowRange(claude, { contextWindow: 200_000 })).toEqual({
    range: { min: 100_000, max: 200_000 },
  });
  expect(compactionWindowRange(claude, { contextWindow: 2_000_000 })).toEqual({
    range: { min: 100_000, max: 1_000_000 },
  });
  expect(compactionWindowRange(claude, { contextWindow: 80_000 })).toEqual({
    unavailable: expect.stringContaining("below the 100,000-token minimum"),
  });
});

test("pi: 1 up to the native trigger, the window minus the underlying reserve", () => {
  expect(
    compactionWindowRange(pi, {
      contextWindow: 32_768,
      underlyingReserve: 16_384,
    }),
  ).toEqual({ range: { min: 1, max: 16_384 } });
  expect(
    compactionWindowRange(pi, {
      contextWindow: 272_000,
      underlyingReserve: 16_384,
    }),
  ).toEqual({ range: { min: 1, max: 255_616 } });
  expect(
    compactionWindowRange(pi, {
      contextWindow: 16_384,
      underlyingReserve: 16_384,
    }),
  ).toHaveProperty("unavailable");
  expect(compactionWindowRange(pi, {})).toHaveProperty("unavailable");
});

test("a stored value outside a later model's range is clamped, not dropped", () => {
  const range = { min: 100_000, max: 200_000 };
  expect(effectiveCompactionWindow(range, 500_000)).toBe(200_000);
  expect(effectiveCompactionWindow(range, 150_000)).toBe(150_000);
  expect(effectiveCompactionWindow(range, 50_000)).toBe(100_000);
});

test("the user's refusal: structure, range, unavailable; clear always allowed", () => {
  const available = compactionWindowRange(claude, { contextWindow: 200_000 });
  expect(compactionWindowUserRefusal(available, null)).toBeUndefined();
  expect(compactionWindowUserRefusal(available, 150_000)).toBeUndefined();
  expect(compactionWindowUserRefusal(available, 90_000)).toBe(
    "The compaction window must be between 100,000 and 200,000 tokens.",
  );
  expect(compactionWindowUserRefusal(available, 1.5)).toMatch(/whole number/);
  expect(compactionWindowUserRefusal(available, 0)).toMatch(/whole number/);
  expect(
    compactionWindowUserRefusal({ unavailable: "No window." }, 150_000),
  ).toBe("The compaction window cannot be set: No window.");
});

test("the Opus alias carries its 1M window", () => {
  expect(CLAUDE_SDK_MODELS.find((m) => m.id === "opus")?.contextWindow).toBe(
    1_000_000,
  );
});

test("the session projection: no capability, stored-only and live", () => {
  expect(
    sessionCompactionWindowState(undefined, { stored: 150_000 }),
  ).toBeUndefined();
  expect(
    sessionCompactionWindowState(claude, {
      stored: 500_000,
      contextWindow: 200_000,
    }),
  ).toEqual({
    applied: "pending",
    pendingReason: "next-turn",
    tokens: 500_000,
    range: { min: 100_000, max: 200_000 },
    effectiveTokens: 200_000,
  });
  expect(
    sessionCompactionWindowState(pi, {
      stored: undefined,
      contextWindow: 272_000,
      underlyingReserve: 16_384,
      live: { applied: "confirmed", appliedTokens: null, providerTrigger: 1 },
    }),
  ).toEqual({
    applied: "confirmed",
    appliedTokens: null,
    providerTrigger: 1,
    range: { min: 1, max: 255_616 },
  });
});
