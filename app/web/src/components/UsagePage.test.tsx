import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { CredentialProfileSummary } from "@assistant/shared";
import type {
  ClaudeUsageSnapshot,
  OpenAiResetCredit,
  OpenAiUsageSnapshot,
} from "@assistant/shared/usage";
import { failed, loading, ready, refreshing } from "../lib/loadState.ts";
import {
  OpenAiCreditsCard,
  UsageOverviewCard,
  usageOverviewRows,
} from "./UsagePage.tsx";

const claude: ClaudeUsageSnapshot = {
  fetchedAt: 0,
  subscriptionType: "max",
  rateLimitsAvailable: true,
  fiveHour: { utilizationPct: 27, resetsAt: "2030-01-01T01:00:00.000Z" },
  weekly: { utilizationPct: 61, resetsAt: "2030-01-07T01:00:00.000Z" },
  limits: [],
  modelScoped: [],
  extraUsage: null,
  session: { totalCostUsd: 0, totalApiDurationMs: 0, totalDurationMs: 0 },
  behaviors: null,
};

const openai: OpenAiUsageSnapshot = {
  fetchedAt: 0,
  available: true,
  unavailableReason: null,
  planType: "plus",
  email: null,
  limitReached: false,
  windows: [
    {
      kind: "five_hour",
      label: null,
      usedPercent: 34,
      windowSeconds: 18_000,
      resetsAt: null,
    },
    {
      kind: "weekly",
      label: null,
      usedPercent: 72,
      windowSeconds: 604_800,
      resetsAt: null,
    },
    {
      kind: "unknown",
      label: "Other",
      usedPercent: 10,
      windowSeconds: 60,
      resetsAt: null,
    },
  ],
  credits: null,
  spendControl: null,
  resetCredits: null,
};

const profile = (
  provider: CredentialProfileSummary["provider"],
): CredentialProfileSummary => ({
  id: provider,
  name: provider === "claude" ? "Claude personal" : "OpenAI work",
  provider,
  enabled: true,
  status: "ready",
  createdAt: 0,
  updatedAt: 0,
});

describe("Usage overview", () => {
  it("projects the primary subscription windows for each provider", () => {
    expect(
      usageOverviewRows(claude).map((row) => [row.label, row.pct]),
    ).toEqual([
      ["5-hour", 27],
      ["Weekly", 61],
    ]);
    expect(
      usageOverviewRows(openai).map((row) => [row.label, row.pct]),
    ).toEqual([
      ["5-hour session", 34],
      ["Weekly", 72],
    ]);
  });

  it("renders each account as its own glance card", () => {
    const html = [
      renderToStaticMarkup(
        <UsageOverviewCard
          profile={profile("claude")}
          state={ready(claude)}
          now={0}
        />,
      ),
      renderToStaticMarkup(
        <UsageOverviewCard
          profile={profile("openai-codex")}
          state={ready(openai)}
          now={0}
        />,
      ),
    ].join("");
    expect(html).toContain("Claude personal");
    expect(html).toContain("OpenAI work");
    expect(html).toContain("27%");
    expect(html).toContain("72%");
    expect(html).not.toContain("<select");
  });

  // The shared thresholds (`usageLevel`): amber from 70, red from 90 — the
  // cards and this page must never disagree about "nearly out".
  it("bands utilization by the shared thresholds", () => {
    const render = (pct: number) =>
      renderToStaticMarkup(
        <UsageOverviewCard
          profile={profile("claude")}
          state={ready({
            ...claude,
            weekly: { ...claude.weekly!, utilizationPct: pct },
          })}
          now={0}
        />,
      );
    expect(render(75)).toContain("bg-warning");
    expect(render(99)).toContain("bg-destructive");
  });
});

/**
 * The glance card's five states (`app/web/docs/loading-states.md`, Task-361
 * Phase 3d). Every account loads, refreshes and fails on its own, so each state
 * is asserted on ONE card: a refresh may not blank the meters it already shows,
 * and a failure may not silently look like an account with no limits.
 */
describe("Usage load states", () => {
  const card = (
    state: Parameters<typeof UsageOverviewCard>[0]["state"],
  ): string =>
    renderToStaticMarkup(
      <UsageOverviewCard profile={profile("claude")} state={state} now={0} />,
    );

  it("reserves the meters with skeletons before the first snapshot", () => {
    for (const state of [undefined, loading<ClaudeUsageSnapshot>()]) {
      const html = card(state);
      expect(html).toContain('aria-label="Loading Claude personal usage"');
      expect(html).toContain("animate-pulse");
      expect(html).not.toContain("Loading usage…");
    }
  });

  it("keeps the meters and marks the refresh (R2)", () => {
    const html = card(refreshing(claude));
    expect(html).toContain("27%");
    expect(html).toContain("Refreshing Claude personal usage");
    expect(html).not.toContain("animate-pulse");
  });

  it("reports a failure as an alert, under the retained meters (R2)", () => {
    const html = card(failed("provider timed out", claude));
    expect(html).toContain('role="alert"');
    expect(html).toContain("provider timed out");
    expect(html).toContain("27%");
  });

  it("says nothing is loading once a failure has no data behind it", () => {
    const html = card(failed<ClaudeUsageSnapshot>("not signed in"));
    expect(html).toContain("not signed in");
    expect(html).not.toContain("animate-pulse");
  });
});

describe("OpenAI reset credits", () => {
  // Clock times and "today"/"tomorrow" are rendered in the browser's zone, so
  // the zone is pinned for these assertions (Node re-reads TZ on assignment).
  let savedTz: string | undefined;
  beforeAll(() => {
    savedTz = process.env.TZ;
    process.env.TZ = "Europe/Berlin";
  });
  afterAll(() => {
    if (savedTz === undefined) delete process.env.TZ;
    else process.env.TZ = savedTz;
  });
  // 20:00 Berlin on Sep 20.
  const NOW = Date.parse("2026-09-20T18:00:00Z");
  const HOUR = 60 * 60_000;
  /** The clock as the card prints it — locale-formatted, like the meters. */
  const clock = (iso: string | number) =>
    new Date(iso).toLocaleTimeString(undefined, {
      hour: "2-digit",
      minute: "2-digit",
    });
  const card = (
    credits: NonNullable<OpenAiUsageSnapshot["resetCredits"]>["credits"],
    applicableCount = 0,
  ): string =>
    renderToStaticMarkup(
      <OpenAiCreditsCard
        credits={{
          hasCredits: false,
          unlimited: false,
          overageLimitReached: false,
          balance: null,
          approxLocalMessages: null,
          approxCloudMessages: null,
        }}
        resetCredits={{
          availableCount: credits.length,
          applicableCount,
          credits,
        }}
        now={NOW}
        onReload={async () => {}}
        profileId="openai"
      />,
    );
  const credit = (
    id: string,
    expiresAt: string,
    status = "available",
  ): OpenAiResetCredit => ({
    id,
    status,
    grantedAt: null,
    expiresAt,
    redeemedAt: status === "redeemed" ? expiresAt : null,
    title: "Full reset",
    description: null,
    supportedByPlan: true,
  });

  it("prints the clock time once the expiry is close, not a rounded-up day count", () => {
    // 04:21 UTC tomorrow = 06:21 Berlin, ten hours out: yesterday's UI said "in 1d".
    const html = card([credit("c", "2026-09-21T04:21:00Z")]);
    expect(html).toContain(
      `expires tomorrow ${clock("2026-09-21T04:21:00Z")} · in 10h · auto-redeems ${clock("2026-09-20T22:21:00Z")}`,
    );
    expect(html).toContain("text-destructive");
    expect(html).not.toContain("in 1d");
  });

  it("keeps a far-off expiry to the date and a soon one to date plus time", () => {
    const far = card([
      credit("far", new Date(NOW + 14 * 24 * HOUR).toISOString()),
    ]);
    expect(far).toContain("expires Oct 4 · in 14d");
    expect(far).toContain("text-muted-foreground");
    const soon = card([credit("soon", "2026-09-23T04:21:00Z")]);
    expect(soon).toContain(
      `expires Sep 23, ${clock("2026-09-23T04:21:00Z")} · in 2d 10h`,
    );
    expect(soon).toContain("text-warning");
  });

  it("says the server is about to spend a credit inside the auto-redeem lead", () => {
    const html = card([credit("c", new Date(NOW + 2 * HOUR).toISOString())]);
    expect(html).toContain(
      `expires today ${clock(NOW + 2 * HOUR)} · in 2h · auto-redeem due`,
    );
  });

  it("lets the user redeem without being rate-limited, and says what that means", () => {
    const html = card([credit("c", "2026-10-04T04:21:00Z")]);
    expect(html).toContain("Redeem a reset");
    // The enabled button carries no `disabled=""` attribute (only the
    // `disabled:` utility class).
    expect(html).not.toMatch(/<button[^>]*\sdisabled=""[^>]*>Redeem a reset/);
    expect(html).toContain("You will be asked to confirm");
    expect(html).toContain("redeemed automatically 6h before it expires");
    const hit = card([credit("c", "2026-10-04T04:21:00Z")], 1);
    expect(hit).toContain("1 usable now");
    expect(hit).toContain("Resets one currently-hit window");
  });

  it("still lists spent credits when none is left to redeem", () => {
    const html = card([credit("b", "2026-09-20T17:30:00Z", "redeemed")]);
    expect(html).toContain(`redeemed today ${clock("2026-09-20T17:30:00Z")}`);
    expect(html).not.toContain("Redeem a reset");
  });

  it("lists a spent credit dimmed, under the available ones", () => {
    const html = card([
      credit("a", "2026-10-04T04:21:00Z"),
      credit("b", "2026-09-20T17:30:00Z", "redeemed"),
    ]);
    expect(html).toContain(`redeemed today ${clock("2026-09-20T17:30:00Z")}`);
  });
});
