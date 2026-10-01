/**
 * Tests for the OpenAI (ChatGPT / Codex) usage fetcher.
 *
 * Run through the server Vitest suite:
 *   pnpm --filter @assistant/server test src/piSdk/openaiUsageQuery.test.ts
 */
import assert from "node:assert/strict";
import { test } from "vitest";
import {
  fetchOpenAiUsage,
  mapOpenAiUsageResponse,
  mapResetCredits,
  redeemOpenAiResetCredit,
} from "./openaiUsageQuery.ts";

/** Real observed `/wham/usage` shape (values scrubbed): primary window is WEEKLY here. */
const RAW_RESPONSE = {
  email: "user@example.com",
  plan_type: "team",
  rate_limit: {
    allowed: true,
    limit_reached: false,
    primary_window: {
      used_percent: 23,
      limit_window_seconds: 604800,
      reset_after_seconds: 439820,
      reset_at: 1785265184,
    },
    secondary_window: null,
    additional_rate_limits: [
      {
        name: "Codex Spark",
        used_percent: 5,
        limit_window_seconds: 18000,
        reset_at: 1785200000,
      },
    ],
  },
  credits: {
    has_credits: true,
    unlimited: false,
    overage_limit_reached: false,
    balance: null,
  },
  spend_control: {
    reached: true,
    individual_limit: {
      source: "account_user_spend_controls",
      limit: "4000",
      used: "4000.86",
      remaining: "0",
      used_percent: 100,
      reset_at: 1785542401,
    },
  },
  rate_limit_reset_credits: {
    available_count: 3,
    applicable_available_count: 0,
  },
};

const RESET_CREDITS_BODY = {
  available_count: 2,
  total_earned_count: 0,
  credits: [
    {
      id: "RateLimitResetCredit_late",
      status: "available",
      granted_at: "2026-07-13T18:13:38Z",
      expires_at: "2026-08-12T18:13:38Z",
      title: "Full reset",
      is_supported_by_plan: true,
    },
    {
      id: "RateLimitResetCredit_soon",
      status: "available",
      granted_at: "2026-07-01T20:36:40Z",
      expires_at: "2026-07-31T20:36:40Z",
      title: "Full reset",
      is_supported_by_plan: true,
    },
    {
      id: "RateLimitResetCredit_used",
      status: "redeemed",
      granted_at: "2026-06-01T00:00:00Z",
      expires_at: "2026-07-01T00:00:00Z",
      redeemed_at: "2026-06-15T00:00:00Z",
      title: "Full reset",
      is_supported_by_plan: true,
    },
  ],
};

const AUTH = { access: "tok", accountId: "acct", expires: 1_800_000_000_000 };
const NOW = 1_700_000_000_000;

test("maps the raw wham/usage response and classifies windows by duration", () => {
  const snap = mapOpenAiUsageResponse(RAW_RESPONSE, NOW);
  assert.equal(snap.available, true);
  assert.equal(snap.planType, "team");
  assert.equal(snap.limitReached, false);

  // primary_window is 7 days → classified weekly despite being "primary".
  const weekly = snap.windows.find(
    (w) => w.label === null && w.kind === "weekly",
  );
  assert.ok(weekly, "weekly window present");
  assert.equal(weekly?.usedPercent, 23);
  assert.equal(weekly?.resetsAt, new Date(1785265184 * 1000).toISOString());

  // additional_rate_limits carry a label and their own classification (5h).
  const spark = snap.windows.find((w) => w.label === "Codex Spark");
  assert.ok(spark, "named model window present");
  assert.equal(spark?.kind, "five_hour");

  // spend numeric strings parse; no currency is invented.
  assert.equal(snap.spendControl?.reached, true);
  assert.equal(snap.spendControl?.limit, 4000);
  assert.equal(snap.spendControl?.used, 4000.86);
  assert.equal(snap.spendControl?.usedPercent, 100);

  assert.equal(snap.credits?.hasCredits, true);
  assert.equal(snap.resetCredits?.availableCount, 3);
});

test("mapResetCredits parses per-credit rows and sorts soonest-expiring first", () => {
  const credits = mapResetCredits(RESET_CREDITS_BODY);
  assert.equal(credits.length, 3);
  assert.equal(credits[0]?.id, "RateLimitResetCredit_used"); // 2026-07-01 expiry sorts first
  assert.equal(credits[1]?.id, "RateLimitResetCredit_soon");
  assert.equal(credits[2]?.id, "RateLimitResetCredit_late");
  assert.equal(
    credits[1]?.expiresAt,
    new Date("2026-07-31T20:36:40Z").toISOString(),
  );
});

test("fetchOpenAiUsage returns available snapshot and enriches reset-credit detail (no filesystem/network)", async () => {
  const snap = await fetchOpenAiUsage({
    now: () => NOW,
    readAuth: async () => AUTH,
    fetchUsage: async () => ({ status: 200, body: RAW_RESPONSE }),
    fetchResetCredits: async () => ({ status: 200, body: RESET_CREDITS_BODY }),
  });
  assert.equal(snap.available, true);
  assert.equal(snap.email, "user@example.com");
  assert.equal(snap.resetCredits?.availableCount, 3);
  assert.equal(snap.resetCredits?.credits.length, 3);
  assert.equal(snap.resetCredits?.credits[0]?.title, "Full reset");
});

test("fetchOpenAiUsage still succeeds when reset-credit enrichment fails", async () => {
  const snap = await fetchOpenAiUsage({
    now: () => NOW,
    readAuth: async () => AUTH,
    fetchUsage: async () => ({ status: 200, body: RAW_RESPONSE }),
    fetchResetCredits: async () => {
      throw new Error("network");
    },
  });
  assert.equal(snap.available, true);
  assert.deepEqual(snap.resetCredits?.credits, []);
});

test("degrades to available:false when not signed in via pi", async () => {
  const snap = await fetchOpenAiUsage({
    now: () => NOW,
    readAuth: async () => null,
  });
  assert.equal(snap.available, false);
  assert.match(snap.unavailableReason ?? "", /signed in/i);
});

test("degrades to available:false on an expired token without hitting the network", async () => {
  let fetched = false;
  const snap = await fetchOpenAiUsage({
    now: () => NOW,
    readAuth: async () => ({
      access: "tok",
      accountId: "acct",
      expires: NOW - 1,
    }),
    fetchUsage: async () => {
      fetched = true;
      return { status: 200, body: {} };
    },
  });
  assert.equal(snap.available, false);
  assert.match(snap.unavailableReason ?? "", /expired/i);
  assert.equal(
    fetched,
    false,
    "expired token short-circuits before the network call",
  );
});

test("degrades to available:false on a 401 from the endpoint", async () => {
  const snap = await fetchOpenAiUsage({
    now: () => NOW,
    readAuth: async () => ({
      access: "tok",
      accountId: "acct",
      expires: NOW + 60_000,
    }),
    fetchUsage: async () => ({ status: 401, body: { error: "unauthorized" } }),
  });
  assert.equal(snap.available, false);
  assert.match(snap.unavailableReason ?? "", /reconnect/i);
});

test("throws on an unexpected HTTP status so the route can 502", async () => {
  await assert.rejects(
    () =>
      fetchOpenAiUsage({
        now: () => NOW,
        readAuth: async () => ({
          access: "tok",
          accountId: "acct",
          expires: NOW + 60_000,
        }),
        fetchUsage: async () => ({ status: 500, body: "boom" }),
      }),
    /HTTP 500/,
  );
});

test("redeem is REFUSED (guarded) and never POSTs when no reset is applicable", async () => {
  let consumed = false;
  await assert.rejects(
    () =>
      redeemOpenAiResetCredit("RateLimitResetCredit_soon", {
        readAuth: async () => AUTH,
        // applicable_available_count is 0 in RAW_RESPONSE ⇒ guard trips.
        fetchUsage: async () => ({ status: 200, body: RAW_RESPONSE }),
        postConsume: async () => {
          consumed = true;
          return { status: 200, body: {} };
        },
      }),
    /applicable/i,
  );
  assert.equal(
    consumed,
    false,
    "the irreversible consume POST must not fire when guarded",
  );
});

test("redeem skips the guard and POSTs when applicability is not required (redeem anyway / auto-redeem)", async () => {
  let usageReads = 0;
  let consumedId: string | null = null;
  const result = await redeemOpenAiResetCredit(
    "RateLimitResetCredit_soon",
    {
      readAuth: async () => AUTH,
      fetchUsage: async () => {
        usageReads += 1;
        return { status: 200, body: RAW_RESPONSE };
      },
      postConsume: async (_auth, creditId) => {
        consumedId = creditId;
        return { status: 200, body: { code: "reset", windows_reset: 1 } };
      },
    },
    { requireApplicable: false },
  );
  assert.equal(consumedId, "RateLimitResetCredit_soon");
  assert.equal(usageReads, 0, "no applicability pre-read when not required");
  assert.equal(result.ok, true);
});

test("redeem POSTs and reports the result when a reset is applicable", async () => {
  let consumedId: string | null = null;
  const result = await redeemOpenAiResetCredit("RateLimitResetCredit_soon", {
    readAuth: async () => AUTH,
    fetchUsage: async () => ({
      status: 200,
      body: {
        rate_limit_reset_credits: {
          available_count: 3,
          applicable_available_count: 1,
        },
      },
    }),
    newRequestId: () => "req-1",
    postConsume: async (_auth, creditId) => {
      consumedId = creditId;
      return {
        status: 200,
        body: {
          code: "reset",
          windows_reset: 1,
          credit: {
            id: creditId,
            status: "redeemed",
            redeemed_at: "2026-07-23T12:00:00Z",
          },
        },
      };
    },
  });
  assert.equal(consumedId, "RateLimitResetCredit_soon");
  assert.equal(result.ok, true);
  assert.equal(result.windowsReset, 1);
  assert.equal(result.code, "reset");
});
