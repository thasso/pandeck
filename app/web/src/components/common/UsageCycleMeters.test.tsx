import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  USAGE_HARD_INVALID_MS,
  USAGE_STALE_MS,
  type UsageIndicator,
} from "@assistant/shared/usage";
import { UsageCycleMeters } from "./UsageCycleMeters.tsx";

const NOW = Date.parse("2026-08-06T12:00:00Z");

function indicator(overrides: Partial<UsageIndicator> = {}): UsageIndicator {
  return {
    profileId: "claude-default",
    provider: "claude",
    refreshing: false,
    fetchedAt: NOW - 60_000,
    limitsAvailable: true,
    short: { usedPct: 62, resetsAt: "2026-08-06T14:00:00Z" },
    long: { usedPct: 41, resetsAt: "2026-08-10T00:00:00Z" },
    ...overrides,
  };
}

const render = (value: UsageIndicator | undefined) =>
  renderToStaticMarkup(<UsageCycleMeters indicator={value} now={NOW} />);

describe("UsageCycleMeters", () => {
  it("prints the number next to the meter, and colours by the shared thresholds", () => {
    const html = render(indicator());
    expect(html).toContain("62%");
    expect(html).toContain("41%");
    expect(html).toContain("width:62%");
    // 62 and 41 are both below the amber threshold.
    expect(html).not.toContain("bg-warning");
    expect(
      render(indicator({ short: { usedPct: 75, resetsAt: null } })),
    ).toContain("bg-warning");
    expect(
      render(indicator({ short: { usedPct: 95, resetsAt: null } })),
    ).toContain("bg-danger");
  });

  it("shows a placeholder, never a number, before the first snapshot arrives", () => {
    for (const html of [
      render(undefined),
      // The shape the server sends for an account it has never fetched: an
      // absent window here means "not fetched yet", not "no such limit".
      render(
        indicator({
          fetchedAt: null,
          short: null,
          long: null,
          refreshing: true,
        }),
      ),
    ]) {
      expect(html).toContain("—");
      // The shimmer is the shared `Skeleton`, holding the track's geometry.
      expect(html).toContain("motion-safe:animate-pulse");
      expect(html).not.toContain("%");
      expect(html).not.toContain("no 5h limit");
      expect(html).not.toContain("no weekly limit");
    }
  });

  it("shimmers only while something is actually being fetched", () => {
    // Nothing known and nothing running (an account in failure backoff) must
    // not animate as though a fetch were on its way.
    const idle = indicator({
      fetchedAt: null,
      short: null,
      long: null,
      refreshing: false,
    });
    expect(render(idle)).toContain("—");
    expect(render(idle)).not.toContain("animate-pulse");
    expect(render({ ...idle, refreshing: true })).toContain(
      "motion-safe:animate-pulse",
    );
  });

  it("dims a stale reading and marks it, but keeps showing it", () => {
    const html = render(
      indicator({ fetchedAt: NOW - USAGE_STALE_MS.claude - 1000 }),
    );
    expect(html).toContain("62%");
    expect(html).toContain("opacity-50");
    expect(html).toContain("⟳");
  });

  it("drops the number once the cache is too old to trust", () => {
    const html = render(
      indicator({ fetchedAt: NOW - USAGE_HARD_INVALID_MS.claude - 1000 }),
    );
    expect(html).not.toContain("62%");
    expect(html).toContain("—");
  });

  it("drops the number once the window it described has rolled over", () => {
    // The percent is not merely old here, it is known-wrong: the 5-hour cycle
    // reset at 11:00 and started again from zero.
    const html = render(
      indicator({ short: { usedPct: 62, resetsAt: "2026-08-06T11:00:00Z" } }),
    );
    expect(html).not.toContain("62%");
    expect(html).toContain("41%");
  });

  it("states why there is no meter rather than showing an empty one", () => {
    expect(render(indicator({ limitsAvailable: false }))).toContain(
      "no plan limits",
    );
    expect(
      render(indicator({ provider: "openai-codex", limitsAvailable: false })),
    ).toContain("sign in");
    expect(render(indicator({ long: null }))).toContain("no weekly limit");
    // The reason is printed once but stays in the second row's title, so the
    // hollow row never claims "not reported".
    const hollow = render(indicator({ limitsAvailable: false }));
    expect(hollow).toContain('title="Weekly window: no plan limits"');
  });

  it("keeps both cycle rows in every state, so a card never reflows", () => {
    for (const html of [
      render(undefined),
      render(indicator()),
      render(indicator({ limitsAvailable: false })),
      render(indicator({ fetchedAt: null })),
    ]) {
      expect(html).toContain(">5h<");
      expect(html).toContain(">wk<");
    }
  });

  it("counts down to the reset instead of naming a clock time", () => {
    // 14:00 is two hours out, the weekly window three and a half days.
    const html = render(indicator());
    expect(html).toContain("2h");
    expect(html).toContain("3d 12h");
    expect(html).not.toContain("14:00");
    // The wall clock stays in the tooltip, where it costs no card width.
    expect(html).toContain("resets in 2h (");
  });

  it("reserves the same column widths in every state", () => {
    // The reading and reset columns are fixed, and the reason spans exactly
    // those two: whatever a row has to say, the meter track keeps its length,
    // so rows within a card and cards beside each other stay aligned.
    const columns = (html: string) =>
      [...html.matchAll(/w-\[[\d.]+em\]/g)].map((m) => m[0]);
    expect(columns(render(indicator()))).toEqual([
      "w-[1.5em]",
      "w-[3.4em]",
      "w-[4.2em]",
      "w-[1.5em]",
      "w-[3.4em]",
      "w-[4.2em]",
    ]);
    // No countdown to print (no `resetsAt`) still reserves the reset column.
    expect(
      columns(
        render(
          indicator({
            short: { usedPct: 62, resetsAt: null },
            long: { usedPct: 41, resetsAt: null },
          }),
        ),
      ),
    ).toHaveLength(6);
    for (const html of [
      render(undefined),
      render(indicator({ limitsAvailable: false })),
      render(indicator({ long: null })),
    ]) {
      const cols = columns(html);
      expect(cols.filter((c) => c === "w-[1.5em]")).toHaveLength(2);
    }
    // A reason cell is as wide as the two number columns plus their gap.
    expect(render(indicator({ limitsAvailable: false }))).toContain(
      "w-[8.1em]",
    );
  });
});
