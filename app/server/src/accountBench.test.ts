import {
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { CredentialProfileSummary } from "@assistant/shared";
import type {
  ClaudeUsageSnapshot,
  OpenAiUsageSnapshot,
} from "@assistant/shared/usage";
import { AccountHealthStore } from "./accountHealth.ts";
import {
  AccountBenchStore,
  QUOTA_BENCH_MS,
  RATE_LIMIT_BENCH_MS,
} from "./accountBench.ts";
import { analyzeProviderError, runFailureFacts } from "./providerErrors.ts";
import { rankAccountCandidates } from "./accountRouter.ts";
import { mapOpenAiUsageResponse } from "./piSdk/openaiUsageQuery.ts";
import { mapClaudeUsageResponse } from "./claudeSdk/usageQuery.ts";

const dirs: string[] = [];
const stores: AccountHealthStore[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.dispose();
  vi.useRealTimers();
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});
function fixture(provider: CredentialProfileSummary["provider"] = "claude") {
  const dir = mkdtempSync(join(tmpdir(), "account-bench-"));
  dirs.push(dir);
  let now = Date.UTC(2030, 0, 1);
  let present = true;
  const push = vi.fn(async () => {});
  const path = join(dir, "health.json");
  const create = () => {
    const store = new AccountHealthStore({
      now: () => now,
      persistPath: path,
      push,
      hasCredential: () => present,
      profiles: () =>
        store.summaries(() =>
          present
            ? [
                {
                  id: "acct",
                  name: "Work",
                  provider,
                  enabled: true,
                  enterprise: false,
                  status: "ready",
                  createdAt: 1,
                  updatedAt: 1,
                  health: store.read("acct", true),
                },
              ]
            : [],
        ),
    });
    stores.push(store);
    store.alerts();
    return store;
  };
  return {
    store: create(),
    restart: create,
    now: () => now,
    advance: (ms: number) => (now += ms),
    remove: () => (present = false),
    push,
    path: join(dir, "health-benches.json"),
  };
}
function snapshot(
  now: number,
  used = 100,
  model?: string,
): ClaudeUsageSnapshot {
  const window = {
    utilizationPct: used,
    resetsAt: new Date(now + 3600_000).toISOString(),
  };
  return {
    fetchedAt: now,
    rateLimitsAvailable: true,
    subscriptionType: null,
    fiveHour: model ? { ...window, utilizationPct: 20 } : window,
    weekly: { ...window, utilizationPct: 20 },
    limits: [],
    modelScoped: model ? [{ modelDisplayName: model, ...window }] : [],
    extraUsage: null,
    session: { totalCostUsd: 0, totalApiDurationMs: 0, totalDurationMs: 0 },
    behaviors: null,
  };
}

it.each(["quota", "rate_limit"] as const)(
  "%s benches until the provider reset or the named fallback",
  (kind) => {
    for (const stated of [false, true]) {
      const f = fixture();
      const until =
        f.now() +
        (stated
          ? 60_000
          : kind === "quota"
            ? QUOTA_BENCH_MS
            : RATE_LIMIT_BENCH_MS);
      f.store.runFailure(
        "acct",
        { kind, ...(stated ? { resetAtMs: until } : {}) },
        "claude-sdk",
      );
      expect(f.store.read("acct", true)).toMatchObject({
        state: "limited",
        until,
      });
      expect(f.store.bench("acct", "opus")?.until).toBe(until);
      expect(f.store.alerts()).toEqual([]);
      expect(f.push).not.toHaveBeenCalled();
    }
  },
);
it("model caps bench only that model, including family versions", () => {
  const f = fixture();
  f.store.runFailure(
    "acct",
    { kind: "quota", limitModel: "Claude Opus 5.5" },
    "claude-sdk",
  );
  expect(f.store.bench("acct", "claude-opus-5-5")?.model).toBe("opus-5-5");
  expect(f.store.bench("acct", "sonnet")).toBeUndefined();
  f.store.runWorking("acct", "claude-sdk", undefined, "sonnet");
  expect(f.store.bench("acct", "claude-opus-5-5")).toBeDefined();
  f.store.runWorking("acct", "claude-sdk", undefined, "claude-opus-5-5");
  expect(f.store.bench("acct", "claude-opus-5-5")).toBeUndefined();
});
it("failure classification carries named caps but not the ordinary run model", () => {
  expect(
    runFailureFacts(
      analyzeProviderError("Opus usage limit reached", {
        provider: "claude-sdk",
        model: "claude-opus-5-5",
      }),
    ),
  ).toMatchObject({ kind: "quota", limitModel: "opus" });
  expect(
    runFailureFacts(
      analyzeProviderError("429 rate limit", {
        provider: "claude-sdk",
        model: "claude-opus-5-5",
      }),
    ).limitModel,
  ).toBeUndefined();
  expect(
    runFailureFacts(
      analyzeProviderError("Mythos usage limit reached", {
        model: "claude-mythos-1",
      }),
    ).limitModel,
  ).toBe("mythos");
});
it("only a cap matching the executing model supplies scope", () => {
  expect(
    runFailureFacts(analyzeProviderError("usage limit for Opus")).limitModel,
  ).toBeUndefined();
  expect(
    runFailureFacts(
      analyzeProviderError("usage limit for Opus", {
        model: "claude-opus-5-5",
      }),
    ).limitModel,
  ).toBe("opus");
  expect(
    runFailureFacts(
      analyzeProviderError("usage limit for Opus", {
        model: "claude-sonnet-5-5",
      }),
    ).limitModel,
  ).toBeUndefined();
  expect(
    runFailureFacts(
      analyzeProviderError("model-specific usage limit", {
        model: "claude-mythos-1",
      }),
    ).limitModel,
  ).toBe("mythos-1");
  expect(
    runFailureFacts(analyzeProviderError("model-specific usage limit"))
      .limitModel,
  ).toBeUndefined();
  expect(
    runFailureFacts(
      analyzeProviderError("quota exceeded; Opus can be used despite limit"),
    ).limitModel,
  ).toBeUndefined();
});

it.each([
  "Session usage limit reached",
  "Claude AI usage limit reached|1760000000",
  "Request rate limit exceeded",
  "API Error: Request rate limit reached",
  "Anthropic API rate limit hit",
  "usage limit for requests",
  "Rate limit reached for 5 minutes",
  "Usage limit reached for 5 hours",
])(
  "generic error benches the whole account and excludes its executing model: %s",
  (message) => {
    const f = fixture();
    // Keep the exact pipe-form provider reset in the future.
    f.advance(Date.UTC(2025, 0, 1) - f.now());
    const modelId = "claude-opus-5-5";
    const failure = runFailureFacts(
      analyzeProviderError(message, { provider: "claude-sdk", model: modelId }),
    );
    expect(failure.limitModel).toBeUndefined();
    f.store.runFailure("acct", failure, "claude-sdk");
    const bench = f.store.bench("acct", modelId)!;
    expect(bench).toBeDefined();
    expect(bench.model).toBeUndefined();
    expect(f.store.bench("acct", "claude-sonnet-5-5")).toBeDefined();
    expect(
      rankAccountCandidates(
        [
          {
            profile: {
              id: "acct",
              provider: "claude",
              enabled: true,
              enterprise: false,
              health: f.store.read("acct", true),
            },
            offersModel: true,
            usage: null,
            limited: { until: bench.until },
          },
          {
            profile: {
              id: "available",
              provider: "claude",
              enabled: true,
              enterprise: false,
              health: { state: "ok", since: f.now() },
            },
            offersModel: true,
            usage: null,
          },
        ],
        { model: { provider: "claude-sdk", modelId }, thinkingLevel: "low" },
        { fiveHourUsedThreshold: 90, weeklyUsedThreshold: 95 },
        f.now(),
        "claude-default",
      ).profileId,
    ).toBe("available");
  },
);

it.each([
  undefined,
  "Model limit",
  "Weekly limit",
  "Requests per minute",
  "5 hours",
  "100",
  "Usage",
  "API request limit",
  "Account quota",
  "All models",
])(
  "OpenAI mapper counter label %s benches the whole account and excludes A for B",
  (label) => {
    const f = fixture("openai-codex");
    const until = f.now() + 3600_000;
    const usage = mapOpenAiUsageResponse(
      {
        rate_limit: {
          primary_window: {
            used_percent: 20,
            limit_window_seconds: 18000,
            reset_at: until / 1000,
          },
          additional_rate_limits: [
            {
              ...(label === undefined ? {} : { name: label }),
              used_percent: 100,
              limit_window_seconds: 18000,
              reset_at: until / 1000,
            },
          ],
        },
      },
      f.now(),
    );
    expect(usage.windows[1]?.label).toBe(label ?? "Model limit");
    f.store.usageSnapshot("acct", usage);
    const modelId = "gpt-6-sol";
    expect(f.store.bench("acct", modelId)).toMatchObject({
      until,
      source: "usage",
    });
    expect(f.store.bench("acct", modelId)?.model).toBeUndefined();
    expect(f.store.bench("acct", "gpt-5-3-codex-spark")).toBeDefined();
    expect(
      rankAccountCandidates(
        [
          {
            profile: {
              id: "acct",
              provider: "openai-codex",
              enabled: true,
              enterprise: false,
              health: f.store.read("acct", true),
            },
            offersModel: true,
            usage: null,
            limited: { until },
          },
          {
            profile: {
              id: "available",
              provider: "openai-codex",
              enabled: true,
              enterprise: false,
              health: { state: "ok", since: f.now() },
            },
            offersModel: true,
            usage: null,
          },
        ],
        { model: { provider: "openai-codex", modelId }, thinkingLevel: "low" },
        { fiveHourUsedThreshold: 90, weeklyUsedThreshold: 95 },
        f.now(),
        "default",
      ).profileId,
    ).toBe("available");
  },
);
it.each(["Codex Spark", "Codex Spark weekly limit"])(
  "OpenAI mapper named cap %s remains model-specific",
  (name) => {
    const f = fixture("openai-codex");
    const until = f.now() + 3600_000;
    f.store.usageSnapshot(
      "acct",
      mapOpenAiUsageResponse(
        {
          rate_limit: {
            additional_rate_limits: [
              {
                name,
                used_percent: 100,
                limit_window_seconds: 18000,
                reset_at: until / 1000,
              },
            ],
          },
        },
        f.now(),
      ),
    );
    expect(f.store.bench("acct", "gpt-5-3-codex-spark")).toMatchObject({
      model: "spark",
      until,
    });
    expect(f.store.bench("acct", "gpt-6-sol")).toBeUndefined();
  },
);

it("own subscription provider and existing account attribution are required", () => {
  const f = fixture("openai-codex");
  for (const provider of ["github-copilot", "claude-sdk", undefined])
    f.store.runFailure("acct", { kind: "quota" }, provider);
  f.store.runFailure("missing", { kind: "rate_limit" }, "openai-codex");
  expect(f.store.bench("acct", "codex")).toBeUndefined();
  f.store.runFailure("acct", { kind: "quota" }, "openai-codex");
  f.store.runWorking("acct", "github-copilot", undefined, "codex");
  expect(f.store.bench("acct", "codex")).toBeDefined();
});
it("whole-account success clears a bench early, but late success cannot clear newer evidence", () => {
  const f = fixture();
  const old = f.store.observe("acct");
  f.store.runFailure(
    "acct",
    { kind: "quota" },
    "claude-sdk",
    f.store.observe("acct"),
  );
  f.store.runWorking("acct", "claude-sdk", old, "opus");
  expect(f.store.bench("acct", "opus")).toBeDefined();
  f.store.runWorking("acct", "claude-sdk", f.store.observe("acct"), "opus");
  expect(f.store.bench("acct", "opus")).toBeUndefined();
  f.store.runFailure("acct", { kind: "quota" }, "claude-sdk", old);
  expect(f.store.bench("acct", "opus")).toBeDefined();
});
it.each([false, true])(
  "a concurrent success started before the quota report cannot clear it, success-first=%s",
  (successFirst) => {
    const f = fixture();
    const a = f.store.observe("acct");
    const b = f.store.observe("acct");
    if (successFirst) f.store.runWorking("acct", "claude-sdk", b, "opus");
    f.store.runFailure("acct", { kind: "quota" }, "claude-sdk", a);
    if (!successFirst) f.store.runWorking("acct", "claude-sdk", b, "opus");
    expect(f.store.bench("acct", "opus")).toBeDefined();
    f.store.runWorking("acct", "claude-sdk", f.store.observe("acct"), "opus");
    expect(f.store.bench("acct", "opus")).toBeUndefined();
  },
);

it("old credential generations cannot bench or clear", () => {
  const f = fixture();
  const old = f.store.observe("acct");
  f.store.loginCompleted("acct");
  f.store.runFailure("acct", { kind: "quota" }, "claude-sdk", old);
  expect(f.store.bench("acct", "opus")).toBeUndefined();
  f.store.runFailure("acct", { kind: "quota" }, "claude-sdk");
  f.store.runWorking("acct", "claude-sdk", old, "opus");
  expect(f.store.bench("acct", "opus")).toBeDefined();
});
it("later usage room clears only its scope; old snapshots and missing room do not", () => {
  const f = fixture();
  const old = f.store.observe("acct");
  f.store.usageSnapshot(
    "acct",
    snapshot(f.now(), 100, "Opus"),
    f.store.observe("acct"),
  );
  f.store.usageSnapshot("acct", snapshot(f.now(), 20, "Opus"), old);
  expect(f.store.bench("acct", "opus")).toBeDefined();
  f.store.usageSnapshot("acct", snapshot(f.now(), 20));
  expect(f.store.bench("acct", "opus")).toBeDefined();
  f.store.usageSnapshot("acct", snapshot(f.now(), 20, "Opus"));
  expect(f.store.bench("acct", "opus")).toBeUndefined();
  f.store.usageSnapshot("acct", snapshot(f.now(), 100, "Opus"), old);
  expect(f.store.bench("acct", "opus")).toBeUndefined();
});
it("shorter scope changes invalidate health while its longest bench is unchanged", () => {
  const f = fixture();
  const until = f.now() + 3600_000;
  f.store.runFailure(
    "acct",
    { kind: "quota", limitModel: "Opus", resetAtMs: until },
    "claude-sdk",
  );
  const primary = f.store.read("acct", true);
  const changed = vi.fn();
  f.store.subscribeHealth(changed);
  f.store.runFailure(
    "acct",
    { kind: "rate_limit", limitModel: "Sonnet" },
    "claude-sdk",
  );
  expect(f.store.read("acct", true)).toMatchObject({ until, model: "opus" });
  expect(f.store.read("acct", true).benchRevision).toBeGreaterThan(
    primary.benchRevision!,
  );
  const limitedRevision = f.store.read("acct", true).benchRevision!;
  f.store.runWorking("acct", "claude-sdk", undefined, "claude-sonnet-5-5");
  expect(f.store.read("acct", true)).toMatchObject({ until, model: "opus" });
  expect(f.store.read("acct", true).benchRevision).toBeGreaterThan(
    limitedRevision,
  );
  expect(changed).toHaveBeenCalledTimes(2);
});
it("one unref'd earliest-expiry timer publishes each expiry without a read", () => {
  vi.useFakeTimers();
  const f = fixture();
  const changed = vi.fn();
  f.store.subscribeHealth(changed);
  f.store.runFailure(
    "acct",
    { kind: "quota", resetAtMs: f.now() + 1000 },
    "claude-sdk",
  );
  f.store.runFailure(
    "acct",
    { kind: "quota", limitModel: "Opus", resetAtMs: f.now() + 2000 },
    "claude-sdk",
  );
  expect(vi.getTimerCount()).toBe(1);
  changed.mockClear();
  f.advance(1000);
  vi.advanceTimersByTime(1000);
  expect(changed).toHaveBeenCalledTimes(1);
  expect(f.store.read("acct", true)).toMatchObject({
    state: "limited",
    model: "opus",
  });
  expect(vi.getTimerCount()).toBe(1);
  changed.mockClear();
  f.advance(1000);
  vi.advanceTimersByTime(1000);
  expect(changed).toHaveBeenCalledTimes(1);
  expect(f.store.read("acct", true).state).not.toBe("limited");
  expect(vi.getTimerCount()).toBe(0);
});
it("a whole-account bench takes card precedence over a longer model bench", () => {
  const f = fixture();
  f.store.runFailure(
    "acct",
    { kind: "quota", limitModel: "Opus", resetAtMs: f.now() + 3600_000 },
    "claude-sdk",
  );
  const until = f.now() + 60_000;
  f.store.runFailure(
    "acct",
    { kind: "rate_limit", resetAtMs: until },
    "claude-sdk",
  );
  expect(f.store.read("acct", true)).toMatchObject({ until });
  expect(f.store.read("acct", true).model).toBeUndefined();
  expect(f.store.bench("acct", "opus")?.model).toBe("opus");
});
it("fresh Claude room clears an account bench with either generic window absent", () => {
  const f = fixture();
  for (const absent of ["fiveHour", "weekly"] as const) {
    f.store.usageSnapshot("acct", snapshot(f.now(), 100));
    const room: Partial<ClaudeUsageSnapshot> &
      Pick<ClaudeUsageSnapshot, "fetchedAt" | "rateLimitsAvailable"> = snapshot(
      f.now(),
      20,
    );
    delete room[absent];
    f.store.usageSnapshot("acct", room);
    expect(f.store.bench("acct", "opus")).toBeUndefined();
  }
});
it.each(["quota", "rate_limit"] as const)(
  "newer usage cannot clear or re-label a %s bench",
  (kind) => {
    const f = fixture();
    f.store.runFailure("acct", { kind }, "claude-sdk");
    const failureUntil = f.store.bench("acct", "claude-opus-5-5")!.until;
    f.advance(60_000);
    for (const pct of [20, 98, 99, 100, 20]) {
      f.store.usageSnapshot("acct", snapshot(f.now(), pct));
      expect(f.store.bench("acct", "claude-opus-5-5")).toMatchObject({
        source: kind,
        until: failureUntil,
      });
    }
    expect(JSON.parse(readFileSync(f.path, "utf8")).acct[""].source).toBe(kind);
    const restarted = f.restart();
    restarted.usageSnapshot("acct", snapshot(f.now(), 20));
    expect(restarted.bench("acct", "claude-opus-5-5")).toMatchObject({
      source: kind,
      until: failureUntil,
    });
    expect(restarted.read("acct", true)).not.toHaveProperty("source");
    restarted.runWorking("acct", "claude-sdk", undefined, "claude-opus-5-5");
    expect(restarted.bench("acct", "claude-opus-5-5")).toBeUndefined();
  },
);
it("an exhausted Claude model window without a display name benches the whole account", () => {
  const f = fixture();
  const resetsAt = new Date(f.now() + 3600_000).toISOString();
  const mapped = mapClaudeUsageResponse({
    rate_limits_available: true,
    rate_limits: {
      five_hour: { utilization: 20, resets_at: resetsAt },
      seven_day: { utilization: 20, resets_at: resetsAt },
      model_scoped: [{ utilization: 100, resets_at: resetsAt }],
    },
  });
  expect(mapped.modelScoped).toEqual([
    { modelDisplayName: null, utilizationPct: 100, resetsAt },
  ]);
  f.store.usageSnapshot("acct", { ...mapped, fetchedAt: f.now() });
  for (const model of ["claude-opus-5-5", "claude-sonnet-5-5"])
    expect(f.store.bench("acct", model)).toMatchObject({ source: "usage" });
});
it("a failure upgrades usage provenance even when its reset is identical", () => {
  const f = fixture();
  f.store.usageSnapshot("acct", snapshot(f.now(), 100));
  const until = f.store.bench("acct", "claude-opus-5-5")!.until;
  expect(f.store.bench("acct", "claude-opus-5-5")?.source).toBe("usage");
  f.store.runFailure("acct", { kind: "quota", resetAtMs: until }, "claude-sdk");
  f.store.usageSnapshot("acct", snapshot(f.now(), 99));
  expect(f.store.bench("acct", "claude-opus-5-5")?.source).toBe("quota");
});

it("persistence contains live benches only, with no cleared scope records", () => {
  const f = fixture();
  f.store.runWorking("acct", "claude-sdk", undefined, "sonnet");
  f.store.runFailure(
    "acct",
    { kind: "quota", limitModel: "Opus" },
    "claude-sdk",
  );
  expect(Object.keys(JSON.parse(readFileSync(f.path, "utf8")).acct)).toEqual([
    "opus",
  ]);
  f.store.runWorking("acct", "claude-sdk", undefined, "claude-opus-5-5");
  expect(JSON.parse(readFileSync(f.path, "utf8"))).toEqual({});
  expect(f.restart().bench("acct", "opus")).toBeUndefined();
});

it("OpenAI named windows bench only their model", () => {
  const f = fixture("openai-codex");
  f.store.usageSnapshot("acct", {
    fetchedAt: f.now(),
    available: true,
    windows: [
      {
        label: "Codex Spark",
        kind: "weekly",
        usedPercent: 100,
        resetsAt: new Date(f.now() + 60_000).toISOString(),
      },
    ],
    spendControl: null,
  } as OpenAiUsageSnapshot);
  expect(f.store.bench("acct", "gpt-5-3-codex-spark")).toBeDefined();
  expect(f.store.bench("acct", "gpt-6-sol")).toBeUndefined();
});

/** A live `/wham/usage` body: a Business seat whose extra-credit budget is zero. */
function wham(now: number, weeklyUsed: number, weeklyResetMs: number) {
  return mapOpenAiUsageResponse(
    {
      plan_type: "self_serve_business_prolite",
      rate_limit: {
        allowed: weeklyUsed < 100,
        limit_reached: weeklyUsed >= 100,
        primary_window: {
          used_percent: weeklyUsed,
          limit_window_seconds: 604800,
          reset_at: weeklyResetMs / 1000,
        },
        secondary_window: null,
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
          source: "workspace_spend_controls",
          unit: "credit",
          limit: "0",
          used: "0.0",
          remaining: "0.0",
          used_percent: 100,
          reset_at: (now + 30 * 86_400_000) / 1000,
        },
      },
    },
    now,
  );
}

it("a reached extra-credit spend control does not bench included weekly room", () => {
  const f = fixture("openai-codex");
  const usage = wham(f.now(), 1, f.now() + 6 * 86_400_000);
  expect(usage.spendControl).toMatchObject({ reached: true, usedPercent: 100 });
  f.store.usageSnapshot("acct", usage);
  expect(f.store.bench("acct", "gpt-6-sol")).toBeUndefined();
  expect(f.store.read("acct", true).state).toBe("ok");
  expect(
    rankAccountCandidates(
      [
        {
          profile: {
            id: "acct",
            provider: "openai-codex",
            enabled: true,
            enterprise: false,
            health: f.store.read("acct", true),
          },
          offersModel: true,
          usage: null,
        },
        {
          profile: {
            id: "exhausted",
            provider: "openai-codex",
            enabled: true,
            enterprise: false,
            health: { state: "ok", since: f.now() },
          },
          offersModel: true,
          usage: null,
          limited: { until: f.now() + 86_400_000 },
        },
      ],
      { model: { provider: "openai-codex", modelId: "gpt-6-sol" } },
      { fiveHourUsedThreshold: 90, weeklyUsedThreshold: 95 },
      f.now(),
      "openai-default",
    ),
  ).toEqual({ profileId: "acct" });
});

it("an exhausted included window still benches until its own reset, whatever the spend control says", () => {
  const f = fixture("openai-codex");
  const weeklyReset = f.now() + 86_400_000;
  f.store.usageSnapshot("acct", wham(f.now(), 100, weeklyReset));
  expect(f.store.bench("acct", "gpt-6-sol")).toMatchObject({
    until: weeklyReset,
    source: "usage",
  });
  f.store.usageSnapshot("acct", {
    ...wham(f.now(), 100, weeklyReset),
    spendControl: null,
  });
  expect(f.store.bench("acct", "gpt-6-sol")?.until).toBe(weeklyReset);
});

it("fresh weekly room clears a persisted usage bench a spend control created", () => {
  const f = fixture("openai-codex");
  const spendReset = f.now() + 30 * 86_400_000;
  writeFileSync(
    f.path,
    JSON.stringify({
      acct: { "": { since: f.now(), until: spendReset, source: "usage" } },
    }),
  );
  const restarted = f.restart();
  expect(restarted.bench("acct", "gpt-6-sol")?.until).toBe(spendReset);
  restarted.usageSnapshot("acct", wham(f.now(), 1, f.now() + 86_400_000));
  expect(restarted.bench("acct", "gpt-6-sol")).toBeUndefined();
  expect(JSON.parse(readFileSync(f.path, "utf8"))).toEqual({});
});

it.each(["quota", "rate_limit"] as const)(
  "weekly room beside a reached spend control cannot clear a %s bench",
  (kind) => {
    const f = fixture("openai-codex");
    f.store.runFailure("acct", { kind }, "openai-codex");
    const until = f.store.bench("acct", "gpt-6-sol")!.until;
    f.store.usageSnapshot("acct", wham(f.now(), 1, f.now() + 86_400_000));
    expect(f.store.bench("acct", "gpt-6-sol")).toMatchObject({
      source: kind,
      until,
    });
    const restarted = f.restart();
    restarted.usageSnapshot("acct", wham(f.now(), 1, f.now() + 86_400_000));
    expect(restarted.bench("acct", "gpt-6-sol")).toMatchObject({
      source: kind,
      until,
    });
  },
);
it("unchanged evidence does not rewrite and expiry survives restart", () => {
  const f = fixture();
  const until = f.now() + 1000;
  f.store.runFailure(
    "acct",
    { kind: "rate_limit", resetAtMs: until },
    "claude-sdk",
  );
  const before = statSync(f.path).mtimeMs;
  f.advance(1);
  f.store.runFailure(
    "acct",
    { kind: "rate_limit", resetAtMs: until },
    "claude-sdk",
  );
  expect(statSync(f.path).mtimeMs).toBe(before);
  expect(f.restart().bench("acct", "opus")?.until).toBe(until);
  expect(readFileSync(f.path, "utf8")).not.toContain("order");
  f.advance(999);
  expect(f.store.bench("acct", "opus")).toBeUndefined();
  expect(f.restart().bench("acct", "opus")).toBeUndefined();
});
it("past resets and non-limit failures do not bench", () => {
  const f = fixture();
  for (const kind of [
    "auth",
    "server",
    "network",
    "aborted",
    "timeout",
  ] as const)
    f.store.runFailure("acct", { kind }, "claude-sdk");
  f.store.runFailure(
    "acct",
    { kind: "quota", resetAtMs: f.now() - 1 },
    "claude-sdk",
  );
  expect(f.store.bench("acct", "opus")).toBeUndefined();
});
it("bench persistence failure preserves in-memory limits", () => {
  const f = fixture();
  const store = new AccountBenchStore(
    join(f.path.replace("-benches", ""), "not-a-directory", "bench.json"),
    f.now,
  );
  store.failure("acct", { kind: "quota" }, 1);
  expect(store.read("acct", "opus")?.until).toBe(f.now() + QUOTA_BENCH_MS);
});

it("deleted accounts cannot be resurrected by late evidence", () => {
  const f = fixture();
  f.store.runFailure("acct", { kind: "quota" }, "claude-sdk");
  f.remove();
  f.store.forget("acct");
  f.store.runFailure("acct", { kind: "quota" }, "claude-sdk");
  expect(f.store.bench("acct", "opus")).toBeUndefined();
});
