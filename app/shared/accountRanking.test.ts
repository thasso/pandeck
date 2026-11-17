import { describe, expect, it } from "vitest";
import {
  rankCandidates,
  type RankingCandidate,
  type RankingUsage,
} from "./accountRanking.ts";

const NOW = Date.parse("2026-11-17T12:00:00Z");
const DAY = 24 * 60 * 60_000;
const THRESHOLDS = { fiveHourUsedThreshold: 90, weeklyUsedThreshold: 95 };

function candidate(
  id: string,
  overrides: {
    enabled?: boolean;
    state?: string;
    priority?: number;
    offersModel?: boolean;
    limited?: unknown;
    usage?: RankingUsage | null;
  } = {},
): RankingCandidate {
  return {
    profile: {
      id,
      enabled: overrides.enabled ?? true,
      health: { state: overrides.state ?? "ok" },
      ...(overrides.priority !== undefined
        ? { priority: overrides.priority }
        : {}),
    },
    offersModel: overrides.offersModel ?? true,
    usage: overrides.usage ?? null,
    ...(overrides.limited !== undefined ? { limited: overrides.limited } : {}),
  };
}

function pick(candidates: RankingCandidate[]) {
  const ranked = rankCandidates(candidates, THRESHOLDS, NOW);
  return ranked && { id: ranked.pick.profile.id, eligible: ranked.eligible };
}

const usage = (
  shortPct: number | null,
  longPct: number | null,
  longResetsAt: number | null = null,
): RankingUsage => ({ shortPct, longPct, longResetsAt });

describe("rankCandidates", () => {
  it("breaks a tie by id, so the order is stable", () => {
    expect(pick([candidate("b"), candidate("a"), candidate("c")])).toEqual({
      id: "a",
      eligible: true,
    });
  });

  it("orders by priority within a usage tier", () => {
    expect(
      pick([candidate("a"), candidate("b", { priority: 2 }), candidate("c")]),
    ).toEqual({ id: "b", eligible: true });
  });

  it("puts known room ahead of unknown usage, and unknown ahead of exhausted, before priority", () => {
    const room = candidate("z-room", { usage: usage(10, 10) });
    const unknown = candidate("a-unknown", { priority: 5 });
    const exhausted = candidate("b-spent", {
      priority: 9,
      usage: usage(95, 10),
    });
    expect(pick([exhausted, unknown, room])?.id).toBe("z-room");
    expect(pick([exhausted, unknown])?.id).toBe("a-unknown");
    expect(
      pick([exhausted, candidate("c-weekly", { usage: usage(10, 99) })])?.id,
    ).toBe("b-spent");
  });

  it("within a tier, prefers the earlier weekly reset, then the less-used 5-hour window", () => {
    const later = candidate("a", { usage: usage(10, 10, NOW + 3 * DAY) });
    const sooner = candidate("b", { usage: usage(50, 10, NOW + DAY) });
    expect(pick([later, sooner])?.id).toBe("b");
    const lessUsed = candidate("d", { usage: usage(5, 10, NOW + DAY) });
    expect(pick([sooner, lessUsed])?.id).toBe("d");
    // A past reset counts as none.
    const past = candidate("c", { usage: usage(10, 10, NOW - DAY) });
    expect(pick([past, sooner])?.id).toBe("b");
  });

  it("picks only eligible accounts while one exists", () => {
    expect(
      pick([
        candidate("a", { limited: true }),
        candidate("b", { state: "needs-login" }),
        candidate("c", { offersModel: false }),
        candidate("d", { enabled: false }),
        candidate("e"),
      ]),
    ).toEqual({ id: "e", eligible: true });
  });

  it("falls back to the enabled accounts as a degraded pick, needs-login last", () => {
    expect(
      pick([
        candidate("a", { state: "needs-login" }),
        candidate("b", { limited: true }),
        candidate("c", { enabled: false }),
      ]),
    ).toEqual({ id: "b", eligible: false });
    expect(
      pick([
        candidate("a", { state: "needs-login" }),
        candidate("b", { offersModel: false }),
      ]),
    ).toEqual({ id: "b", eligible: false });
    expect(
      pick([
        candidate("a", { limited: true, offersModel: false }),
        candidate("b", { limited: true }),
      ]),
    ).toEqual({ id: "b", eligible: false });
  });

  it("answers nothing without an enabled candidate", () => {
    expect(pick([candidate("a", { enabled: false })])).toBeUndefined();
    expect(pick([])).toBeUndefined();
  });

  it("returns the caller's own candidate object", () => {
    const own = { ...candidate("a"), source: "mine" };
    expect(rankCandidates([own], THRESHOLDS, NOW)?.pick).toBe(own);
  });
});
