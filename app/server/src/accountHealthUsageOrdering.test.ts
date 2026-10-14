import { beforeEach, expect, it, vi } from "vitest";
import type { CredentialProfileSummary } from "@assistant/shared";
import type { OpenAiUsageSnapshot } from "@assistant/shared/usage";
import {
  initializeAccountHealth,
  observeAccountHealth,
  readAccountHealth,
  reportAccountLoginCompleted,
  reportAccountRunFailure,
  withAccountHealthProfiles,
} from "./accountHealth.ts";
import {
  forgetUsageProfile,
  readUsageSnapshot,
  resetUsageCacheForTests,
  setUsageCacheDepsForTests,
  revalidateUsage,
  peekUsageSnapshot,
} from "./usageCache.ts";

const profiles: CredentialProfileSummary[] = [
  {
    id: "ordering",
    name: "Ordering",
    provider: "openai-codex",
    enabled: true,
    status: "ready",
    createdAt: 1,
    updatedAt: 1,
    health: { state: "unknown", since: null },
  },
];
const push = vi.fn(async () => {});
let registryUnavailable = false;
initializeAccountHealth({
  profiles: () => {
    if (registryUnavailable) throw new Error("SECRET registry failure");
    return withAccountHealthProfiles(() =>
      profiles.map((profile) => ({
        ...profile,
        health: readAccountHealth(profile.id, true),
      })),
    );
  },
  hasCredential: (id) => profiles.some((profile) => profile.id === id),
  push,
  broadcast: () => {},
  subscribeChanges: () => () => {},
  subscribeDeleted: () => () => {},
});
let resolve!: (snapshot: OpenAiUsageSnapshot) => void;
let pending: Promise<OpenAiUsageSnapshot>;
let fetchStarted: Promise<void>;
let markStarted!: () => void;
beforeEach(() => {
  registryUnavailable = false;
  profiles[0]!.provider = "openai-codex";
  resetUsageCacheForTests();
  forgetUsageProfile("ordering");
  reportAccountLoginCompleted("ordering");
  push.mockClear();
  pending = new Promise((done) => {
    resolve = done;
  });
  fetchStarted = new Promise((done) => {
    markStarted = done;
  });
  setUsageCacheDepsForTests({
    listProfiles: () => profiles,
    now: Date.now,
    fetchOpenAi: () => {
      markStarted();
      return pending;
    },
    fetchClaude: async () => {
      throw new Error("unused");
    },
  });
});
function snapshot(fetchedAt: number, available: boolean): OpenAiUsageSnapshot {
  return {
    fetchedAt,
    available,
    ...(available ? {} : { unavailableCode: "rejected" as const }),
    unavailableReason: available ? null : "old token rejected",
    planType: null,
    email: null,
    limitReached: false,
    windows: [],
    credits: null,
    spendControl: null,
    resetCredits: null,
  };
}

it("health registry failure cannot drop a good usage snapshot", async () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  try {
    const read = readUsageSnapshot("ordering", "openai-codex", { force: true });
    await fetchStarted;
    registryUnavailable = true;
    const good = snapshot(Date.now(), true);
    resolve(good);
    expect(await read).toBe(good);
    expect(peekUsageSnapshot("ordering", "openai-codex")?.snapshot).toBe(good);
    expect(warn).toHaveBeenCalledExactlyOnceWith(
      "[account-health] could not record account evidence",
    );
  } finally {
    warn.mockRestore();
  }
});

it("health registry failure cannot replace Claude usage errors or skip backoff", async () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  let now = 1_000_000;
  const error = new Error("Claude usage timed out");
  const fetch = vi.fn(async () => {
    throw error;
  });
  profiles[0]!.provider = "claude";
  setUsageCacheDepsForTests({
    listProfiles: () => profiles,
    now: () => now,
    fetchClaude: fetch,
  });
  registryUnavailable = true;
  try {
    for (let i = 0; i < 2; i++)
      await expect(
        readUsageSnapshot("ordering", "claude", { force: true }),
      ).rejects.toBe(error);
    now += 61_000;
    revalidateUsage();
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledTimes(2);
  } finally {
    warn.mockRestore();
  }
});

it("the real usage-cache fetch cannot re-raise a deferred old-token rejection after login completion", async () => {
  const startedAt = Date.now();
  const read = readUsageSnapshot("ordering", "openai-codex", { force: true });
  await fetchStarted;
  reportAccountLoginCompleted("ordering");
  resolve(snapshot(startedAt, false));
  await read;
  expect(readAccountHealth("ordering", true).state).toBe("ok");
  expect(push).not.toHaveBeenCalled();
});

it("the real usage-cache fetch cannot clear a newer session failure with an older success", async () => {
  const startedAt = Date.now();
  const read = readUsageSnapshot("ordering", "openai-codex", { force: true });
  await fetchStarted;
  reportAccountRunFailure(
    "ordering",
    { kind: "auth", loginDeath: true },
    "openai-codex",
    observeAccountHealth("ordering"),
  );
  resolve(snapshot(startedAt, true));
  await read;
  expect(readAccountHealth("ordering", true).state).toBe("needs-login");
  expect(push).toHaveBeenCalledTimes(1);
});
