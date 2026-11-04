/**
 * Claude usage through the gateway (G4b), against an injected `fetch`: the
 * request the server sends, the label read, the CLI's translation of the raw
 * body, drift and the timeout. Fakes only; no token is real.
 */
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ClaudeUsageSnapshot } from "@assistant/shared/usage";
import { test } from "vitest";
import {
  claudeConfigDir,
  createCredentialProfile,
  deleteCredentialProfile,
} from "../credentialProfiles.ts";
import { analyzeProviderError, runFailureFacts } from "../providerErrors.ts";
import {
  fetchClaudeUsageViaGateway,
  mapClaudeUsageBody,
  readClaudeSubscriptionType,
} from "./usageViaGateway.ts";
import { DRIFTED_USAGE, MEASURED_USAGE } from "../test/claudeUsageFixtures.ts";

// Synthetic fixture values; none is a real credential.
const FAKE_ACCESS = "fake-claude-access";
const FAKE_REFRESH = "fake-claude-refresh";
const LEASE = "lease-fixture";
const BASE = "http://127.0.0.1:9";
const ACCESS = { baseUrl: BASE, leaseToken: LEASE };
const NOW = 1_800_000_000_000;

const NO_SESSION = {
  totalCostUsd: 0,
  totalApiDurationMs: 0,
  totalDurationMs: 0,
};

interface Sent {
  url: string;
  init: RequestInit;
}

/** An injected `fetch` that records each request and answers `status`/`body`. */
function answering(
  status: number,
  body: string,
): {
  sent: Sent[];
  fetch: typeof fetch;
} {
  const sent: Sent[] = [];
  return {
    sent,
    fetch: async (url, init = {}) => {
      sent.push({ url: String(url), init });
      return new Response(body, { status });
    },
  };
}

function viaGateway(
  status: number,
  body: unknown,
): { sent: Sent[]; read: Promise<ClaudeUsageSnapshot> } {
  const fake = answering(
    status,
    typeof body === "string" ? body : JSON.stringify(body),
  );
  return {
    sent: fake.sent,
    read: fetchClaudeUsageViaGateway("p", ACCESS, 20_000, {
      fetch: fake.fetch,
      readSubscriptionType: async () => "max",
      now: () => NOW,
    }),
  };
}

/** AC4(a): every field the mappers read. */
const SYNTHETIC = {
  five_hour: { utilization: 42, resets_at: "2026-07-23T16:50:00.708218+00:00" },
  seven_day: { utilization: 7, resets_at: null },
  seven_day_opus: { utilization: 3, resets_at: null },
  extra_usage: {
    is_enabled: true,
    monthly_limit: 5000,
    used_credits: 1250,
    utilization: 25,
    currency: "USD",
    decimal_places: 2,
  },
  limits: [
    {
      kind: "weekly_scoped",
      group: "weekly",
      percent: 80,
      severity: "normal",
      resets_at: 1767225600,
      scope: { model: { id: null, display_name: "Fable" }, surface: null },
      is_active: true,
    },
    {
      kind: "weekly_scoped",
      group: "weekly",
      percent: 50,
      severity: "normal",
      resets_at: "2026-07-30T04:00:00+00:00",
      scope: { surface: "cli" },
      is_active: true,
    },
    {
      kind: "session",
      group: "session",
      percent: 100,
      severity: "critical",
      resets_at: "2026-07-23T16:50:00+00:00",
      scope: null,
      is_active: true,
    },
    null,
  ],
};

test("AC3: one GET to the usage route, with the lease and exactly the smoked headers", async () => {
  const { sent, read } = viaGateway(200, SYNTHETIC);
  await read;
  assert.equal(sent.length, 1);
  const [request] = sent;
  assert.equal(request!.url, `${BASE}/anthropic/api/oauth/usage`);
  assert.equal(request!.init.method ?? "GET", "GET");
  assert.equal(request!.init.body, undefined);
  assert.deepEqual(request!.init.headers, {
    Authorization: `Bearer ${LEASE}`,
    "anthropic-beta": "oauth-2025-04-20",
    Accept: "application/json",
    "User-Agent": "personal-assistant",
  });
  const text = JSON.stringify(request);
  assert.ok(!text.includes(FAKE_ACCESS), "no access token from the server");
  assert.ok(!text.includes(FAKE_REFRESH), "no refresh token from the server");
});

test("AC3: the label is the credential file's subscriptionType, or null", async () => {
  const { id } = createCredentialProfile({
    name: "Usage label",
    provider: "claude",
  });
  const file = join(claudeConfigDir(id), ".credentials.json");
  try {
    assert.equal(await readClaudeSubscriptionType(id), null, "missing file");
    writeFileSync(
      file,
      JSON.stringify({
        claudeAiOauth: {
          accessToken: FAKE_ACCESS,
          refreshToken: FAKE_REFRESH,
          expiresAt: NOW,
          subscriptionType: "max",
        },
      }),
    );
    assert.equal(await readClaudeSubscriptionType(id), "max");
    writeFileSync(file, "{not json");
    assert.equal(await readClaudeSubscriptionType(id), null, "malformed");
    writeFileSync(
      file,
      JSON.stringify({
        claudeAiOauth: { accessToken: FAKE_ACCESS, subscriptionType: 7 },
      }),
    );
    assert.equal(await readClaudeSubscriptionType(id), null, "not a string");
  } finally {
    deleteCredentialProfile(id);
  }
});

test("AC4(a): every field maps as the CLI's translation does", async () => {
  const expected: ClaudeUsageSnapshot = {
    fetchedAt: NOW,
    subscriptionType: "max",
    rateLimitsAvailable: true,
    fiveHour: {
      utilizationPct: 42,
      resetsAt: "2026-07-23T16:50:00.708218+00:00",
    },
    weekly: { utilizationPct: 7, resetsAt: null },
    limits: [
      {
        kind: "weekly_scoped",
        group: "weekly",
        percent: 80,
        severity: "normal",
        resetsAt: null,
        scope: { modelDisplayName: "Fable", surface: null },
        isActive: true,
      },
      {
        kind: "weekly_scoped",
        group: "weekly",
        percent: 50,
        severity: "normal",
        resetsAt: "2026-07-30T04:00:00+00:00",
        scope: { modelDisplayName: null, surface: "cli" },
        isActive: true,
      },
      {
        kind: "session",
        group: "session",
        percent: 100,
        severity: "critical",
        resetsAt: "2026-07-23T16:50:00+00:00",
        scope: null,
        isActive: true,
      },
    ],
    modelScoped: [
      {
        modelDisplayName: "Fable",
        utilizationPct: 80,
        resetsAt: "2026-01-01T00:00:00.000Z",
      },
    ],
    extraUsage: {
      enabled: true,
      monthlyLimit: 5000,
      usedCredits: 1250,
      utilizationPct: 25,
      currency: "USD",
      decimalPlaces: 2,
    },
    session: NO_SESSION,
  };
  assert.deepEqual(await viaGateway(200, SYNTHETIC).read, expected);
});

test("AC4(b): the measured body maps, its unknown keys ignored", async () => {
  const expected: ClaudeUsageSnapshot = {
    fetchedAt: NOW,
    subscriptionType: "max",
    rateLimitsAvailable: true,
    fiveHour: null,
    weekly: {
      utilizationPct: 1,
      resetsAt: "2026-11-11T01:00:00.154760+00:00",
    },
    limits: [
      {
        kind: "weekly_all",
        group: "weekly",
        percent: 1,
        severity: "normal",
        resetsAt: "2026-11-11T01:00:00.154760+00:00",
        scope: null,
        isActive: true,
      },
      {
        kind: "weekly_scoped",
        group: "weekly",
        percent: 0,
        severity: "normal",
        resetsAt: "2026-11-11T01:00:00+00:00",
        scope: { modelDisplayName: "Fable", surface: null },
        isActive: false,
      },
    ],
    modelScoped: [
      {
        modelDisplayName: "Fable",
        utilizationPct: 0,
        resetsAt: "2026-11-11T01:00:00+00:00",
      },
    ],
    extraUsage: {
      enabled: false,
      monthlyLimit: null,
      usedCredits: null,
      utilizationPct: null,
      currency: null,
      decimalPlaces: null,
    },
    session: NO_SESSION,
  };
  assert.deepEqual(await viaGateway(200, MEASURED_USAGE).read, expected);
});

test.each(DRIFTED_USAGE)(
  "AC5: %s is unavailable usage with the file's label",
  async (_name, body) => {
    assert.deepEqual(await viaGateway(200, body).read, {
      fetchedAt: NOW,
      subscriptionType: "max",
      rateLimitsAvailable: false,
      fiveHour: null,
      weekly: null,
      limits: [],
      modelScoped: [],
      extraUsage: null,
      session: NO_SESSION,
    });
  },
);

test("AC5: a window without a reset, and the measured weekly-only body, are recognised", () => {
  const bare = mapClaudeUsageBody(
    { five_hour: { utilization: 42 } },
    null,
    NOW,
  );
  assert.equal(bare.rateLimitsAvailable, true);
  assert.deepEqual(bare.fiveHour, { utilizationPct: 42, resetsAt: null });
  assert.equal(bare.weekly, null);
  assert.equal(
    mapClaudeUsageBody(MEASURED_USAGE, null, NOW).rateLimitsAvailable,
    true,
  );
});

test("AC12: a read that outlives its timeout throws the timeout text, never a dead login", async () => {
  const started = Date.now();
  // Any error on abort: the runtime's own abort error differs between runtimes.
  const hung: typeof fetch = (_url, init) =>
    new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () =>
        reject(new Error("aborted")),
      );
    });
  await assert.rejects(
    fetchClaudeUsageViaGateway("p", ACCESS, 50, {
      fetch: hung,
      readSubscriptionType: async () => "max",
    }),
    (err: Error) => {
      assert.equal(err.message, "Fetching Claude usage timed out.");
      assert.ok(!runFailureFacts(analyzeProviderError(err.message)).loginDeath);
      return true;
    },
  );
  assert.ok(Date.now() - started < 5_000, "bounded");
});
