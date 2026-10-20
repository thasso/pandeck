/** Compaction-window ranges, clamping and the user's refusal wording. */
import { expect, test } from "vitest";
import {
  COMPACTION_WINDOW_AGENT_FLOOR,
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
  expect(pi).toEqual({ mapping: "reserve", summaryCostNote: true });
  expect(COMPACTION_WINDOW_AGENT_FLOOR).toBe(100_000);
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
