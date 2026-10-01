/**
 * Standalone test for the Claude account usage/rate-limit fetcher.
 *
 * Run through the server Vitest suite:
 *   pnpm --filter @assistant/server test src/claudeSdk/usageQuery.test.ts
 */
import assert from "node:assert/strict";
import { test } from "vitest";
import type {
  ClaudeQuery,
  ClaudeQueryParams,
  ClaudeSdkSeam,
} from "./sdkSeam.ts";
import {
  fetchClaudeSdkUsage,
  mapClaudeUsageResponse,
  setClaudeSdkUsageSeam,
} from "./usageQuery.ts";
import {
  claudeConfigDir,
  createCredentialProfile,
  deleteCredentialProfile,
} from "../credentialProfiles.ts";

const RAW_RESPONSE = {
  session: {
    total_cost_usd: 0,
    total_api_duration_ms: 0,
    total_duration_ms: 786,
  },
  subscription_type: "team",
  rate_limits_available: true,
  rate_limits: {
    five_hour: {
      utilization: 37,
      resets_at: "2026-07-23T16:50:00.708218+00:00",
    },
    seven_day: {
      utilization: 12,
      resets_at: "2026-07-30T04:00:00.708239+00:00",
    },
    extra_usage: {
      is_enabled: true,
      monthly_limit: 5000,
      used_credits: 5025,
      utilization: 100,
      currency: "EUR",
      decimal_places: 2,
    },
    limits: [
      {
        kind: "session",
        group: "session",
        percent: 37,
        severity: "normal",
        resets_at: "2026-07-23T16:50:00.708218+00:00",
        scope: null,
        is_active: true,
      },
      {
        kind: "weekly_scoped",
        group: "weekly",
        percent: 0,
        severity: "normal",
        resets_at: null,
        scope: { model: { id: null, display_name: "Opus" }, surface: null },
        is_active: false,
      },
    ],
    model_scoped: [
      {
        display_name: "Fable",
        utilization: 3,
        resets_at: "2026-07-30T04:00:00.708239+00:00",
      },
    ],
  },
  behaviors: {
    day: {
      request_count: 1967,
      session_count: 14,
      behaviors: [{ key: "long_context", pct: 90, count: 1451 }],
      agents: [],
      skills: [],
      plugins: [],
      mcp_servers: [{ name: "pa", pct: 37 }],
    },
    week: {
      request_count: 3876,
      session_count: 47,
      behaviors: [],
      agents: [],
      skills: [],
      plugins: [],
      mcp_servers: [],
    },
  },
};

function fakeQuery(
  usage?: () => Promise<Record<string, unknown>>,
  onParams?: (p: ClaudeQueryParams) => void,
): (params: ClaudeQueryParams) => ClaudeQuery {
  return (params) => {
    onParams?.(params);
    return {
      async *[Symbol.asyncIterator]() {},
      close: () => {},
      ...(usage
        ? { usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: usage }
        : {}),
    } as ClaudeQuery;
  };
}

test("maps the raw experimental usage response to the stable wire shape", () => {
  const snapshot = mapClaudeUsageResponse(RAW_RESPONSE);
  assert.equal(snapshot.subscriptionType, "team");
  assert.equal(snapshot.rateLimitsAvailable, true);
  assert.deepEqual(snapshot.fiveHour, {
    utilizationPct: 37,
    resetsAt: "2026-07-23T16:50:00.708218+00:00",
  });
  assert.deepEqual(snapshot.weekly, {
    utilizationPct: 12,
    resetsAt: "2026-07-30T04:00:00.708239+00:00",
  });
  assert.equal(snapshot.extraUsage?.usedCredits, 5025);
  assert.equal(snapshot.extraUsage?.utilizationPct, 100);
  assert.equal(snapshot.extraUsage?.decimalPlaces, 2);
  assert.equal(snapshot.limits.length, 2);
  assert.equal(snapshot.limits[1]?.scope?.modelDisplayName, "Opus");
  assert.equal(snapshot.modelScoped.length, 1);
  assert.equal(snapshot.modelScoped[0]?.modelDisplayName, "Fable");
  assert.equal(snapshot.modelScoped[0]?.utilizationPct, 3);
  assert.equal(snapshot.behaviors?.day.requestCount, 1967);
  assert.equal(snapshot.behaviors?.day.topContributors[0]?.name, "pa");
});

test("fetches usage through a fake seam without sending any prompt turn", async () => {
  let captured: ClaudeQueryParams | undefined;
  const seam: ClaudeSdkSeam = {
    query: fakeQuery(
      () => Promise.resolve(RAW_RESPONSE),
      (p) => (captured = p),
    ),
  };
  setClaudeSdkUsageSeam(() => Promise.resolve(seam));

  const snapshot = await fetchClaudeSdkUsage();
  assert.equal(snapshot.subscriptionType, "team");
  assert.ok(captured, "query() was called");
  assert.notEqual(
    typeof captured?.prompt,
    "string",
    "prompt is a streaming generator, never a plain string turn",
  );
});

test("runs profile-scoped usage queries in the selected scrubbed Claude environment", async () => {
  const profile = createCredentialProfile({
    name: "Usage account",
    provider: "claude",
  });
  const previous = {
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
    CLAUDE_CODE_OAUTH_TOKEN: process.env.CLAUDE_CODE_OAUTH_TOKEN,
    CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR,
  };
  process.env.ANTHROPIC_API_KEY = "ambient-api-key";
  process.env.CLAUDE_CODE_OAUTH_TOKEN = "ambient-oauth";
  process.env.CLAUDE_CONFIG_DIR = "/ambient/claude";
  let captured: ClaudeQueryParams | undefined;
  setClaudeSdkUsageSeam(() =>
    Promise.resolve({
      query: fakeQuery(
        () => Promise.resolve(RAW_RESPONSE),
        (params) => (captured = params),
      ),
    }),
  );
  try {
    await fetchClaudeSdkUsage(20_000, profile.id);
    assert.equal(captured?.options?.env?.ANTHROPIC_API_KEY, undefined);
    assert.equal(captured?.options?.env?.CLAUDE_CODE_OAUTH_TOKEN, undefined);
    assert.equal(
      captured?.options?.env?.CLAUDE_CONFIG_DIR,
      claudeConfigDir(profile.id),
    );
  } finally {
    deleteCredentialProfile(profile.id);
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("throws when the connected CLI does not expose the usage control request", async () => {
  const seam: ClaudeSdkSeam = { query: fakeQuery(undefined) };
  setClaudeSdkUsageSeam(() => Promise.resolve(seam));
  await assert.rejects(() => fetchClaudeSdkUsage(), /does not support/);
});
