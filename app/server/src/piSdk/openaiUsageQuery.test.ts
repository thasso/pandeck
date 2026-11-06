/**
 * Tests for the OpenAI (ChatGPT / Codex) usage fetcher.
 *
 * Run through the server Vitest suite:
 *   pnpm --filter @assistant/server test src/piSdk/openaiUsageQuery.test.ts
 */
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, test, vi } from "vitest";
import {
  createCredentialProfile,
  mirrorRemoteCredentialProfiles,
  piAgentDir,
} from "../credentialProfiles.ts";
import {
  refusalResponse,
  refusalText,
  type Refusal,
} from "../gateway/refusals.ts";
import {
  fetchOpenAiUsage,
  fetchOpenAiUsageForProfile,
  fetchOpenAiUsageViaGateway,
  mapOpenAiUsageResponse,
  hasPiCodexLogin,
  mapResetCredits,
  redeemOpenAiResetCredit,
  redeemOpenAiResetCreditForProfile,
  redeemOpenAiResetCreditViaGateway,
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

/** A direct backend expiring at `expires`; the fakes below never send it. */
const backend = (expires: number | null) => ({
  expires,
  base: "https://chatgpt.com/backend-api/wham",
  headers: {},
});
const AUTH = backend(1_800_000_000_000);
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
  assert.equal(snap.unavailableCode, "not-signed-in");
});

test("degrades to available:false on an expired token without hitting the network", async () => {
  let fetched = false;
  const snap = await fetchOpenAiUsage({
    now: () => NOW,
    readAuth: async () => backend(NOW - 1),
    fetchUsage: async () => {
      fetched = true;
      return { status: 200, body: {} };
    },
  });
  assert.equal(snap.available, false);
  assert.match(snap.unavailableReason ?? "", /expired/i);
  assert.equal(snap.unavailableCode, "expired");
  assert.equal(
    fetched,
    false,
    "expired token short-circuits before the network call",
  );
});

test("degrades to available:false on a 401 from the endpoint", async () => {
  const snap = await fetchOpenAiUsage({
    now: () => NOW,
    readAuth: async () => backend(NOW + 60_000),
    fetchUsage: async () => ({ status: 401, body: { error: "unauthorized" } }),
  });
  assert.equal(snap.available, false);
  assert.match(snap.unavailableReason ?? "", /reconnect/i);
  assert.equal(snap.unavailableCode, "rejected");
});

test("a forbidden usage endpoint has its own non-login-death code", async () => {
  const snap = await fetchOpenAiUsage({
    now: () => NOW,
    readAuth: async () => AUTH,
    fetchUsage: async () => ({ status: 403, body: "permission denied" }),
  });
  assert.equal(snap.available, false);
  assert.equal(snap.unavailableCode, "forbidden");
});

test("throws on an unexpected HTTP status so the route can 502", async () => {
  await assert.rejects(
    () =>
      fetchOpenAiUsage({
        now: () => NOW,
        readAuth: async () => backend(NOW + 60_000),
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

// Synthetic fixture values; none is a real credential.
const FAKE_ACCESS = "fake-codex-access";
const FAKE_ACCOUNT = "fake-account";
const GATEWAY = { baseUrl: "http://127.0.0.1:9", leaseToken: "lease-token" };

/** A Codex profile whose `auth.json` holds `entry`, or no Codex login at all. */
function codexProfile(entry: Record<string, unknown> | undefined): string {
  const id = createCredentialProfile({
    name: "Usage query fixture",
    provider: "openai-codex",
  }).id;
  writeFileSync(
    join(piAgentDir(id), "auth.json"),
    JSON.stringify(entry ? { "openai-codex": entry } : {}),
  );
  return id;
}

function signedIn(expires: number): string {
  return codexProfile({
    type: "oauth",
    access: FAKE_ACCESS,
    refresh: "fake-refresh",
    expires,
    accountId: FAKE_ACCOUNT,
  });
}

interface Sent {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: string | undefined;
}

/** `fetch` replaced: records each request and answers by its path's last segment. */
function stubFetch(answers: Record<string, unknown>): Sent[] {
  const sent: Sent[] = [];
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    sent.push({
      method: init.method ?? "GET",
      url,
      headers: init.headers as Record<string, string>,
      body: init.body as string | undefined,
    });
    const answer = answers[url.slice(url.lastIndexOf("/") + 1)];
    return new Response(JSON.stringify(answer ?? null), {
      status: answer === undefined ? 404 : 200,
    });
  });
  return sent;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

const ANSWERS = {
  usage: RAW_RESPONSE,
  "rate-limit-reset-credits": RESET_CREDITS_BODY,
  consume: { code: "reset", windows_reset: 1 },
};

test("AC14: through the gateway, usage, credits and consume carry the lease and no account id", async () => {
  const profile = signedIn(Date.now() + 3_600_000);
  const sent = stubFetch(ANSWERS);
  const snap = await fetchOpenAiUsageViaGateway(profile, GATEWAY);
  assert.equal(snap.available, true);
  const redeemed = await redeemOpenAiResetCreditViaGateway(
    profile,
    GATEWAY,
    "RateLimitResetCredit_soon",
    { requireApplicable: false, redeemRequestId: "redeem-1" },
  );
  assert.equal(redeemed.ok, true);

  const wham = `${GATEWAY.baseUrl}/chatgpt/backend-api/wham`;
  assert.deepEqual(
    sent.map(({ method, url }) => [method, url]),
    [
      ["GET", `${wham}/usage`],
      ["GET", `${wham}/rate-limit-reset-credits`],
      ["POST", `${wham}/rate-limit-reset-credits/consume`],
    ],
  );
  const browser = {
    Origin: "https://chatgpt.com",
    Referer: "https://chatgpt.com/",
    "User-Agent": "Mozilla/5.0",
  };
  const leased = {
    Authorization: `Bearer ${GATEWAY.leaseToken}`,
    Accept: "application/json",
    ...browser,
  };
  assert.deepEqual(
    sent.map(({ headers }) => headers),
    [leased, leased, { ...leased, "Content-Type": "application/json" }],
  );
  assert.deepEqual(JSON.parse(sent[2]!.body!), {
    credit_id: "RateLimitResetCredit_soon",
    redeem_request_id: "redeem-1",
  });
  for (const request of sent) {
    const text = JSON.stringify(request);
    assert.ok(!text.includes(FAKE_ACCESS), "no Codex token from the server");
    assert.ok(!text.includes(FAKE_ACCOUNT), "no account id from the server");
  }
});

test("AC4: the server's Codex read is presence only", async () => {
  const present = await hasPiCodexLogin(signedIn(Date.now() - 1_000));
  assert.equal(present, true);
  assert.equal(typeof present, "boolean");
  assert.equal(await hasPiCodexLogin(codexProfile(undefined)), false);
  assert.equal(
    await hasPiCodexLogin(codexProfile({ type: "api_key", key: "k" })),
    false,
  );
});

test("client mode: the gateway's account state stands in for the local login", async () => {
  const account = {
    name: "Gateway",
    provider: "openai-codex",
    enabled: true,
  } as const;
  try {
    mirrorRemoteCredentialProfiles([
      { ...account, id: "codex-ready", needsLogin: false },
      { ...account, id: "codex-login", needsLogin: true },
    ]);
    assert.equal(await hasPiCodexLogin("codex-ready"), true);
    assert.equal(await hasPiCodexLogin("codex-login"), false);
  } finally {
    mirrorRemoteCredentialProfiles(undefined);
  }
});

test("AC4: through the gateway an expired-looking login still asks, and a missing one sends nothing", async () =>
  const sent = stubFetch(ANSWERS);
  // The gateway owns the expiry: it renews before it forwards.
  const expired = await fetchOpenAiUsageViaGateway(
    signedIn(Date.now() - 1_000),
    GATEWAY,
  );
  assert.equal(expired.available, true);
  assert.equal(sent.length, 2, "usage and the credit inventory");
  sent.length = 0;
  const missing = await fetchOpenAiUsageViaGateway(
    codexProfile(undefined),
    GATEWAY,
  );
  assert.equal(missing.unavailableCode, "not-signed-in");
  assert.deepEqual(sent, []);
});

test("AC4: through the gateway an upstream 401 is a failed request, never a rejected login", async () => {
  vi.stubGlobal(
    "fetch",
    async () =>
      new Response(JSON.stringify({ detail: "unauthorized" }), { status: 401 }),
  );
  await assert.rejects(
    fetchOpenAiUsageViaGateway(signedIn(Date.now() + 3_600_000), GATEWAY),
    { message: "OpenAI usage request failed (HTTP 401)." },
  );
});

test("AC4: the direct path keeps its expiry and rejection", async () => {
  const sent = stubFetch(ANSWERS);
  const expired = await fetchOpenAiUsageForProfile(
    signedIn(Date.now() - 1_000),
  );
  assert.equal(expired.unavailableCode, "expired");
  assert.deepEqual(sent, []);
  vi.stubGlobal(
    "fetch",
    async () =>
      new Response(JSON.stringify({ detail: "unauthorized" }), { status: 401 }),
  );
  const rejected = await fetchOpenAiUsageForProfile(
    signedIn(Date.now() + 3_600_000),
  );
  assert.equal(rejected.unavailableCode, "rejected");
});

test("AC14: with the switch off, the direct requests carry today's headers", async () => {
  const profile = signedIn(Date.now() + 3_600_000);
  const sent = stubFetch(ANSWERS);
  await fetchOpenAiUsageForProfile(profile);
  await redeemOpenAiResetCreditForProfile(
    profile,
    "RateLimitResetCredit_soon",
    {
      requireApplicable: false,
      redeemRequestId: "redeem-1",
    },
  );
  const wham = "https://chatgpt.com/backend-api/wham";
  const today = {
    Authorization: `Bearer ${FAKE_ACCESS}`,
    Accept: "application/json",
    "ChatGPT-Account-Id": FAKE_ACCOUNT,
    Origin: "https://chatgpt.com",
    Referer: "https://chatgpt.com/",
    "User-Agent": "Mozilla/5.0",
  };
  assert.deepEqual(sent, [
    { method: "GET", url: `${wham}/usage`, headers: today, body: undefined },
    {
      method: "GET",
      url: `${wham}/rate-limit-reset-credits`,
      headers: today,
      body: undefined,
    },
    {
      method: "POST",
      url: `${wham}/rate-limit-reset-credits/consume`,
      headers: { ...today, "Content-Type": "application/json" },
      body: JSON.stringify({
        credit_id: "RateLimitResetCredit_soon",
        redeem_request_id: "redeem-1",
      }),
    },
  ]);
});

/** The gateway's own refusals a server lease can meet, as the gateway sends them. */
const REFUSALS: [string, Refusal][] = [
  ["401 revoked lease", { case: "revoked-lease", reason: "profile-removed" }],
  ["403 forbidden", { case: "forbidden" }],
  ["503 credential missing", { case: "credential", problem: "missing" }],
  [
    "502 unreachable",
    { case: "unreachable", upstream: "ChatGPT", reason: "ECONNREFUSED" },
  ],
];

function refused(refusal: Refusal): { status: number; body: unknown } {
  const { status, body } = refusalResponse(refusal, "codex");
  return { status, body: JSON.parse(body) };
}

test.each(REFUSALS)(
  "AC16: a gateway %s on usage throws its text, never rejected or forbidden",
  async (_name, refusal) => {
    await assert.rejects(
      fetchOpenAiUsage({
        now: () => NOW,
        readAuth: async () => AUTH,
        fetchUsage: async () => refused(refusal),
      }),
      { message: refusalText(refusal) },
    );
  },
);

test.each(REFUSALS)(
  "AC16: a gateway %s on the redeem's re-check or consume throws its text",
  async (_name, refusal) => {
    let consumed = 0;
    await assert.rejects(
      redeemOpenAiResetCredit("RateLimitResetCredit_soon", {
        readAuth: async () => AUTH,
        fetchUsage: async () => refused(refusal),
        postConsume: async () => {
          consumed += 1;
          return { status: 200, body: {} };
        },
      }),
      { message: refusalText(refusal) },
    );
    assert.equal(consumed, 0, "a refused re-check consumes nothing");
    await assert.rejects(
      redeemOpenAiResetCredit(
        "RateLimitResetCredit_soon",
        {
          readAuth: async () => AUTH,
          postConsume: async () => refused(refusal),
        },
        { requireApplicable: false },
      ),
      { message: refusalText(refusal) },
    );
  },
);
