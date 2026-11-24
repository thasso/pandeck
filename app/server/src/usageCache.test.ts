import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  ClaudeUsageSnapshot,
  OpenAiUsageSnapshot,
} from "@assistant/shared/usage";
import type {
  CredentialProfileSummary,
  ServerMessage,
} from "@assistant/shared";

// The cache resolves DATA_DIR at import time; isolate it before loading so no
// test ever writes into the real data directory.
const tmp = mkdtempSync(join(tmpdir(), "usage-cache-test-"));
process.env.DATA_DIR = join(tmp, "data");

const {
  TURN_END_DEBOUNCE_MS,
  forgetUsageProfile,
  markUsageProfileDirty,
  peekUsageSnapshot,
  readUsageSnapshot,
  resetUsageCacheForTests,
  revalidateUsage,
  setUsageBroadcaster,
  setUsageCacheDepsForTests,
  usageIndicators,
  cachedUsageIndicator,
} = await import("./usageCache.ts");
const { mapClaudeUsageResponse } = await import("./claudeSdk/usageQuery.ts");
const { mapOpenAiUsageResponse } = await import("./piSdk/openaiUsageQuery.ts");
const { rankAccountCandidates } = await import("./accountRouter.ts");
const { usageProfileForSession } = await import("./harnesses/usage.ts");

const CACHE_DIR = join(process.env.DATA_DIR, "cache", "usage");

describe("run usage attribution", () => {
  test.each(["claude-sdk", "pi"] as const)(
    "without protected defaults, an unbound %s session dirties no account",
    (harness) => {
      expect(usageProfileForSession({ harness })).toBeNull();
      expect(
        usageProfileForSession({ harness, credentialProfileId: "bound-work" }),
      ).toBe("bound-work");
    },
  );
  test.each([
    ["claude-sdk", "claude-default"],
    ["pi", "default"],
  ] as const)(
    "legacy %s sessions dirty their protected default",
    async (harness, expected) => {
      await (
        await import("./test/legacyDefaultAccounts.ts")
      ).seedLegacyDefaultAccounts();
      expect(usageProfileForSession({ harness })).toBe(expected);
      expect(
        usageProfileForSession({ harness, credentialProfileId: "bound-work" }),
      ).toBe("bound-work");
    },
  );
  test("missing session metadata does not guess an account", () => {
    expect(usageProfileForSession(undefined)).toBeNull();
  });
  test("a run's recorded engine names the account it ran on, over the session's current one", () => {
    const moved = { harness: "pi" as const, credentialProfileId: "after-move" };
    expect(
      usageProfileForSession(moved, {
        harness: "pi",
        credentialProfileId: "ran-on",
      }),
    ).toBe("ran-on");
    // An older run marker without a stamp falls back to the session's binding.
    expect(usageProfileForSession(moved, undefined)).toBe("after-move");
    expect(
      usageProfileForSession(undefined, {
        harness: "claude-sdk",
        credentialProfileId: "ran-on",
      }),
    ).toBe("ran-on");
  });
});

function profile(
  id: string,
  provider: CredentialProfileSummary["provider"],
  enabled = true,
): CredentialProfileSummary {
  return {
    id,
    name: id,
    provider,
    enabled,
    enterprise: false,
    createdAt: 0,
    updatedAt: 0,
    status: "ready",
    health: { state: "unknown", since: null },
  };
}

function claudeSnapshot(
  overrides: Partial<ClaudeUsageSnapshot> = {},
): ClaudeUsageSnapshot {
  return {
    fetchedAt: 0,
    subscriptionType: "max",
    rateLimitsAvailable: true,
    fiveHour: { utilizationPct: 40, resetsAt: null },
    weekly: { utilizationPct: 62, resetsAt: null },
    limits: [],
    modelScoped: [],
    extraUsage: null,
    session: { totalCostUsd: 0, totalApiDurationMs: 0, totalDurationMs: 0 },
    ...overrides,
  };
}

function openAiSnapshot(
  overrides: Partial<OpenAiUsageSnapshot> = {},
): OpenAiUsageSnapshot {
  return {
    fetchedAt: 0,
    available: true,
    unavailableReason: null,
    planType: "plus",
    email: "someone@example.com",
    limitReached: false,
    windows: [
      {
        kind: "five_hour",
        label: null,
        usedPercent: 12,
        windowSeconds: 18000,
        resetsAt: null,
      },
      {
        kind: "weekly",
        label: null,
        usedPercent: 55,
        windowSeconds: 604800,
        resetsAt: null,
      },
    ],
    credits: null,
    spendControl: null,
    resetCredits: null,
    ...overrides,
  };
}

/** Let queued microtasks (a background fetch settling) run to completion. */
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/** A fetch whose resolution the test controls, so overlap is observable. */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

interface Harness {
  claudeCalls: string[];
  openAiCalls: string[];
  broadcasts: ServerMessage[];
}

let clock = 1_000_000;
let harness: Harness;
let claudeResult: () => Promise<ClaudeUsageSnapshot>;
let openAiResult: () => Promise<OpenAiUsageSnapshot>;

function install(
  profiles: CredentialProfileSummary[],
  hasClients = true,
): void {
  resetUsageCacheForTests();
  harness = { claudeCalls: [], openAiCalls: [], broadcasts: [] };
  setUsageCacheDepsForTests({
    listProfiles: () => profiles,
    now: () => clock,
    fetchClaude: (profileId) => {
      harness.claudeCalls.push(profileId);
      return claudeResult();
    },
    fetchOpenAi: (profileId) => {
      harness.openAiCalls.push(profileId);
      return openAiResult();
    },
  });
  setUsageBroadcaster({
    broadcast: (message) => harness.broadcasts.push(message),
    hasClients: () => hasClients,
  });
}

beforeEach(() => {
  rmSync(CACHE_DIR, { recursive: true, force: true });
  clock = 1_000_000;
  claudeResult = () => Promise.resolve(claudeSnapshot());
  openAiResult = () => Promise.resolve(openAiSnapshot());
});

test("an enabled endpoint in the registry causes no usage fetch, timer or indicator", async () => {
  const endpoint = profile(
    "openai-compatible-0123456789ab",
    "openai-compatible",
  );
  install([profile("default", "openai-codex"), endpoint]);
  revalidateUsage();
  await flush();
  expect(harness.openAiCalls).toEqual(["default"]);
  expect(harness.claudeCalls).toEqual([]);
  expect(usageIndicators().map((indicator) => indicator.profileId)).toEqual([
    "default",
  ]);
  markUsageProfileDirty(endpoint.id);
  revalidateUsage({ force: true });
  await flush();
  expect(harness.openAiCalls.every((id) => id === "default")).toBe(true);
  expect(
    usageIndicators().some((indicator) => indicator.profileId === endpoint.id),
  ).toBe(false);
  expect(
    harness.broadcasts.some((message) =>
      JSON.stringify(message).includes(endpoint.id),
    ),
  ).toBe(false);
});

describe("readUsageSnapshot", () => {
  test("serves the cache while fresh and revalidates in the background once it is not", async () => {
    install([profile("claude-default", "claude")]);
    await readUsageSnapshot("claude-default", "claude");
    expect(harness.claudeCalls).toEqual(["claude-default"]);

    // Inside the fresh window: no second subprocess, cached numbers served.
    clock += 60_000;
    await readUsageSnapshot("claude-default", "claude");
    expect(harness.claudeCalls).toHaveLength(1);

    // Past it: the read still answers immediately, and a refresh runs behind it.
    clock += 5 * 60_000;
    await readUsageSnapshot("claude-default", "claude");
    await flush();
    expect(harness.claudeCalls).toHaveLength(2);
  });

  test("single-flights concurrent reads into one provider fetch", async () => {
    install([profile("claude-default", "claude")]);
    const gate = deferred<ClaudeUsageSnapshot>();
    claudeResult = () => gate.promise;
    const first = readUsageSnapshot("claude-default", "claude");
    const second = readUsageSnapshot("claude-default", "claude");
    gate.resolve(claudeSnapshot());
    await Promise.all([first, second]);
    expect(harness.claudeCalls).toEqual(["claude-default"]);
  });

  test("runs at most one Claude subprocess at a time across accounts", async () => {
    install([profile("a", "claude"), profile("b", "claude")]);
    const gate = deferred<ClaudeUsageSnapshot>();
    claudeResult = () => gate.promise;
    const both = Promise.all([
      readUsageSnapshot("a", "claude"),
      readUsageSnapshot("b", "claude"),
    ]);
    await Promise.resolve();
    expect(harness.claudeCalls).toEqual(["a"]);
    gate.resolve(claudeSnapshot());
    await both;
    expect(harness.claudeCalls).toEqual(["a", "b"]);
  });

  test("keeps the last good snapshot when a refresh fails, and backs off", async () => {
    install([profile("openai", "openai-codex")]);
    await readUsageSnapshot("openai", "openai-codex");
    openAiResult = () => Promise.reject(new Error("token expired"));

    clock += 3 * 60_000;
    const served = await readUsageSnapshot("openai", "openai-codex");
    await flush();
    expect(served).toMatchObject({ available: true });
    expect(harness.openAiCalls).toHaveLength(2);

    // Backoff: the next revalidation window is skipped entirely.
    clock += 30_000;
    revalidateUsage();
    await flush();
    expect(harness.openAiCalls).toHaveLength(2);
    // Past the first backoff step (1 min) it tries again.
    clock += 40_000;
    revalidateUsage();
    await flush();
    expect(harness.openAiCalls).toHaveLength(3);
  });

  test("surfaces the error only when there is nothing cached to serve", async () => {
    install([profile("openai", "openai-codex")]);
    openAiResult = () => Promise.reject(new Error("not signed in"));
    await expect(readUsageSnapshot("openai", "openai-codex")).rejects.toThrow(
      "not signed in",
    );
  });

  test("a FORCED read reports its failure rather than re-serving the old numbers", async () => {
    // The user pressed Refresh: answering with the numbers already on screen
    // would make the button look like it did nothing.
    install([profile("openai", "openai-codex")]);
    await readUsageSnapshot("openai", "openai-codex");
    openAiResult = () => Promise.reject(new Error("token expired"));
    await expect(
      readUsageSnapshot("openai", "openai-codex", { force: true }),
    ).rejects.toThrow("token expired");
    // ...and the last good snapshot is still cached for everyone else.
    expect(usageIndicators()[0]?.short?.usedPct).toBe(12);
  });

  test("a forced fetch ignores freshness, the min interval and the backoff", async () => {
    install([profile("openai", "openai-codex")]);
    await readUsageSnapshot("openai", "openai-codex");
    // Inside both the fresh window and the min interval.
    clock += 5_000;
    await readUsageSnapshot("openai", "openai-codex", { force: true });
    expect(harness.openAiCalls).toHaveLength(2);

    openAiResult = () => Promise.reject(new Error("nope"));
    await expect(
      readUsageSnapshot("openai", "openai-codex", { force: true }),
    ).rejects.toThrow();
    openAiResult = () => Promise.resolve(openAiSnapshot());
    // Deep inside the failure backoff, a forced read still runs.
    clock += 1_000;
    await readUsageSnapshot("openai", "openai-codex", { force: true });
    expect(harness.openAiCalls).toHaveLength(4);
  });
});

describe("persistence", () => {
  test("survives a restart instead of blanking every card", async () => {
    install([profile("openai", "openai-codex")]);
    await readUsageSnapshot("openai", "openai-codex");
    expect(existsSync(join(CACHE_DIR, "openai.json"))).toBe(true);

    // A restart: memory is empty, the file is not.
    install([profile("openai", "openai-codex")]);
    const [indicator] = usageIndicators();
    expect(indicator?.short?.usedPct).toBe(12);
    expect(harness.openAiCalls).toEqual([]);
  });

  test.each([
    "{ not json",
    JSON.stringify({ version: 2, snapshot: openAiSnapshot() }),
    JSON.stringify({
      version: 1,
      provider: "claude",
      snapshot: claudeSnapshot(),
      fetchedAt: 1,
    }),
  ])(
    "ignores corrupt, obsolete or wrong-provider snapshots: %s",
    (contents) => {
      mkdirSync(CACHE_DIR, { recursive: true });
      writeFileSync(join(CACHE_DIR, "openai.json"), contents);
      install([profile("openai", "openai-codex")]);
      expect(usageIndicators()[0]?.fetchedAt).toBeNull();
    },
  );

  test("a failed disk write still serves the fetched snapshot", async () => {
    install([profile("openai", "openai-codex")]);
    mkdirSync(join(CACHE_DIR, "openai.json.tmp"), { recursive: true });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const snapshot = await readUsageSnapshot("openai", "openai-codex");
      expect(snapshot).toEqual(openAiSnapshot());
      expect(usageIndicators()[0]?.short?.usedPct).toBe(12);
      expect(warn).toHaveBeenCalledWith(
        "[usage-cache] failed to persist snapshot:",
        expect.any(String),
      );
    } finally {
      warn.mockRestore();
    }
  });

  test("forgetting an account removes its numbers and its file", async () => {
    install([profile("openai", "openai-codex")]);
    await readUsageSnapshot("openai", "openai-codex");
    forgetUsageProfile("openai");
    expect(existsSync(join(CACHE_DIR, "openai.json"))).toBe(false);
    expect(usageIndicators()[0]?.fetchedAt).toBeNull();
  });

  test.each([
    ["claude", "claude"],
    ["openai", "openai-codex"],
  ] as const)(
    "a %s read that finishes after its account was deleted writes nothing back",
    async (id, provider) => {
      install([profile(id, provider)]);
      const claude = deferred<ClaudeUsageSnapshot>();
      const openAi = deferred<OpenAiUsageSnapshot>();
      claudeResult = () => claude.promise;
      openAiResult = () => openAi.promise;
      const read = readUsageSnapshot(id, provider, { force: true });
      await flush();
      forgetUsageProfile(id);
      if (provider === "claude") claude.resolve(claudeSnapshot());
      else openAi.resolve(openAiSnapshot());
      await read;
      expect(existsSync(join(CACHE_DIR, `${id}.json`))).toBe(false);
      expect(peekUsageSnapshot(id, provider)).toBeNull();
    },
  );
});

describe("triggers", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  test("a finished turn refreshes the account once, after the debounce", async () => {
    vi.useFakeTimers();
    install([profile("claude-default", "claude")]);
    await readUsageSnapshot("claude-default", "claude");
    clock += 61_000;

    // A burst of finished runs on one account costs ONE fetch.
    markUsageProfileDirty("claude-default");
    markUsageProfileDirty("claude-default");
    markUsageProfileDirty("claude-default");
    expect(harness.claudeCalls).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(TURN_END_DEBOUNCE_MS - 1);
    expect(harness.claudeCalls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(2);
    expect(harness.claudeCalls).toHaveLength(2);
  });

  test("the turn-end refresh still respects the min interval", async () => {
    vi.useFakeTimers();
    install([profile("claude-default", "claude")]);
    await readUsageSnapshot("claude-default", "claude");
    // Only 10 s after the fetch: inside the 60 s min interval.
    clock += 10_000;
    markUsageProfileDirty("claude-default");
    await vi.advanceTimersByTimeAsync(TURN_END_DEBOUNCE_MS + 1);
    expect(harness.claudeCalls).toHaveLength(1);

    // The account stays dirty, so it refreshes as soon as it is allowed to.
    clock += 60_000;
    revalidateUsage();
    await vi.advanceTimersByTimeAsync(1);
    expect(harness.claudeCalls).toHaveLength(2);
  });

  test("a failed refresh keeps the account dirty", async () => {
    install([profile("openai", "openai-codex")]);
    await readUsageSnapshot("openai", "openai-codex");
    clock += 30_000;
    markUsageProfileDirty("openai");
    openAiResult = () => Promise.reject(new Error("nope"));
    revalidateUsage();
    await flush();
    expect(harness.openAiCalls).toHaveLength(2);

    // The failed attempt learned nothing about the turn that moved these
    // numbers, so once the backoff expires the account is refreshed even
    // though it would otherwise still count as fresh.
    openAiResult = () => Promise.resolve(openAiSnapshot());
    clock += 61_000;
    revalidateUsage();
    await flush();
    expect(harness.openAiCalls).toHaveLength(3);
  });

  test("a finished turn fetches nothing while no client is attached", async () => {
    install([profile("claude-default", "claude")], false);
    await readUsageSnapshot("claude-default", "claude");
    clock += 61_000;
    markUsageProfileDirty("claude-default");
    expect(harness.claudeCalls).toHaveLength(1);

    // The account stays dirty, so the next page open refreshes it even though
    // the snapshot is still inside the fresh window.
    revalidateUsage();
    await flush();
    expect(harness.claudeCalls).toHaveLength(2);
  });
});

describe("usageIndicators", () => {
  test("projects both providers into the two generic cycle slots", async () => {
    install([
      profile("claude-default", "claude"),
      profile("openai", "openai-codex"),
    ]);
    await readUsageSnapshot("claude-default", "claude");
    await readUsageSnapshot("openai", "openai-codex");
    const [claude, openai] = usageIndicators();
    expect(claude).toMatchObject({
      provider: "claude",
      limitsAvailable: true,
      short: { usedPct: 40 },
      long: { usedPct: 62 },
    });
    expect(openai).toMatchObject({
      provider: "openai-codex",
      limitsAvailable: true,
      short: { usedPct: 12 },
      long: { usedPct: 55 },
    });
  });

  test("reports accounts with no plan limits, and never leaks account detail", async () => {
    install([
      profile("claude-default", "claude"),
      profile("openai", "openai-codex"),
    ]);
    claudeResult = () =>
      Promise.resolve(claudeSnapshot({ rateLimitsAvailable: false }));
    openAiResult = () =>
      Promise.resolve(
        openAiSnapshot({
          available: false,
          unavailableReason: "Not signed in",
          windows: [],
        }),
      );
    await readUsageSnapshot("claude-default", "claude");
    await readUsageSnapshot("openai", "openai-codex");
    const indicators = usageIndicators();
    expect(indicators.map((item) => item.limitsAvailable)).toEqual([
      false,
      false,
    ]);
    expect(JSON.stringify(indicators)).not.toContain("example.com");
    expect(JSON.stringify(indicators)).not.toContain("Not signed in");
  });

  test("prefers the plain plan windows over named model caps", async () => {
    install([profile("openai", "openai-codex")]);
    openAiResult = () =>
      Promise.resolve(
        openAiSnapshot({
          windows: [
            {
              kind: "five_hour",
              label: "Codex Spark",
              usedPercent: 90,
              windowSeconds: 18000,
              resetsAt: null,
            },
            {
              kind: "five_hour",
              label: null,
              usedPercent: 12,
              windowSeconds: 18000,
              resetsAt: null,
            },
          ],
        }),
      );
    await readUsageSnapshot("openai", "openai-codex");
    const [indicator] = usageIndicators();
    expect(indicator?.short?.usedPct).toBe(12);
    expect(indicator?.long).toBeNull();
  });

  test("covers only enabled accounts", async () => {
    install([
      profile("openai", "openai-codex"),
      profile("disabled", "openai-codex", false),
    ]);
    expect(usageIndicators().map((item) => item.profileId)).toEqual(["openai"]);
  });
});

describe("absent versus unknown windows, mapper to router", () => {
  const hour = 3600_000;
  const iso = (hours: number) => new Date(clock + hours * hour).toISOString();
  const epoch = (hours: number) => Math.floor((clock + hours * hour) / 1000);
  // Fully known room: 46% / 90%, weekly reset in 68h (the "Default Claude" card).
  const knownClaude = () =>
    mapClaudeUsageResponse({
      rate_limits_available: true,
      rate_limits: {
        five_hour: { utilization: 46, resets_at: iso(2) },
        seven_day: { utilization: 90, resets_at: iso(68) },
      },
    });
  const knownOpenAi = () =>
    mapOpenAiUsageResponse(
      {
        rate_limit: {
          primary_window: {
            used_percent: 10,
            limit_window_seconds: 18000,
            reset_at: epoch(2),
          },
          secondary_window: {
            used_percent: 10,
            limit_window_seconds: 604800,
            reset_at: epoch(48),
          },
        },
      },
      clock,
    );

  async function pick(
    provider: "claude" | "openai-codex",
    candidate: () => ClaudeUsageSnapshot | OpenAiUsageSnapshot,
    known: () => ClaudeUsageSnapshot | OpenAiUsageSnapshot,
  ) {
    install([profile("a-candidate", provider), profile("z-known", provider)]);
    const results = { "a-candidate": candidate, "z-known": known };
    const fetch = (id: string) =>
      Promise.resolve(results[id as keyof typeof results]());
    setUsageCacheDepsForTests({
      fetchClaude: fetch as (id: string) => Promise<ClaudeUsageSnapshot>,
      fetchOpenAi: fetch as (id: string) => Promise<OpenAiUsageSnapshot>,
    });
    await readUsageSnapshot("a-candidate", provider);
    await readUsageSnapshot("z-known", provider);
    const candidates = ["a-candidate", "z-known"].map((id) => ({
      profile: {
        id,
        provider,
        enabled: true,
        enterprise: false,
        health: { state: "ok" as const, since: clock },
      },
      offersModel: true,
      usage: cachedUsageIndicator({ id, provider }),
    }));
    return {
      short: candidates[0]!.usage.short,
      long: candidates[0]!.usage.long,
      picked: rankAccountCandidates(
        candidates,
        {
          model: {
            provider: provider === "claude" ? "claude-sdk" : "openai-codex",
            modelId: "m",
          },
        },
        { fiveHourUsedThreshold: 90, weeklyUsedThreshold: 95 },
        clock,
        undefined,
      ).profileId,
    };
  }

  test("a Claude response that states no 5-hour window is room", async () => {
    const result = await pick(
      "claude",
      () =>
        mapClaudeUsageResponse({
          rate_limits_available: true,
          rate_limits: {
            five_hour: null,
            seven_day: { utilization: 3, resets_at: iso(41) },
          },
        }),
      knownClaude,
    );
    expect(result).toMatchObject({ short: null, picked: "a-candidate" });
  });

  test.each([
    [
      "a malformed Claude 5-hour slot",
      () =>
        mapClaudeUsageResponse({
          rate_limits_available: true,
          rate_limits: {
            five_hour: "soon",
            seven_day: { utilization: 3, resets_at: iso(41) },
          },
        }),
    ],
    [
      "Claude limits with no window at all",
      () =>
        mapClaudeUsageResponse({
          rate_limits_available: true,
          rate_limits: {},
        }),
    ],
  ])("%s stays unknown usage", async (_name, candidate) => {
    const result = await pick("claude", candidate, knownClaude);
    expect(result).toMatchObject({
      short: { usedPct: null, resetsAt: null },
      picked: "z-known",
    });
  });

  test("an OpenAI response with only a classified weekly window is room", async () => {
    const result = await pick(
      "openai-codex",
      () =>
        mapOpenAiUsageResponse(
          {
            rate_limit: {
              primary_window: {
                used_percent: 3,
                limit_window_seconds: 604800,
                reset_at: epoch(24),
              },
            },
          },
          clock,
        ),
      knownOpenAi,
    );
    expect(result).toMatchObject({ short: null, picked: "a-candidate" });
  });

  test.each([
    [
      "an unclassifiable OpenAI plan window",
      () =>
        mapOpenAiUsageResponse(
          {
            rate_limit: {
              primary_window: { used_percent: 96, reset_at: epoch(2) },
              secondary_window: {
                used_percent: 10,
                limit_window_seconds: 604800,
                reset_at: epoch(24),
              },
            },
          },
          clock,
        ),
    ],
    [
      "an empty successful OpenAI body",
      () => mapOpenAiUsageResponse({}, clock),
    ],
    [
      "a malformed OpenAI primary slot beside a valid weekly window",
      () =>
        mapOpenAiUsageResponse(
          {
            rate_limit: {
              primary_window: "malformed-present-slot",
              secondary_window: {
                used_percent: 10,
                limit_window_seconds: 604800,
                reset_at: epoch(24),
              },
            },
          },
          clock,
        ),
    ],
  ])("%s stays unknown usage", async (_name, candidate) => {
    const result = await pick("openai-codex", candidate, knownOpenAi);
    expect(result).toMatchObject({
      short: { usedPct: null, resetsAt: null },
      picked: "z-known",
    });
  });
});

test("a malformed OpenAI secondary slot is an unknown weekly window, not no cap", async () => {
  install([profile("openai", "openai-codex")]);
  openAiResult = () =>
    Promise.resolve(
      mapOpenAiUsageResponse(
        {
          rate_limit: {
            primary_window: {
              used_percent: 3,
              limit_window_seconds: 18000,
              reset_at: Math.floor((clock + 3600_000) / 1000),
            },
            secondary_window: 42,
          },
        },
        clock,
      ),
    );
  await readUsageSnapshot("openai", "openai-codex");
  expect(
    cachedUsageIndicator({ id: "openai", provider: "openai-codex" }),
  ).toMatchObject({
    short: { usedPct: 3 },
    long: { usedPct: null, resetsAt: null },
  });
});
