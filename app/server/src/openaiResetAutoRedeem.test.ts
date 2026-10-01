/**
 * Tests for the OpenAI reset-credit auto-redeem sweep.
 *
 * Run through the server Vitest suite:
 *   pnpm --filter @assistant/server test src/openaiResetAutoRedeem.test.ts
 */
import assert from "node:assert/strict";
import { afterEach, test } from "vitest";
import type { CredentialProfileSummary } from "@assistant/shared";
import {
  OPENAI_RESET_AUTO_REDEEM_LEAD_MS,
  type OpenAiResetCredit,
  type OpenAiUsageSnapshot,
} from "@assistant/shared/usage";
import {
  resetInventoryIncomplete,
  resetOpenAiResetAutoRedeemForTests,
  selectExpiringResetCredits,
  sweepOpenAiResetAutoRedeem,
  type AutoRedeemDeps,
} from "./openaiResetAutoRedeem.ts";

const HOUR = 60 * 60_000;
const NOW = Date.parse("2026-09-20T20:00:00Z");

const credit = (
  id: string,
  expiresAt: string | null,
  status = "available",
): OpenAiResetCredit => ({
  id,
  status,
  grantedAt: null,
  expiresAt,
  redeemedAt: null,
  title: "Full reset",
  description: null,
  supportedByPlan: true,
});

const snapshot = (
  credits: OpenAiResetCredit[],
  extra: Partial<OpenAiUsageSnapshot> = {},
): OpenAiUsageSnapshot => ({
  fetchedAt: NOW,
  available: true,
  unavailableReason: null,
  planType: "plus",
  email: null,
  limitReached: false,
  windows: [],
  credits: null,
  spendControl: null,
  resetCredits: {
    availableCount: credits.filter((c) => c.status === "available").length,
    applicableCount: 0,
    credits,
  },
  ...extra,
});

const iso = (ms: number) => new Date(ms).toISOString();

const profile = (
  id: string,
  provider: CredentialProfileSummary["provider"] = "openai-codex",
  enabled = true,
): CredentialProfileSummary => ({
  id,
  name: id,
  provider,
  enabled,
  status: "ready",
  createdAt: 0,
  updatedAt: 0,
});

afterEach(() => resetOpenAiResetAutoRedeemForTests());

test("selects only available credits inside the lead, soonest first", () => {
  const rows = [
    credit("far", iso(NOW + 5 * 24 * HOUR)),
    credit("later", iso(NOW + OPENAI_RESET_AUTO_REDEEM_LEAD_MS)),
    credit("soon", iso(NOW + HOUR)),
    credit("gone", iso(NOW - HOUR)),
    credit("spent", iso(NOW + HOUR), "redeemed"),
    credit("unknown", null),
  ];
  assert.deepEqual(
    selectExpiringResetCredits(snapshot(rows), NOW).map((c) => c.id),
    ["soon", "later"],
  );
  assert.deepEqual(
    selectExpiringResetCredits(snapshot(rows, { available: false }), NOW),
    [],
  );
  assert.deepEqual(selectExpiringResetCredits(null, NOW), [], "no snapshot");
});

/** A deps harness that records every call and answers from a scripted cache. */
function harness(options: {
  profiles?: CredentialProfileSummary[];
  cached?: Record<string, { snapshot: OpenAiUsageSnapshot; fetchedAt: number }>;
  live?: Record<string, OpenAiUsageSnapshot | Error>;
  redeemError?: Error | undefined;
}) {
  const calls = {
    reads: [] as { profileId: string; force: boolean }[],
    redeems: [] as { profileId: string; creditId: string; requestId: string }[],
    revalidated: [] as string[],
  };
  const deps: AutoRedeemDeps = {
    listProfiles: () => options.profiles ?? [profile("acct")],
    peek: (profileId) => options.cached?.[profileId] ?? null,
    read: async (profileId, force) => {
      calls.reads.push({ profileId, force });
      const live = options.live?.[profileId];
      if (live instanceof Error) throw live;
      if (live) return live;
      return options.cached?.[profileId]?.snapshot ?? snapshot([]);
    },
    redeem: async (profileId, creditId, requestId) => {
      calls.redeems.push({ profileId, creditId, requestId });
      if (options.redeemError) throw options.redeemError;
      return {
        ok: true,
        code: "reset",
        windowsReset: 1,
        creditId,
        redeemedAt: iso(NOW),
      };
    },
    revalidate: (profileId) => {
      calls.revalidated.push(profileId);
    },
    now: () => NOW,
  };
  return { deps, calls };
}

test("leaves a fresh cache with nothing due alone — no fetch, no POST", async () => {
  const { deps, calls } = harness({
    cached: {
      acct: {
        snapshot: snapshot([credit("far", iso(NOW + 3 * 24 * HOUR))]),
        fetchedAt: NOW - HOUR,
      },
    },
  });
  const outcomes = await sweepOpenAiResetAutoRedeem(deps);
  assert.deepEqual(outcomes, []);
  assert.deepEqual(calls.reads, []);
  assert.deepEqual(calls.redeems, []);
});

test("re-reads live before redeeming a due credit, then forces a revalidation", async () => {
  const due = credit("due", iso(NOW + 2 * HOUR));
  const { deps, calls } = harness({
    cached: { acct: { snapshot: snapshot([due]), fetchedAt: NOW - HOUR } },
    live: { acct: snapshot([due]) },
  });
  const outcomes = await sweepOpenAiResetAutoRedeem(deps);
  assert.deepEqual(calls.reads, [{ profileId: "acct", force: true }]);
  assert.deepEqual(
    calls.redeems.map(({ profileId, creditId }) => ({ profileId, creditId })),
    [{ profileId: "acct", creditId: "due" }],
  );
  assert.deepEqual(calls.revalidated, ["acct"]);
  assert.equal(outcomes.length, 1);
  assert.equal(outcomes[0]!.result?.windowsReset, 1);
  assert.equal(outcomes[0]!.error, null);
});

test("the live re-read wins: a credit spent elsewhere is not POSTed", async () => {
  const due = credit("due", iso(NOW + 2 * HOUR));
  const { deps, calls } = harness({
    cached: { acct: { snapshot: snapshot([due]), fetchedAt: NOW - HOUR } },
    live: { acct: snapshot([{ ...due, status: "redeemed" }]) },
  });
  await sweepOpenAiResetAutoRedeem(deps);
  assert.deepEqual(calls.redeems, []);
  assert.deepEqual(calls.revalidated, []);
});

test("a failed live re-read still redeems what the cache calls for", async () => {
  const due = credit("due", iso(NOW + 2 * HOUR));
  const { deps, calls } = harness({
    cached: { acct: { snapshot: snapshot([due]), fetchedAt: NOW - HOUR } },
    live: { acct: new Error("network down") },
  });
  const outcomes = await sweepOpenAiResetAutoRedeem(deps);
  assert.deepEqual(
    calls.redeems.map((r) => r.creditId),
    ["due"],
  );
  assert.equal(outcomes[0]!.error, null);
});

test("refreshes a cache older than the lead so a newly granted credit is discovered", async () => {
  const { deps, calls } = harness({
    cached: {
      acct: {
        snapshot: snapshot([]),
        fetchedAt: NOW - OPENAI_RESET_AUTO_REDEEM_LEAD_MS - 1,
      },
    },
    live: { acct: snapshot([credit("new", iso(NOW + HOUR))]) },
  });
  await sweepOpenAiResetAutoRedeem(deps);
  assert.deepEqual(calls.reads, [{ profileId: "acct", force: false }]);
  assert.deepEqual(
    calls.redeems.map((r) => r.creditId),
    ["new"],
  );
});

test("a cached due credit survives a live read that came back counts-only", async () => {
  const due = credit("due", iso(NOW + 2 * HOUR));
  const countsOnly = snapshot([], {
    resetCredits: { availableCount: 1, applicableCount: 0, credits: [] },
  });
  assert.equal(resetInventoryIncomplete(countsOnly), true);
  assert.equal(resetInventoryIncomplete(snapshot([due])), false);
  const { deps, calls } = harness({
    cached: { acct: { snapshot: snapshot([due]), fetchedAt: NOW - HOUR } },
    live: { acct: countsOnly },
  });
  await sweepOpenAiResetAutoRedeem(deps);
  assert.deepEqual(
    calls.redeems.map((r) => r.creditId),
    ["due"],
  );
});

test("a fresh counts-only cache is re-read live (forced) rather than trusted", async () => {
  const countsOnly = snapshot([], {
    resetCredits: { availableCount: 1, applicableCount: 0, credits: [] },
  });
  const { deps, calls } = harness({
    cached: { acct: { snapshot: countsOnly, fetchedAt: NOW - 60_000 } },
    live: { acct: snapshot([credit("found", iso(NOW + HOUR))]) },
  });
  await sweepOpenAiResetAutoRedeem(deps);
  assert.deepEqual(calls.reads, [{ profileId: "acct", force: true }]);
  assert.deepEqual(
    calls.redeems.map((r) => r.creditId),
    ["found"],
  );
});

test("a failed POST is retried by the next sweep under the SAME request id", async () => {
  const due = credit("due", iso(NOW + 2 * HOUR));
  const options = {
    cached: { acct: { snapshot: snapshot([due]), fetchedAt: NOW } },
    live: { acct: snapshot([due]) },
    redeemError: new Error("socket hang up") as Error | undefined,
  };
  const { deps, calls } = harness(options);
  await sweepOpenAiResetAutoRedeem(deps);
  options.redeemError = undefined;
  await sweepOpenAiResetAutoRedeem(deps);
  await sweepOpenAiResetAutoRedeem(deps);
  assert.equal(calls.redeems.length, 2, "retried once, then confirmed");
  assert.equal(calls.redeems[0]!.requestId, calls.redeems[1]!.requestId);
  assert.match(calls.redeems[0]!.requestId, /^[0-9a-f-]{36}$/);
});

test("never sends the same credit twice from one process, even if the cache still lists it", async () => {
  const due = credit("due", iso(NOW + 2 * HOUR));
  const cached = { acct: { snapshot: snapshot([due]), fetchedAt: NOW - HOUR } };
  const { deps, calls } = harness({ cached, live: { acct: snapshot([due]) } });
  await sweepOpenAiResetAutoRedeem(deps);
  await sweepOpenAiResetAutoRedeem(deps);
  assert.equal(calls.redeems.length, 1);
});

test("a failed POST is reported and does not stop the other accounts", async () => {
  const dueA = credit("a", iso(NOW + HOUR));
  const dueB = credit("b", iso(NOW + HOUR));
  const { deps, calls } = harness({
    profiles: [profile("one"), profile("two")],
    cached: {
      one: { snapshot: snapshot([dueA]), fetchedAt: NOW },
      two: { snapshot: snapshot([dueB]), fetchedAt: NOW },
    },
    redeemError: new Error("HTTP 400"),
  });
  const outcomes = await sweepOpenAiResetAutoRedeem(deps);
  assert.deepEqual(
    calls.redeems.map((r) => r.creditId),
    ["a", "b"],
  );
  assert.deepEqual(
    outcomes.map((o) => o.error),
    ["HTTP 400", "HTTP 400"],
  );
});

test("touches only ENABLED OpenAI accounts", async () => {
  const due = credit("due", iso(NOW + HOUR));
  const { deps, calls } = harness({
    profiles: [
      profile("claude", "claude"),
      profile("off", "openai-codex", false),
      profile("on"),
    ],
    cached: {
      claude: { snapshot: snapshot([due]), fetchedAt: NOW },
      off: { snapshot: snapshot([due]), fetchedAt: NOW },
      on: { snapshot: snapshot([due]), fetchedAt: NOW },
    },
  });
  await sweepOpenAiResetAutoRedeem(deps);
  assert.deepEqual(
    calls.redeems.map(({ profileId, creditId }) => ({ profileId, creditId })),
    [{ profileId: "on", creditId: "due" }],
  );
});
