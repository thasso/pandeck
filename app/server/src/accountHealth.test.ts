import {
  mkdirSync,
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
import type { OpenAiUsageSnapshot } from "@assistant/shared/usage";
import {
  AccountHealthStore,
  initializeAccountHealth,
  readAccountHealth,
  reportAccountRunFailure,
  reportAccountLoginCompleted,
  reportAccountUsageSnapshot,
  sendAccountLoginAlertsTo,
  trackSessionRunHealth,
  withAccountHealthProfiles,
} from "./accountHealth.ts";
import {
  analyzeProviderError,
  isLoginDeath,
  providerErrorDisplayText,
  runFailureFacts,
} from "./providerErrors.ts";

import { NativeAdapterEventSource } from "./session/adapters/nativeEvents.ts";
import { createPiAdapter } from "./session/adapters/pi.ts";
import { createClaudeSdkAdapter } from "./session/adapters/claudeSdk.ts";
import { SessionLogStore } from "./session/log/store.ts";
import { SessionRuntime } from "./session/runtime/runtime.ts";
import {
  subscribeSessionRunStarted,
  subscribeSessionRunFailed,
  subscribeSessionTurnClosed,
} from "./session/runtime/liveSession.ts";
import type { PromptableAdapter } from "./session/adapters/contract.ts";

const directories: string[] = [];
afterEach(() => {
  for (const dir of directories.splice(0))
    rmSync(dir, { recursive: true, force: true });
});
function fixture(
  status: CredentialProfileSummary["status"] = "ready",
  provider: CredentialProfileSummary["provider"] = "claude",
) {
  const dir = mkdtempSync(join(tmpdir(), "account-health-"));
  directories.push(dir);
  let profiles: CredentialProfileSummary[] = [
    {
      id: "acct",
      name: "Private",
      provider,
      enabled: true,
      enterprise: false,
      createdAt: 1,
      updatedAt: 1,
      status,
      health: { state: "unknown", since: null },
    },
  ];
  let configured = status === "ready";
  let now = 1234;
  const push = vi.fn(async () => {});
  const owners: Array<{ profiles: () => CredentialProfileSummary[] }> = [];
  const createStore = () => {
    const deps = {
      profiles: () =>
        store.summaries(() =>
          profiles.map((p) => ({ ...p, health: store.read(p.id, configured) })),
        ),
      hasCredential: (id: string) =>
        configured && profiles.some((p) => p.id === id),
      now: () => now,
      persistPath: join(dir, "health.json"),
      push,
    };
    const store: AccountHealthStore = new AccountHealthStore(deps);
    deps.profiles();
    owners.push(deps);
    return { store, deps };
  };
  const { store, deps } = createStore();
  return {
    store,
    deps,
    restart: () => createStore().store,
    push,
    setProfiles: (next: CredentialProfileSummary[]) => {
      profiles = next;
      for (const owner of owners) owner.profiles();
    },
    profiles: () => profiles,
    advance: () => ++now,
    setNow: (value: number) => {
      now = value;
    },
    setHasCredential: (value: boolean) => {
      configured = value;
    },
  };
}
const authFailure = (message = "401 unauthorized") =>
  runFailureFacts(analyzeProviderError(message));
function unavailable(
  code: NonNullable<OpenAiUsageSnapshot["unavailableCode"]>,
  fetchedAt = 1234,
): OpenAiUsageSnapshot {
  return {
    fetchedAt,
    available: false,
    unavailableCode: code,
    unavailableReason: "provider prose must not be stored",
    planType: null,
    email: null,
    windows: [],
    credits: null,
    spendControl: null,
    resetCredits: null,
    limitReached: false,
  };
}

it.each([
  (store: AccountHealthStore) => store.loginCompleted("acct"),
  (store: AccountHealthStore) =>
    store.usageSnapshot("acct", unavailable("rejected")),
  (store: AccountHealthStore) =>
    store.usageSnapshot("acct", { fetchedAt: 0, rateLimitsAvailable: true }),
  (store: AccountHealthStore) =>
    store.runFailure("acct", authFailure(), "claude-sdk"),
  (store: AccountHealthStore) => store.runWorking("acct", "claude-sdk"),
  (store: AccountHealthStore) =>
    store.usageSnapshot("acct", unavailable("expired")),
  (store: AccountHealthStore) => store.usageFailure("acct", "timeout"),
  (store: AccountHealthStore) => store.forget("acct"),
])(
  "evidence entry %#: a registry failure never escapes or logs its prose",
  (report) => {
    const { store, deps } = fixture();
    deps.profiles = () => {
      throw new Error("SECRET registry error");
    };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(() => report(store)).not.toThrow();
      expect(warn).toHaveBeenCalledExactlyOnceWith(
        "[account-health] could not record account evidence",
      );
    } finally {
      warn.mockRestore();
    }
  },
);

it("pushes once per ordered transition and persists only app wording", () => {
  const { store, deps, push, restart } = fixture();
  deps.profiles();
  expect(store.read("acct", true)).toEqual({ state: "unknown", since: null });
  const info = analyzeProviderError(
    "Invalid API key · Please run /login SECRET",
  );
  expect(isLoginDeath(providerErrorDisplayText(info))).toBe(false);
  store.runFailure("acct", runFailureFacts(info), "claude-sdk");
  store.runFailure("acct", authFailure("unauthorized SECRET"), "claude-sdk");
  expect(push).toHaveBeenCalledTimes(1);
  expect(push.mock.calls[0]).toEqual([
    {
      title: "Private needs login",
      body: "Login is no longer valid. Reconnect this account.",
      navigatePath: "/settings/claude-sdk",
    },
  ]);
  expect(store.read("acct", true).since).toBe(1234);
  expect(readFileSync(deps.persistPath, "utf8")).not.toContain("SECRET");
  const restarted = restart();
  expect(restarted.read("acct", true).state).toBe("needs-login");
  expect(push).toHaveBeenCalledTimes(1);
  store.loginCompleted("acct");
  store.runFailure(
    "acct",
    authFailure("OpenAI Codex token refresh failed (401): secret"),
    "claude-sdk",
  );
  expect(push).toHaveBeenCalledTimes(2);
});

it("does not mistake read-only expiry, 403, timeouts or permission restrictions for dead logins", () => {
  const { store, push } = fixture();
  store.usageSnapshot("acct", unavailable("expired"));
  store.usageSnapshot("acct", unavailable("forbidden"));
  store.usageFailure("acct", "Fetching Claude usage timed out.");
  store.runFailure(
    "acct",
    authFailure("403 Forbidden: permission denied"),
    "claude-sdk",
  );
  store.runFailure("acct", { kind: "network" }, "claude-sdk");
  expect(store.read("acct", true).state).toBe("unknown");
  expect(push).not.toHaveBeenCalled();
  store.usageSnapshot("acct", unavailable("rejected"));
  expect(store.read("acct", true).state).toBe("needs-login");
  store.usageSnapshot("acct", { fetchedAt: 1234, rateLimitsAvailable: true });
  expect(store.read("acct", true).state).toBe("ok");
  store.usageSnapshot("acct", unavailable("not-signed-in"));
  expect(push).toHaveBeenCalledTimes(1);
  store.usageSnapshot("acct", unavailable("expired"));
  expect(store.read("acct", true).state).toBe("ok");
  store.usageFailure("acct", "OAuth token has expired");
  expect(push).toHaveBeenCalledTimes(2);
});

it("derives disconnected accounts without persistence or pushes, and notices terminal fallback credentials", () => {
  const f = fixture("disconnected");
  const listener = vi.fn();
  const unsubscribe = f.store.subscribe(listener);
  f.store.subscribe(() => {
    throw new Error("broken listener");
  });
  f.deps.profiles();
  expect(f.store.alerts()).toEqual([]);
  f.store.usageSnapshot("acct", unavailable("not-signed-in"));
  expect(f.push).not.toHaveBeenCalled();
  f.setProfiles(f.profiles().map((p) => ({ ...p, status: "ready" })));
  f.setHasCredential(true);
  // No registry change event, just a credential file discovered at read time.
  expect(f.store.read("acct", true).state).toBe("unknown");
  expect(f.store.alerts()).toEqual([]);
  unsubscribe();
  const calls = listener.mock.calls.length;
  f.store.runFailure("acct", authFailure(), "claude-sdk");
  expect(listener).toHaveBeenCalledTimes(calls);
  const restarted = f.restart();
  expect(restarted.read("acct", true).state).toBe("needs-login");
  writeFileSync(
    f.deps.persistPath,
    JSON.stringify({
      acct: { state: "needs-login", since: 1, reason: "Not connected." },
    }),
  );
  expect(f.restart().read("acct", true).state).toBe("unknown");
});

it("keeps never-connected card health through setup transitions without app alerts, persistence or pushes", () => {
  const f = fixture("disconnected");
  for (const status of [
    "disconnected",
    "connecting",
    "error",
    "disconnected",
  ] as const) {
    f.setProfiles(f.profiles().map((p) => ({ ...p, status })));
    f.deps.profiles();
    expect(f.store.read("acct", false)).toMatchObject({
      state: "needs-login",
      reason: "Not connected.",
    });
    expect(f.store.alerts()).toHaveLength(0);
    expect(readAccountHealth("no-store", false).state).toBe("needs-login");
  }
  expect(f.push).not.toHaveBeenCalled();
  expect(() => readFileSync(f.deps.persistPath)).toThrow();
  f.setHasCredential(true);
  expect(f.store.read("acct", true).state).toBe("unknown");
});

it.each(["run", "usage", "login"] as const)(
  "%s success without an OAuth credential file cannot create connection history or an app alert",
  (evidence) => {
    const f = fixture("disconnected");
    f.setProfiles(
      f.profiles().map((profile) => ({
        ...profile,
        name: "Default Claude",
        status: "ready",
      })),
    );
    if (evidence === "run") f.store.runWorking("acct", "claude-sdk");
    else if (evidence === "usage")
      f.store.usageSnapshot("acct", {
        fetchedAt: 1234,
        rateLimitsAvailable: true,
      });
    else f.store.loginCompleted("acct");
    expect(f.store.read("acct", false)).toEqual({
      state: "needs-login",
      since: null,
      reason: "Not connected.",
    });
    expect(f.store.alerts()).toEqual([]);
    expect(f.push).not.toHaveBeenCalled();
    expect(
      JSON.parse(readFileSync(f.deps.persistPath, "utf8")).acct,
    ).toMatchObject({
      state: "ok",
      wasConnected: false,
    });
    const restarted = f.restart();
    expect(restarted.alerts()).toEqual([]);
    // Only an actual credential-presence listing establishes history.
    f.setHasCredential(true);
    f.deps.profiles();
    f.setHasCredential(false);
    expect(f.store.alerts()).toEqual([
      { profileId: "acct", name: "Default Claude", provider: "claude" },
    ]);
    expect(f.push).not.toHaveBeenCalled();
  },
);

it("missing credentials override previously observed ok regardless of setup state", () => {
  const f = fixture();
  f.store.runWorking("acct", "claude-sdk");
  f.setHasCredential(false);
  for (const status of [
    "ready",
    "connecting",
    "error",
    "disconnected",
  ] as const) {
    f.setProfiles(f.profiles().map((p) => ({ ...p, status })));
    expect(f.store.read("acct", false)).toMatchObject({
      state: "needs-login",
      reason: "Not connected.",
    });
  }
  expect(JSON.parse(readFileSync(f.deps.persistPath, "utf8")).acct.state).toBe(
    "ok",
  );
  expect(f.push).not.toHaveBeenCalled();
});

it("a Claude snapshot without rate limits proves nothing and cannot re-arm a login push storm", () => {
  const f = fixture();
  f.store.usageSnapshot("acct", {
    fetchedAt: 1234,
    rateLimitsAvailable: false,
  });
  expect(f.store.read("acct", true).state).toBe("unknown");
  f.store.runFailure("acct", authFailure(), "claude-sdk");
  for (let i = 0; i < 3; i++) {
    f.store.usageSnapshot("acct", {
      fetchedAt: f.advance(),
      rateLimitsAvailable: false,
    });
    f.store.runFailure("acct", authFailure(), "claude-sdk");
  }
  expect(f.store.read("acct", true).state).toBe("needs-login");
  expect(f.push).toHaveBeenCalledTimes(1);
  f.store.usageSnapshot("acct", { fetchedAt: 0, rateLimitsAvailable: true });
  expect(f.store.read("acct", true).state).toBe("ok");
});

it("remembers credential presence across restart without persisting derived health, and forgets it on deletion", () => {
  const f = fixture();
  f.deps.profiles();
  expect(
    JSON.parse(readFileSync(f.deps.persistPath, "utf8")).acct,
  ).toMatchObject({ state: "unknown", wasConnected: true });
  f.setHasCredential(false);
  const restarted = f.restart();
  expect(restarted.alerts()).toEqual([
    { profileId: "acct", name: "Private", provider: "claude" },
  ]);
  expect(restarted.read("acct", false)).toMatchObject({
    state: "needs-login",
    reason: "Not connected.",
    since: null,
  });
  expect(readFileSync(f.deps.persistPath, "utf8")).not.toContain(
    "Not connected.",
  );
  expect(f.push).not.toHaveBeenCalled();
  f.setProfiles([]);
  expect(JSON.parse(readFileSync(f.deps.persistPath, "utf8"))).toEqual({});
});

it("projects summary health with one registry read and no per-id credential probes, including registry listings", () => {
  const f = fixture();
  const profiles = vi.fn(f.deps.profiles);
  const hasCredential = vi.fn(f.deps.hasCredential);
  f.deps.profiles = profiles;
  f.deps.hasCredential = hasCredential;
  f.store.alerts();
  expect(profiles).toHaveBeenCalledTimes(1);
  expect(hasCredential).not.toHaveBeenCalled();
  const listener = vi.fn();
  f.store.subscribe(listener);
  profiles.mockClear();
  f.setHasCredential(false);
  f.deps.profiles();
  expect(profiles).toHaveBeenCalledTimes(1);
  expect(hasCredential).not.toHaveBeenCalled();
  expect(listener).toHaveBeenLastCalledWith([
    { profileId: "acct", name: "Private", provider: "claude" },
  ]);
  f.setHasCredential(true);
  f.deps.profiles();
  expect(listener).toHaveBeenLastCalledWith([]);
  expect(f.push).not.toHaveBeenCalled();
});

it("an auth-file rewrite's not-signed-in usage result never persists rejection or pushes", () => {
  const f = fixture("ready", "openai-codex");
  f.store.runWorking("acct", "openai-codex");
  f.setHasCredential(false);
  f.store.usageSnapshot("acct", unavailable("not-signed-in"));
  expect(JSON.parse(readFileSync(f.deps.persistPath, "utf8")).acct.state).toBe(
    "ok",
  );
  f.setHasCredential(true);
  f.store.usageSnapshot("acct", unavailable("not-signed-in"));
  expect(f.store.read("acct", true).state).toBe("ok");
  expect(f.store.alerts()).toEqual([]);
  expect(f.push).not.toHaveBeenCalled();
});

it("keeps reads and observations pure, and lists once per run outcome", () => {
  const f = fixture();
  const profiles = vi.fn(f.deps.profiles);
  f.deps.profiles = profiles;
  const before = statSync(f.deps.persistPath).ino;
  f.store.read("acct", true);
  f.store.read("acct", false);
  f.store.observe("acct");
  expect(profiles).not.toHaveBeenCalled();
  expect(statSync(f.deps.persistPath).ino).toBe(before);
  f.store.runFailure("acct", authFailure(), "claude-sdk");
  expect(profiles).toHaveBeenCalledTimes(1);
  profiles.mockClear();
  f.store.runWorking("acct", "claude-sdk");
  expect(profiles).toHaveBeenCalledTimes(1);
});

it("keeps health usable after a failed write and retries dirty evidence", () => {
  const f = fixture();
  const tmp = `${f.deps.persistPath}.tmp`;
  mkdirSync(tmp);
  f.store.runFailure("acct", authFailure(), "claude-sdk");
  expect(f.store.read("acct", true).state).toBe("needs-login");
  rmSync(tmp, { recursive: true });
  f.deps.profiles();
  expect(f.restart().read("acct", true).state).toBe("needs-login");
});

it("persists only changed durable fields, not same-state evidence or login clocks", () => {
  const f = fixture();
  f.store.runWorking("acct", "claude-sdk");
  const before = statSync(f.deps.persistPath).ino;
  for (let i = 0; i < 3; i++) {
    f.advance();
    f.store.usageSnapshot("acct", { fetchedAt: i, rateLimitsAvailable: true });
    expect(statSync(f.deps.persistPath).ino).toBe(before);
  }
  f.store.loginCompleted("acct");
  expect(statSync(f.deps.persistPath).ino).toBe(before);
  f.store.runFailure("acct", authFailure(), "claude-sdk");
  const rejected = statSync(f.deps.persistPath).ino;
  f.store.runFailure("acct", authFailure(), "claude-sdk");
  expect(statSync(f.deps.persistPath).ino).toBe(rejected);
  expect(
    Object.keys(
      JSON.parse(readFileSync(f.deps.persistPath, "utf8")).acct,
    ).sort(),
  ).toEqual(["reason", "since", "state", "wasConnected"]);
  writeFileSync(
    f.deps.persistPath,
    JSON.stringify({
      acct: {
        state: "needs-login",
        since: 1,
        reason: "Login is no longer valid. Reconnect this account.",
        wasConnected: true,
        order: 9000,
        counter: 9000,
        generation: 99,
      },
    }),
  );
  const restarted = f.restart();
  expect(restarted.observe("acct")).toEqual({ order: 1, generation: 0 });
  restarted.runWorking("acct", "claude-sdk");
  expect(restarted.read("acct", true).state).toBe("ok");
  expect(
    Object.keys(
      JSON.parse(readFileSync(f.deps.persistPath, "utf8")).acct,
    ).sort(),
  ).toEqual(["since", "state", "wasConnected"]);
});

it("clock rollback cannot block completed login or newer evidence", () => {
  const f = fixture();
  f.store.runFailure("acct", authFailure(), "claude-sdk");
  const old = f.store.observe("acct");
  f.setNow(10);
  f.store.loginCompleted("acct");
  expect(f.store.read("acct", true)).toEqual({ state: "ok", since: 10 });
  f.store.runFailure("acct", authFailure(), "claude-sdk", old);
  expect(f.store.read("acct", true).state).toBe("ok");
  f.setNow(5);
  f.store.runFailure("acct", authFailure(), "claude-sdk");
  expect(f.store.read("acct", true).state).toBe("needs-login");
  expect(readFileSync(f.deps.persistPath, "utf8")).not.toMatch(
    /observedAt|startedAt/,
  );
  const restart = f.restart();
  restart.usageSnapshot("acct", { fetchedAt: 0, rateLimitsAvailable: true });
  expect(restart.read("acct", true).state).toBe("ok");
});

it.each(["disconnected", "connecting", "error"] as const)(
  "an account never connected does not push on runtime evidence while %s",
  (status) => {
    const f = fixture(status);
    f.deps.profiles();
    f.store.runFailure("acct", authFailure(), "claude-sdk");
    expect(f.push).not.toHaveBeenCalled();
  },
);

it.each(["connecting", "error", "ready"] as const)(
  "a re-login moving through %s does not clear a dead old credential",
  (status) => {
    const f = fixture();
    f.store.runFailure("acct", authFailure(), "claude-sdk");
    f.setProfiles(f.profiles().map((p) => ({ ...p, status })));
    f.deps.profiles();
    f.setProfiles(f.profiles().map((p) => ({ ...p, status: "ready" })));
    f.deps.profiles();
    expect(f.store.read("acct", true).state).toBe("needs-login");
    f.store.loginCompleted("acct");
    expect(f.store.read("acct", true).state).toBe("ok");
  },
);

it.each(["github-copilot", "openai-compatible"])(
  "%s failures and successes cannot change the Codex account",
  (modelProvider) => {
    const f = fixture("ready", "openai-codex");
    f.store.runFailure("acct", authFailure(), modelProvider);
    expect(f.store.read("acct", true).state).toBe("unknown");
    f.store.runFailure("acct", authFailure(), "openai-codex");
    f.store.runWorking("acct", modelProvider);
    expect(f.store.read("acct", true).state).toBe("needs-login");
    f.store.runFailure("acct", authFailure(), modelProvider);
    expect(f.push).toHaveBeenCalledTimes(1);
  },
);

it("rejects deferred old-token failures after a completed login, including equal timestamps", async () => {
  const f = fixture();
  const old = f.store.observe("acct");
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  }).then(() => f.store.usageSnapshot("acct", unavailable("rejected"), old));
  f.store.loginCompleted("acct");
  release();
  await pending;
  expect(f.store.read("acct", true).state).toBe("ok");
  expect(f.push).not.toHaveBeenCalled();
  // A later order cannot rehabilitate an old credential generation.
  f.store.runFailure("acct", authFailure(), "claude-sdk", {
    ...old,
    order: 9999,
  });
  expect(f.store.read("acct", true).state).toBe("ok");
});

it("rejects deferred older success within a process, but starts a fresh clock after restart", async () => {
  const f = fixture();
  const old = f.store.observe("acct");
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  }).then(() => f.store.runWorking("acct", "claude-sdk", old));
  f.advance();
  f.store.runFailure(
    "acct",
    authFailure(),
    "claude-sdk",
    f.store.observe("acct"),
  );
  release();
  await pending;
  f.store.usageSnapshot(
    "acct",
    { fetchedAt: 1234, rateLimitsAvailable: true },
    old,
  );
  expect(f.store.read("acct", true).state).toBe("needs-login");
  // Same-state evidence advances ordering, so it cannot be undone either.
  const stale = f.store.observe("acct");
  f.store.runFailure(
    "acct",
    authFailure(),
    "claude-sdk",
    f.store.observe("acct"),
  );
  f.store.runWorking("acct", "claude-sdk", stale);
  expect(f.store.read("acct", true).state).toBe("needs-login");
  const restarted = f.restart();
  restarted.usageSnapshot(
    "acct",
    { fetchedAt: 1234, rateLimitsAvailable: true },
    restarted.observe("acct"),
  );
  expect(restarted.read("acct", true).state).toBe("ok");
  expect(f.push).toHaveBeenCalledTimes(1);
});

it("tracks run ids, ignores stale reports, and clears pending entries on all closures and disposal", () => {
  const f = fixture("ready", "openai-codex");
  type Host = Parameters<typeof trackSessionRunHealth>[0];
  let start!: Parameters<Host["subscribeStarted"]>[0];
  let fail!: Parameters<Host["subscribeFailed"]>[0];
  let close!: Parameters<Host["subscribeClosed"]>[0];
  const off = vi.fn();
  const observe = vi.fn(f.store.observe.bind(f.store));
  const failed = vi.fn(f.store.runFailure.bind(f.store));
  const working = vi.fn(f.store.runWorking.bind(f.store));
  const tracker = trackSessionRunHealth(
    {
      session: (id) =>
        id === "s1" ? { credentialProfileId: "acct" } : undefined,
      subscribeStarted: (fn) => {
        start = fn;
        return off;
      },
      subscribeFailed: (fn) => {
        fail = fn;
        return off;
      },
      subscribeClosed: (fn) => {
        close = fn;
        return off;
      },
    },
    { observe, failed, working },
  );
  const report = (runId: string) => ({
    sessionId: "s1",
    runId,
    failure: authFailure(),
    errorMessage: "sanitized",
    origin: undefined,
    at: 1,
  });
  start("missing", "r0", "openai-codex");
  expect(observe).not.toHaveBeenCalled();
  start("s1", "r1", "openai-codex");
  fail(report("older"));
  close("s1", "older", "end");
  expect(failed).not.toHaveBeenCalled();
  expect(working).not.toHaveBeenCalled();
  close("s1", "r1", "aborted");
  fail(report("r1"));
  close("s1", "r1", "end");
  expect(failed).not.toHaveBeenCalled();
  expect(working).not.toHaveBeenCalled();
  expect(f.store.read("acct", true).state).toBe("unknown");
  start("s1", "r2", "openai-codex");
  start("s1", "r3", "openai-codex");
  close("s1", "r2", undefined);
  fail(report("r3"));
  expect(failed).toHaveBeenCalledTimes(1);
  close("s1", "r3", "end");
  expect(working).not.toHaveBeenCalled();
  expect(f.store.read("acct", true).state).toBe("needs-login");
  start("s1", "r4", "openai-codex");
  close("s1", "r4", undefined);
  fail(report("r4"));
  close("s1", "r4", "end");
  expect(failed).toHaveBeenCalledTimes(1);
  expect(working).not.toHaveBeenCalled();
  expect(f.store.read("acct", true).state).toBe("needs-login");
  start("s1", "r5", "openai-codex");
  close("s1", "r5", "end");
  expect(f.store.read("acct", true).state).toBe("ok");
  // Usage during a long turn cannot outrank its later login-death failure.
  start("s1", "r6", "openai-codex");
  f.store.usageSnapshot("acct", { fetchedAt: 1, rateLimitsAvailable: true });
  fail(report("r6"));
  expect(f.store.read("acct", true).state).toBe("needs-login");
  // A fresh failure order still cannot cross a completed-login generation.
  start("s1", "r7", "openai-codex");
  f.store.loginCompleted("acct");
  fail(report("r7"));
  expect(f.store.read("acct", true).state).toBe("ok");
  // Success retains start order and cannot hide a newer rejection.
  start("s1", "r8", "openai-codex");
  f.store.runFailure("acct", authFailure(), "openai-codex");
  close("s1", "r8", "end");
  expect(f.store.read("acct", true).state).toBe("needs-login");
  start("s1", "r9", "openai-codex");
  failed.mockClear();
  working.mockClear();
  tracker.dispose();
  fail(report("r9"));
  close("s1", "r9", "end");
  expect(failed).not.toHaveBeenCalled();
  expect(working).not.toHaveBeenCalled();
  expect(off).toHaveBeenCalledTimes(3);
});

it.each([
  [
    "claude",
    "claude-sdk",
    "claude-mythos-1",
    "Mythos usage limit reached",
    "mythos",
  ],
  [
    "openai-codex",
    "openai-codex",
    "gpt-5-3-codex-spark",
    "Spark usage limit reached",
    "spark",
  ],
  [
    "claude",
    "claude-sdk",
    "claude-opus-5-5",
    "usage limit for requests",
    undefined,
  ],
] as const)(
  "runtime fallback uses the live model for %s classification: %s/%s",
  async (accountProvider, modelProvider, modelId, message, cap) => {
    const f = fixture("ready", accountProvider);
    const adapter: PromptableAdapter = {
      provider: "scripted",
      modelProvider: () => modelProvider,
      modelId: () => modelId,
      capabilities: { fork: "none", compact: false, attachments: false },
      subscribe: () => () => {},
      getBinding: () => ({ provider: "scripted" }),
      prompt: async () => {
        throw new Error(message);
      },
      abort: () => {},
      setModel: () => {},
      setReasoning: () => {},
      dispose: () => {},
    };
    const runtime = new SessionRuntime(new SessionLogStore(true));
    runtime.createSession("fallback-model", adapter);
    const tracker = trackSessionRunHealth(
      {
        session: () => ({ credentialProfileId: "acct" }),
        subscribeStarted: subscribeSessionRunStarted,
        subscribeFailed: subscribeSessionRunFailed,
        subscribeClosed: subscribeSessionTurnClosed,
      },
      {
        observe: f.store.observe.bind(f.store),
        failed: f.store.runFailure.bind(f.store),
        working: f.store.runWorking.bind(f.store),
      },
    );
    try {
      await expect(
        runtime.prompt("fallback-model", "fail without native facts"),
      ).rejects.toThrow(message);
      expect(f.store.bench("acct", modelId)).toMatchObject({ source: "quota" });
      expect(f.store.bench("acct", modelId)?.model).toBe(cap);
    } finally {
      tracker.dispose();
      await runtime.disposeSession("fallback-model");
      f.store.dispose();
    }
  },
);

it.each(["pi", "claude-sdk"] as const)(
  "%s runtime failure benches its account and success clears only its live model",
  async (harness) => {
    const f = fixture("ready", harness === "pi" ? "openai-codex" : "claude");
    const native = new NativeAdapterEventSource();
    const family = harness === "pi" ? "spark" : "opus";
    const cappedModel =
      harness === "pi" ? "gpt-5-3-codex-spark" : "claude-opus-5-5";
    let model = cappedModel;
    let fail = true;
    let sequence = 0;
    const driver = {
      modelProvider: () => (harness === "pi" ? "openai-codex" : "claude-sdk"),
      modelId: () => model,
      steer: async () => "refused" as const,
      sessionFile: undefined,
      subscribeAdapterEvents: native.subscribe.bind(native),
      prompt: () => {
        const id = `m${++sequence}`;
        native.messageStarted(id);
        const failure = { kind: "quota" as const, limitModel: family };
        if (fail) native.runFailing("Limit reached", failure);
        native.messageCompleted(
          id,
          fail ? { errorMessage: "Limit reached", failure } : {},
        );
        return "started" as const;
      },
      abort: () => {},
      setModel: () => {},
      setThinkingLevel: () => {},
    };
    const adapter =
      harness === "pi"
        ? createPiAdapter("bench", driver, { resolveModel: (value) => value })
        : createClaudeSdkAdapter("bench", {
            ...driver,
            prompt: async () => {
              driver.prompt();
            },
          });
    const runtime = new SessionRuntime(new SessionLogStore(true));
    runtime.createSession("bench", adapter);
    const tracker = trackSessionRunHealth(
      {
        session: () => ({ credentialProfileId: "acct" }),
        subscribeStarted: subscribeSessionRunStarted,
        subscribeFailed: subscribeSessionRunFailed,
        subscribeClosed: subscribeSessionTurnClosed,
      },
      {
        observe: f.store.observe.bind(f.store),
        failed: f.store.runFailure.bind(f.store),
        working: f.store.runWorking.bind(f.store),
      },
    );
    try {
      await expect(runtime.prompt("bench", "limited")).rejects.toThrow();
      expect(f.store.bench("acct", cappedModel)?.model).toBe(family);
      fail = false;
      model = harness === "pi" ? "gpt-6-sol" : "sonnet";
      await runtime.prompt("bench", "other model");
      expect(f.store.bench("acct", cappedModel)).toBeDefined();
      model = cappedModel;
      await runtime.prompt("bench", "recovered cap");
      expect(f.store.bench("acct", cappedModel)).toBeUndefined();
      expect(f.push).not.toHaveBeenCalled();
    } finally {
      tracker.dispose();
      await runtime.disposeSession("bench");
    }
  },
);

it("captures the live Pi provider in both model-switch directions and cannot clear Codex with Copilot success", async () => {
  const f = fixture("ready", "openai-codex");
  const native = new NativeAdapterEventSource();
  let provider = "openai-codex";
  let outcome: "end" | "error" = "error";
  let message = 0;
  const adapter = createPiAdapter(
    "switch",
    {
      modelProvider: () => provider,
      subscribeAdapterEvents: native.subscribe.bind(native),
      sessionFile: undefined,
      prompt: () => {
        const id = `m${++message}`;
        native.messageStarted(id);
        const info = analyzeProviderError("401 unauthorized");
        const errorMessage = providerErrorDisplayText(info);
        if (outcome === "error")
          native.runFailing(errorMessage, runFailureFacts(info));
        native.messageCompleted(
          id,
          outcome === "error"
            ? { errorMessage, failure: runFailureFacts(info) }
            : {},
        );
        return "started";
      },
      abort: () => {},
      setModel: (model) => {
        provider = (model as { provider: string }).provider;
      },
      setThinkingLevel: () => {},
    },
    { resolveModel: (model) => model },
  );
  const runtime = new SessionRuntime(new SessionLogStore(true));
  const session = runtime.createSession("switch", adapter);
  const tracker = trackSessionRunHealth(
    {
      session: () => ({ credentialProfileId: "acct" }),
      subscribeStarted: subscribeSessionRunStarted,
      subscribeFailed: subscribeSessionRunFailed,
      subscribeClosed: subscribeSessionTurnClosed,
    },
    {
      observe: f.store.observe.bind(f.store),
      failed: f.store.runFailure.bind(f.store),
      working: f.store.runWorking.bind(f.store),
    },
  );
  try {
    await session.setModel({ provider: "github-copilot", id: "copilot" });
    await expect(runtime.prompt("switch", "copilot failure")).rejects.toThrow();
    expect(f.store.read("acct", true).state).toBe("unknown");
    await session.setModel({ provider: "openai-codex", id: "codex" });
    await expect(
      runtime.prompt("switch", "first Codex failure"),
    ).rejects.toThrow();
    expect(f.store.read("acct", true).state).toBe("needs-login");
    expect(f.push).toHaveBeenCalledTimes(1);
    await session.setModel({ provider: "github-copilot", id: "copilot" });
    outcome = "end";
    await runtime.prompt("switch", "Copilot success with rejected Codex");
    expect(f.store.read("acct", true).state).toBe("needs-login");
    f.store.loginCompleted("acct");
    await session.setModel({ provider: "openai-codex", id: "codex" });
    outcome = "error";
    await expect(
      runtime.prompt("switch", "first real Codex failure after switching back"),
    ).rejects.toThrow();
    expect(f.store.read("acct", true).state).toBe("needs-login");
    expect(f.push).toHaveBeenCalledTimes(2);
  } finally {
    tracker.dispose();
    await runtime.disposeSession("switch");
  }
});

it("unbound legacy sessions cannot fail or clear a different automatic account", async () => {
  const f = fixture("ready", "openai-codex");
  const automaticProfileId = "acct";
  const metadata = new Map<string, { credentialProfileId?: string }>([
    ["unbound", {}],
    ["bound", { credentialProfileId: automaticProfileId }],
  ]);
  const native = new NativeAdapterEventSource();
  let fail = true;
  const adapter = createPiAdapter("unbound", {
    modelProvider: () => "openai-codex",
    subscribeAdapterEvents: native.subscribe.bind(native),
    sessionFile: undefined,
    prompt: () => {
      if (fail) throw new Error("401 Unauthorized");
      native.messageStarted("m");
      native.messageCompleted("m", {});
      return "started";
    },
    abort: () => {},
    setModel: () => {},
    setThinkingLevel: () => {},
  });
  const runtime = new SessionRuntime(new SessionLogStore(true));
  runtime.createSession("unbound", adapter);
  const observe = vi.fn(f.store.observe.bind(f.store));
  const tracker = trackSessionRunHealth(
    {
      session: (id) => metadata.get(id),
      subscribeStarted: subscribeSessionRunStarted,
      subscribeFailed: subscribeSessionRunFailed,
      subscribeClosed: subscribeSessionTurnClosed,
    },
    {
      observe,
      failed: f.store.runFailure.bind(f.store),
      working: f.store.runWorking.bind(f.store),
    },
  );
  try {
    await expect(runtime.prompt("unbound", "legacy failure")).rejects.toThrow();
    expect(f.store.read(automaticProfileId, true).state).toBe("unknown");
    expect(f.push).not.toHaveBeenCalled();
    f.store.runFailure(automaticProfileId, authFailure(), "openai-codex");
    fail = false;
    await runtime.prompt("unbound", "legacy success");
    expect(f.store.read(automaticProfileId, true).state).toBe("needs-login");
    expect(observe).not.toHaveBeenCalled();
    expect(f.push).toHaveBeenCalledTimes(1);
  } finally {
    tracker.dispose();
    await runtime.disposeSession("unbound");
  }
});

it("the runtime cleans tracked fallback turns and deleted active sessions without successful evidence", async () => {
  const f = fixture("ready", "openai-codex");
  let finish!: () => void;
  let started!: () => void;
  const pending = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const began = new Promise<void>((resolve) => {
    started = resolve;
  });
  const adapter: PromptableAdapter = {
    provider: "pi",
    modelProvider: () => "openai-codex",
    capabilities: { fork: "none", compact: false, attachments: false },
    subscribe: () => () => {},
    getBinding: () => ({ provider: "pi" }),
    prompt: async () => ({ stopReason: "end" }),
    abort: () => {},
    setModel: () => {},
    setReasoning: () => {},
    dispose: () => {},
  };
  const runtime = new SessionRuntime(new SessionLogStore(true));
  runtime.createSession("cleanup", adapter);
  const tracker = trackSessionRunHealth(
    {
      session: () => ({ credentialProfileId: "acct" }),
      subscribeStarted: subscribeSessionRunStarted,
      subscribeFailed: subscribeSessionRunFailed,
      subscribeClosed: subscribeSessionTurnClosed,
    },
    {
      observe: f.store.observe.bind(f.store),
      failed: f.store.runFailure.bind(f.store),
      working: f.store.runWorking.bind(f.store),
    },
  );
  try {
    await runtime.prompt("cleanup", "fallback without native runCompleted");
    expect(f.store.read("acct", true).state).toBe("unknown");
    adapter.prompt = async () => {
      started();
      await pending;
      return { stopReason: "end" };
    };
    const run = runtime.prompt("cleanup", "deleted while active");
    await began;
    await runtime.disposeSession("cleanup");
    finish();
    await run;
    expect(f.store.read("acct", true).state).toBe("unknown");
  } finally {
    tracker.dispose();
    await runtime.disposeSession("cleanup");
  }
});

it("disabled accounts never alert; deletion forgets persisted health and ignores late evidence", () => {
  const f = fixture();
  f.setProfiles(f.profiles().map((p) => ({ ...p, enabled: false })));
  f.store.runFailure("acct", authFailure(), "claude-sdk");
  expect(f.store.alerts()).toEqual([]);
  expect(f.push).not.toHaveBeenCalled();
  f.setProfiles(f.profiles().map((p) => ({ ...p, enabled: true })));
  f.deps.profiles();
  expect(f.store.alerts()).toHaveLength(1);
  expect(f.push).not.toHaveBeenCalled();
  f.setProfiles([]);
  f.store.forget("acct");
  f.store.runFailure("acct", authFailure(), "claude-sdk");
  expect(f.store.read("acct", true).state).toBe("unknown");
  expect(f.restart().read("acct", true).state).toBe("unknown");
});

it("tolerates corrupt files and rejects persisted provider wording", () => {
  const f = fixture();
  writeFileSync(f.deps.persistPath, "not json");
  expect(f.restart().read("acct", true).state).toBe("unknown");
  writeFileSync(
    f.deps.persistPath,
    JSON.stringify({
      acct: { state: "needs-login", since: 1, reason: "provider SECRET" },
    }),
  );
  expect(f.restart().read("acct", true).state).toBe("unknown");
});

it("broadcasts and replays authoritative alerts without another push", () => {
  const f = fixture();
  const broadcast = vi.fn();
  const send = vi.fn();
  let change: ((id: string) => void) | undefined;
  let deleted: ((id: string) => void) | undefined;
  initializeAccountHealth({
    profiles: () =>
      withAccountHealthProfiles(() =>
        f.profiles().map((p) => ({
          ...p,
          health: readAccountHealth(p.id, f.deps.hasCredential(p.id)),
        })),
      ),
    hasCredential: f.deps.hasCredential,
    push: f.push,
    broadcast,
    subscribeChanges: (listener) => {
      change = listener;
      return () => {};
    },
    subscribeDeleted: (listener) => {
      deleted = listener;
      return () => {};
    },
  });
  sendAccountLoginAlertsTo({ send });
  expect(send).toHaveBeenLastCalledWith({
    type: "accountLoginAlerts",
    accounts: [],
  });
  reportAccountRunFailure("acct", authFailure(), "claude-sdk");
  expect(readAccountHealth("acct", true).state).toBe("needs-login");
  sendAccountLoginAlertsTo({ send });
  expect(send).toHaveBeenLastCalledWith({
    type: "accountLoginAlerts",
    accounts: [{ profileId: "acct", name: "Private", provider: "claude" }],
  });
  reportAccountRunFailure("acct", authFailure(), "claude-sdk");
  expect(broadcast.mock.calls.map(([message]) => message.type)).toEqual([
    "accountHealthChanged",
    "accountLoginAlerts",
  ]);
  expect(f.push).toHaveBeenCalledTimes(1);
  // Credential changes update tabs that are already connected, without registry events.
  reportAccountLoginCompleted("acct");
  broadcast.mockClear();
  f.setHasCredential(false);
  reportAccountUsageSnapshot("acct", unavailable("not-signed-in"));
  expect(broadcast).toHaveBeenLastCalledWith({
    type: "accountLoginAlerts",
    accounts: [{ profileId: "acct", name: "Private", provider: "claude" }],
  });
  f.setHasCredential(true);
  readAccountHealth("acct", true);
  expect(broadcast).toHaveBeenCalledTimes(2);
  reportAccountUsageSnapshot("acct", unavailable("not-signed-in"));
  expect(broadcast).toHaveBeenLastCalledWith({
    type: "accountLoginAlerts",
    accounts: [],
  });
  expect(f.push).toHaveBeenCalledTimes(1);
  reportAccountRunFailure("acct", authFailure(), "claude-sdk");
  f.setProfiles(f.profiles().map((p) => ({ ...p, enabled: false })));
  change?.("acct");
  expect(broadcast).toHaveBeenLastCalledWith({
    type: "accountLoginAlerts",
    accounts: [],
  });
  reportAccountLoginCompleted("acct");
  expect(readAccountHealth("acct", true).state).toBe("ok");
  f.setProfiles([]);
  deleted?.("acct");
  expect(readAccountHealth("acct", true).state).toBe("unknown");
});

it.each([
  "401 unauthorized",
  "authentication_error",
  "Invalid API key · Please run /login",
  "OAuth token has expired",
  "OAuth token revoked",
  "OpenAI Codex token refresh failed (401): details",
  'OAuth refresh failed for openai-codex: OpenAI Codex token refresh failed (400): {"error":"invalid_grant"}',
  "refresh token revoked",
  "refresh credential rejected",
  "OpenAI Codex token refresh failed (400): invalid_grant",
  "OpenAI Codex token refresh failed (400): refresh token revoked",
  "not logged in",
  "not signed in",
  "no api key",
  "invalid_grant",
])("classifies structured login death before display: %s", (message) => {
  const info = analyzeProviderError(message);
  expect(info.kind).toBe("auth");
  expect(runFailureFacts(info)).toMatchObject({
    kind: "auth",
    loginDeath: true,
  });
});
it.each([
  "403 forbidden",
  "token refresh failed",
  "OpenAI Codex token refresh failed (500): Internal Server Error",
  "OpenAI Codex token refresh failed (503): Unauthorized upstream",
  "OpenAI Codex token refresh failed (403): Forbidden",
  "OpenAI Codex token refresh failed (403): Unauthorized",
  "OpenAI Codex token refresh failed (400): Unauthorized",
  "permission denied",
  "model not available",
  "Fetching Claude usage timed out.",
])("does not flag a restriction or timeout: %s", (message) => {
  expect(
    runFailureFacts(analyzeProviderError(message)).loginDeath,
  ).toBeUndefined();
});
