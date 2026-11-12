import assert from "node:assert/strict";
import { afterAll, afterEach, beforeEach, describe, test, vi } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const tmp = mkdtempSync(join(tmpdir(), "pi-profile-login-test-"));
process.env.ASSISTANT_CWD = tmp;
process.env.DATA_DIR = join(tmp, "data");

const {
  createCredentialProfile,
  credentialProfileHasCredential,
  deleteCredentialProfile,
  listCredentialProfiles,
  piAgentDir,
  subscribeCredentialProfileChanges,
  subscribeCredentialProfileDeleted,
} = await import("../credentialProfiles.ts");
const {
  cancelOpenAiProfileLogin,
  setOpenAiProfileLoginForTests,
  setOpenAiProfileLoginTimeoutForTests,
  startOpenAiProfileLogin,
  modelRuntimeForProfile,
} = await import("./models.ts");

const { ModelRuntime } = await import("@earendil-works/pi-coding-agent");
const loginHolds = await import("../loginHolds.ts");
const { GATEWAY_LOGIN_UNAVAILABLE_TEXT, LoginHeldError } =
  await import("../gatewayLink.ts");
const { deferred, fakeLoginHoldLink } =
  await import("../test/fakeLoginHoldLink.ts");

const health = await import("../accountHealth.ts");
health.initializeAccountHealth({
  profiles: listCredentialProfiles,
  hasCredential: credentialProfileHasCredential,
  broadcast: () => {},
  push: async () => {},
  subscribeChanges: subscribeCredentialProfileChanges,
  subscribeDeleted: subscribeCredentialProfileDeleted,
});

async function waitFor<T>(read: () => T | undefined): Promise<T> {
  for (let i = 0; i < 120; i += 1) {
    const value = read();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Timed out waiting for profile login state.");
}

/** An observer that records the device code and the settle, in `events` too. */
function recordingObserver(events?: string[]) {
  const seen = {
    code: undefined as
      { verificationUri: string; userCode: string } | undefined,
    outcome: undefined as [string, string | undefined] | undefined,
    settles: 0,
  };
  return Object.assign(seen, {
    device(verificationUri: string, userCode: string) {
      seen.code = { verificationUri, userCode };
    },
    settled(outcome: string, text?: string) {
      seen.settles += 1;
      seen.outcome = [outcome, text];
      events?.push(`settled ${outcome}`);
    },
  });
}

test("OpenAI device-code login hands the device code only to its observer; the summary shows connecting, then ready", async () => {
  const profile = createCredentialProfile({
    name: "OAuth test",
    provider: "openai-codex",
  });
  let release!: () => void;
  const complete = new Promise<void>((resolve) => {
    release = resolve;
  });
  setOpenAiProfileLoginForTests(async (_runtime, interaction) => {
    interaction.notify({
      type: "device_code",
      verificationUri: "https://auth.example/verify",
      userCode: "ABCD-EFGH",
    });
    await complete;
    writeFileSync(
      join(piAgentDir(profile.id), "auth.json"),
      '{"openai-codex":{}}',
      { mode: 0o600 },
    );
  });

  const observer = recordingObserver();
  startOpenAiProfileLogin(profile.id, observer);
  await waitFor(() => observer.code);
  assert.deepEqual(observer.code, {
    verificationUri: "https://auth.example/verify",
    userCode: "ABCD-EFGH",
  });
  const connecting = listCredentialProfiles().find(
    (item) => item.id === profile.id,
  )!;
  assert.equal(connecting.status, "connecting");
  assert.equal(connecting.health.state, "needs-login");
  // AC9: the code travels only to the observer (the login dialog's socket).
  assert.doesNotMatch(
    JSON.stringify(connecting),
    /access|token|ABCD-EFGH|auth\.example/i,
  );

  release();
  const ready = await waitFor(() =>
    listCredentialProfiles().find(
      (item) => item.id === profile.id && item.status === "ready",
    ),
  );
  assert.equal(ready.setup, undefined);
});

test("persisted OAuth completes the UI while pi's post-login refresh is still settling", async () => {
  const profile = createCredentialProfile({
    name: "OAuth slow refresh",
    provider: "openai-codex",
  });
  let persist!: () => void;
  let settle!: () => void;
  let calls = 0;
  const credentialReady = new Promise<void>((resolve) => {
    persist = resolve;
  });
  const refreshSettled = new Promise<void>((resolve) => {
    settle = resolve;
  });
  setOpenAiProfileLoginForTests(async (_runtime, interaction, committed) => {
    calls += 1;
    interaction.notify({
      type: "device_code",
      verificationUri: "https://auth.example/verify",
      userCode: "SLOW-REFRESH",
    });
    await credentialReady;
    writeFileSync(
      join(piAgentDir(profile.id), "auth.json"),
      '{"openai-codex":{}}',
      { mode: 0o600 },
    );
    committed();
    await refreshSettled;
  });

  const observer = recordingObserver();
  startOpenAiProfileLogin(profile.id, observer);
  await waitFor(() => observer.code);
  persist();

  const ready = await waitFor(() =>
    listCredentialProfiles().find(
      (item) => item.id === profile.id && item.status === "ready",
    ),
  );
  assert.equal(ready.setup, undefined);
  startOpenAiProfileLogin(profile.id);
  assert.equal(
    calls,
    1,
    "the settling SDK operation must still serialize reconnect attempts",
  );
  settle();
});

test("a post-persistence refresh failure does not undo a completed login", async () => {
  const profile = createCredentialProfile({
    name: "OAuth refresh failure",
    provider: "openai-codex",
  });
  setOpenAiProfileLoginForTests(async (_runtime, interaction, committed) => {
    interaction.notify({
      type: "device_code",
      verificationUri: "https://auth.example/verify",
      userCode: "REFRESH-FAIL",
    });
    writeFileSync(
      join(piAgentDir(profile.id), "auth.json"),
      '{"openai-codex":{}}',
      { mode: 0o600 },
    );
    committed();
    throw new Error("model refresh failed after persistence");
  });

  startOpenAiProfileLogin(profile.id);
  const ready = await waitFor(() =>
    listCredentialProfiles().find(
      (item) => item.id === profile.id && item.status === "ready",
    ),
  );
  assert.equal(ready.error, undefined);
});

test("the SDK's own login result is matched to its serialized credential before reporting completion", async () => {
  const profile = createCredentialProfile({
    name: "SDK commit",
    provider: "openai-codex",
  });
  const generation = health.observeAccountHealth(profile.id)!.generation;
  let checked!: () => void;
  const done = new Promise<void>((resolve) => {
    checked = resolve;
  });
  const productionLogin = setOpenAiProfileLoginForTests(null);
  setOpenAiProfileLoginForTests(
    async (runtime, interaction, committed, authPath) => {
      const provider = runtime.getProvider("openai-codex");
      assert.ok(provider?.auth.oauth);
      const credential = {
        type: "oauth" as const,
        access: "test-access",
        refresh: "test-refresh",
        expires: Date.now() + 600_000,
      };
      runtime.registerNativeProvider({
        ...provider,
        auth: {
          ...provider.auth,
          oauth: {
            ...provider.auth.oauth,
            login: async () => credential,
            toAuth: async () => ({ apiKey: "test-access" }),
          },
        },
      });
      await productionLogin(runtime, interaction, committed, authPath);
      assert.equal(health.readAccountHealth(profile.id, true).state, "ok");
      assert.equal(
        health.observeAccountHealth(profile.id)!.generation,
        generation + 1,
      );
      checked();
    },
  );
  startOpenAiProfileLogin(profile.id);
  await done;
});

test("OpenAI device-code login records a safe failure state", async () => {
  const profile = createCredentialProfile({
    name: "OAuth failure",
    provider: "openai-codex",
  });
  setOpenAiProfileLoginForTests(async () => {
    throw new Error("provider denied the device code");
  });

  startOpenAiProfileLogin(profile.id);
  const failed = await waitFor(() =>
    listCredentialProfiles().find(
      (item) => item.id === profile.id && item.status === "error",
    ),
  );
  assert.match(failed.error ?? "", /provider denied/i);
  assert.equal(failed.health.state, "needs-login");
  assert.doesNotMatch(JSON.stringify(failed), /access|token/i);
});

test("a timed-out login remains authoritative until the provider operation settles", async () => {
  const profile = createCredentialProfile({
    name: "OAuth timeout",
    provider: "openai-codex",
  });
  let calls = 0;
  let release!: () => void;
  const complete = new Promise<void>((resolve) => {
    release = resolve;
  });
  setOpenAiProfileLoginTimeoutForTests(15);
  setOpenAiProfileLoginForTests(async () => {
    calls += 1;
    await complete;
    writeFileSync(
      join(piAgentDir(profile.id), "auth.json"),
      '{"openai-codex":{}}',
      { mode: 0o600 },
    );
  });

  const observer = recordingObserver();
  startOpenAiProfileLogin(profile.id, observer);
  await waitFor(() => (calls === 1 ? true : undefined));
  await new Promise((resolve) => setTimeout(resolve, 40));
  // D4: the timeout aborts; the account's error waits for the settle.
  assert.equal(
    listCredentialProfiles().find((item) => item.id === profile.id)?.status,
    "connecting",
  );
  assert.equal(startOpenAiProfileLogin(profile.id), false);
  assert.equal(
    calls,
    1,
    "retry must not overlap the provider operation that timed out locally",
  );

  // This fake ignores the abort and still commits: the commit wins.
  release();
  await waitFor(() => observer.outcome);
  assert.deepEqual(observer.outcome, ["ready", undefined]);
  assert.equal(
    listCredentialProfiles().find((item) => item.id === profile.id)?.status,
    "ready",
  );
});

test("deleting a profile invalidates and cleans up a late login completion", async () => {
  const profile = createCredentialProfile({
    name: "OAuth deleted",
    provider: "openai-codex",
  });
  const agentDir = piAgentDir(profile.id);
  const root = dirname(agentDir);
  let release!: () => void;
  let markStarted!: () => void;
  const complete = new Promise<void>((resolve) => {
    release = resolve;
  });
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  setOpenAiProfileLoginForTests(async () => {
    markStarted();
    await complete;
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(join(agentDir, "auth.json"), '{"openai-codex":{}}', {
      mode: 0o600,
    });
  });

  startOpenAiProfileLogin(profile.id);
  await started;
  deleteCredentialProfile(profile.id);
  release();

  await waitFor(() => (existsSync(root) ? undefined : true));
  assert.equal(
    listCredentialProfiles().some((item) => item.id === profile.id),
    false,
  );
});

test("starting and failing a re-login keeps the old rejected credential unhealthy; only replacement clears it", async () => {
  const profile = createCredentialProfile({
    name: "Old login",
    provider: "openai-codex",
  });
  const auth = join(piAgentDir(profile.id), "auth.json");
  writeFileSync(auth, '{"openai-codex":{"access":"old"}}');
  health.reportAccountRunFailure(
    profile.id,
    { kind: "auth", loginDeath: true },
    "openai-codex",
  );
  let fail!: (error: Error) => void;
  const failed = new Promise<void>((_resolve, reject) => {
    fail = reject;
  });
  let markStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  setOpenAiProfileLoginForTests(async () => {
    markStarted();
    await failed;
  });
  startOpenAiProfileLogin(profile.id);
  await started;
  await waitFor(() =>
    listCredentialProfiles().find(
      (p) => p.id === profile.id && p.status === "connecting",
    ),
  );
  assert.equal(health.readAccountHealth(profile.id, true).state, "needs-login");
  fail(new Error("denied device code"));
  await waitFor(() =>
    listCredentialProfiles().find(
      (p) => p.id === profile.id && p.error?.includes("denied"),
    ),
  );
  assert.equal(health.readAccountHealth(profile.id, true).state, "needs-login");
  let settle!: () => void;
  const pending = new Promise<void>((resolve) => {
    settle = resolve;
  });
  setOpenAiProfileLoginForTests(async (_runtime, _interaction, committed) => {
    writeFileSync(auth, '{"openai-codex":{"access":"new"}}');
    committed();
    await pending;
  });
  startOpenAiProfileLogin(profile.id);
  await waitFor(() =>
    health.readAccountHealth(profile.id, true).state === "ok"
      ? true
      : undefined,
  );
  settle();
});

test("an unrelated old-token refresh during a failed re-login does not complete the device flow or invalidate its run", async () => {
  const profile = createCredentialProfile({
    name: "Unrelated refresh",
    provider: "openai-codex",
  });
  const auth = join(piAgentDir(profile.id), "auth.json");
  writeFileSync(auth, '{"openai-codex":{"access":"old"}}');
  health.reportAccountRunFailure(
    profile.id,
    { kind: "auth", loginDeath: true },
    "openai-codex",
  );
  let fail!: (error: Error) => void;
  let started!: () => void;
  const pending = new Promise<void>((_resolve, reject) => {
    fail = reject;
  });
  const began = new Promise<void>((resolve) => {
    started = resolve;
  });
  const productionLogin = setOpenAiProfileLoginForTests(null);
  setOpenAiProfileLoginForTests(
    async (runtime, interaction, committed, authPath) => {
      const provider = runtime.getProvider("openai-codex");
      assert.ok(provider?.auth.oauth);
      runtime.registerNativeProvider({
        ...provider,
        auth: {
          ...provider.auth,
          oauth: {
            ...provider.auth.oauth,
            login: async () => {
              started();
              await pending;
              return {
                type: "oauth",
                access: "new",
                refresh: "new",
                expires: Date.now() + 600_000,
              };
            },
          },
        },
      });
      return await productionLogin(runtime, interaction, committed, authPath);
    },
  );
  startOpenAiProfileLogin(profile.id);
  await began;
  const run = health.observeAccountHealth(profile.id)!;
  writeFileSync(auth, '{"openai-codex":{"access":"old-refreshed"}}');
  await new Promise((resolve) => setTimeout(resolve, 300));
  const current = listCredentialProfiles().find((p) => p.id === profile.id)!;
  assert.equal(current.status, "connecting");
  assert.equal(current.health.state, "needs-login");
  assert.equal(
    health.observeAccountHealth(profile.id)?.generation,
    run.generation,
  );
  health.reportAccountRunFailure(
    profile.id,
    { kind: "auth", loginDeath: true },
    "openai-codex",
    run,
  );
  fail(new Error("device flow denied"));
  await waitFor(() =>
    listCredentialProfiles().find(
      (p) => p.id === profile.id && p.error?.includes("denied"),
    ),
  );
  assert.equal(health.readAccountHealth(profile.id, true).state, "needs-login");
});

test.each(["reject", "timeout"])(
  "an operation's own commit followed by post-login %s never installs an error state",
  async (outcome) => {
    const profile = createCredentialProfile({
      name: `Committed ${outcome}`,
      provider: "openai-codex",
    });
    let fail!: (error: Error) => void;
    let started!: () => void;
    let calls = 0;
    const pending = new Promise<void>((_resolve, reject) => {
      fail = reject;
    });
    const began = new Promise<void>((resolve) => {
      started = resolve;
    });
    setOpenAiProfileLoginTimeoutForTests(outcome === "timeout" ? 350 : 2000);
    const productionLogin = setOpenAiProfileLoginForTests(null);
    setOpenAiProfileLoginForTests(
      async (runtime, interaction, committed, authPath) => {
        const provider = runtime.getProvider("openai-codex");
        assert.ok(provider?.auth.oauth);
        runtime.registerNativeProvider({
          ...provider,
          auth: {
            ...provider.auth,
            oauth: {
              ...provider.auth.oauth,
              login: async () => ({
                type: "oauth",
                access: "new",
                refresh: "new",
                expires: Date.now() + 600_000,
              }),
            },
          },
        });
        vi.spyOn(runtime, "login").mockImplementation(async () => {
          calls++;
          const credential = await runtime
            .getProvider("openai-codex")!
            .auth.oauth!.login({
              ...interaction,
              signal: new AbortController().signal,
            });
          writeFileSync(
            authPath,
            JSON.stringify({ "openai-codex": credential }),
          );
          started();
          await pending;
          return credential;
        });
        return await productionLogin(runtime, interaction, committed, authPath);
      },
    );
    startOpenAiProfileLogin(profile.id);
    await began;
    await new Promise((resolve) =>
      setTimeout(resolve, outcome === "timeout" ? 450 : 300),
    );
    let current = listCredentialProfiles().find((p) => p.id === profile.id)!;
    assert.equal(current.health.state, "ok");
    assert.equal(current.status, "ready");
    assert.equal(current.error, undefined);
    startOpenAiProfileLogin(profile.id);
    assert.equal(
      calls,
      1,
      "post-login synchronization still serializes another login",
    );
    fail(new Error("post-login refresh rejected"));
    await new Promise((resolve) => setTimeout(resolve, 20));
    current = listCredentialProfiles().find((p) => p.id === profile.id)!;
    assert.equal(current.health.state, "ok");
    assert.equal(current.status, "ready");
    assert.equal(current.error, undefined);
  },
);

test.each(["default", "isolated"])(
  "completed login force-refreshes the %s account's session runtime snapshot",
  async (scope) => {
    const profileId =
      scope === "default"
        ? "default"
        : createCredentialProfile({
            name: "Runtime refresh",
            provider: "openai-codex",
          }).id;
    const own = await modelRuntimeForProfile(profileId);
    const provider = own.getProvider("openai-codex");
    assert.ok(provider?.auth.oauth);
    own.registerNativeProvider({
      ...provider,
      auth: {
        ...provider.auth,
        oauth: {
          ...provider.auth.oauth,
          toAuth: async () => ({ apiKey: "sentinel-a" }),
        },
      },
    });
    assert.equal(own.isUsingOAuth("openai-codex"), false);
    const originalRefresh = own.refresh.bind(own);
    let refreshed!: () => void;
    const finished = new Promise<void>((resolve) => {
      refreshed = resolve;
    });
    const refresh = vi
      .spyOn(own, "refresh")
      .mockImplementation(async (options) => {
        const result = await originalRefresh(options);
        refreshed();
        return result;
      });
    setOpenAiProfileLoginForTests(
      async (facade, _interaction, committed, authPath) => {
        assert.notEqual(facade, own);
        writeFileSync(
          authPath,
          JSON.stringify({
            "openai-codex": {
              type: "oauth",
              access: "sentinel-a",
              refresh: "test-refresh",
              expires: Date.now() + 600_000,
            },
          }),
        );
        committed();
      },
    );
    try {
      startOpenAiProfileLogin(profileId);
      await finished;
      assert.deepEqual(refresh.mock.calls, [[{ force: true }]]);
      assert.equal(own.isUsingOAuth("openai-codex"), true);
      assert.equal(
        own
          .getAvailableSnapshot()
          .some((model) => model.provider === "openai-codex"),
        true,
      );
      assert.equal(health.readAccountHealth(profileId, true).state, "ok");
    } finally {
      refresh.mockRestore();
      own.registerNativeProvider(provider);
    }
  },
);

test("deletion retires SDK files written by a snapshot refresh that outlives login", async () => {
  const profile = createCredentialProfile({
    name: "Deleted during snapshot refresh",
    provider: "openai-codex",
  });
  const agentDir = piAgentDir(profile.id);
  const own = await modelRuntimeForProfile(profile.id);
  const originalRefresh = own.refresh.bind(own);
  let release!: () => void;
  let started!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  const began = new Promise<void>((resolve) => {
    started = resolve;
  });
  let written!: () => void;
  const wrote = new Promise<void>((resolve) => {
    written = resolve;
  });
  const refresh = vi
    .spyOn(own, "refresh")
    .mockImplementation(async (options) => {
      started();
      await pending;
      mkdirSync(agentDir, { recursive: true });
      writeFileSync(join(agentDir, "auth.json"), '{"openai-codex":{}}');
      written();
      return await originalRefresh(options);
    });
  setOpenAiProfileLoginForTests(
    async (_runtime, _interaction, committed, authPath) => {
      writeFileSync(authPath, '{"openai-codex":{}}');
      committed();
    },
  );
  try {
    startOpenAiProfileLogin(profile.id);
    await began;
    // Let the login facade settle; the refresh remains independently pending.
    await new Promise<void>((resolve) => setImmediate(resolve));
    deleteCredentialProfile(profile.id);
    assert.equal(existsSync(dirname(agentDir)), false);
    release();
    await wrote;
    await waitFor(() => (existsSync(dirname(agentDir)) ? undefined : true));
    assert.equal(health.readAccountHealth(profile.id, true).state, "unknown");
  } finally {
    release();
    refresh.mockRestore();
  }
});

// G5b: the pi login's hold (AC7, AC8, AC10's live pi hold, AC14). pi's
// provider login is the hold's writer, in this process: the hold is taken
// before it and ends only once it settled.
describe("G5b: the pi login's hold", () => {
  const TIMED_OUT =
    "OpenAI device-code login timed out. The active login will finish before another can start.";
  let logged: string[] = [];

  /** An OpenAI profile, a fake link, and a provider login the test settles. */
  function piSetup(name: string, options: { link?: boolean } = {}) {
    const profile = createCredentialProfile({ name, provider: "openai-codex" });
    const events: string[] = [];
    const fake = fakeLoginHoldLink(events);
    loginHolds.setLoginHoldLinkForTests(
      options.link === false ? undefined : fake.link,
    );
    const authPath = join(piAgentDir(profile.id), "auth.json");
    const create = vi.spyOn(ModelRuntime, "create");
    const runtimes = () =>
      create.mock.calls.filter(
        ([opts]) => (opts as { authPath?: string })?.authPath === authPath,
      ).length;
    let settle = deferred<void>();
    setOpenAiProfileLoginForTests(async () => {
      events.push("login");
      const current = settle;
      await current.promise;
      // A deletion removed the directory; the provider writes regardless.
      mkdirSync(dirname(authPath), { recursive: true });
      writeFileSync(authPath, '{"openai-codex":{}}', { mode: 0o600 });
      events.push("settled");
    });
    return {
      profile,
      events,
      fake,
      runtimes,
      /** The provider login's outcome; a fresh one for the next login. */
      settle: () => settle,
      next: () => {
        settle = deferred<void>();
      },
      state: () => listCredentialProfiles().find((p) => p.id === profile.id),
    };
  }

  beforeEach(() => {
    logged = [];
    for (const method of ["log", "info", "warn", "error"] as const)
      vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
        logged.push(args.map(String).join(" "));
      });
  });

  afterEach(() => {
    // AC14: no hold id reaches a log line (pi's flow takes no pasted input).
    for (const line of logged)
      for (const value of ["hold-1", "hold-2"])
        assert.ok(!line.includes(value), `a log line leaks: ${line}`);
    vi.restoreAllMocks();
    loginHolds.setLoginHoldLinkForTests(null);
  });

  test.each(["resolve", "reject"] as const)(
    "AC7: the hold comes before the runtime and the login; a UI timeout keeps it; it ends after the provider settles (%s), and a restart then acquires",
    async (outcome) => {
      const setup = piSetup(`Held OpenAI ${outcome}`);
      const acquired = deferred<string>();
      setup.fake.acquire = () => acquired.promise;
      setOpenAiProfileLoginTimeoutForTests(15);

      startOpenAiProfileLogin(setup.profile.id);
      await new Promise((resolve) => setTimeout(resolve, 30));
      assert.deepEqual(setup.events, [`acquire ${setup.profile.id}`]);
      assert.equal(setup.runtimes(), 0, "no runtime before the hold");
      assert.equal(setup.state()?.status, "connecting");

      acquired.resolve("hold-1");
      await waitFor(() => (setup.events.includes("login") ? true : undefined));
      await new Promise((resolve) => setTimeout(resolve, 30));
      // D4: the timeout aborts, but the account's error waits for the settle.
      assert.equal(setup.state()?.status, "connecting");
      assert.equal(setup.runtimes(), 1);
      assert.deepEqual(
        setup.events,
        [`acquire ${setup.profile.id}`, "login"],
        "the UI timeout releases nothing",
      );

      if (outcome === "resolve") setup.settle().resolve();
      else setup.settle().reject(new Error("The provider refused."));
      await waitFor(() =>
        setup.events.includes("release hold-1") ? true : undefined,
      );
      assert.deepEqual(setup.events.slice(2), [
        ...(outcome === "resolve" ? ["settled"] : []),
        "release hold-1",
      ]);
      await waitFor(() =>
        setup.state()?.status === (outcome === "resolve" ? "ready" : "error")
          ? true
          : undefined,
      );
      // A login resolving after the abort still committed; a rejection
      // after the timeout ends with the timeout's text.
      if (outcome === "reject") assert.equal(setup.state()?.error, TIMED_OUT);

      // The login has ended here, so a restart takes a new hold at once.
      setup.next();
      setup.fake.acquire = () => Promise.resolve("hold-2");
      setOpenAiProfileLoginTimeoutForTests(null);
      startOpenAiProfileLogin(setup.profile.id);
      await waitFor(() =>
        setup.events.filter((event) => event.startsWith("acquire")).length === 2
          ? true
          : undefined,
      );
      setup.settle().resolve();
      await waitFor(() =>
        setup.events.includes("release hold-2") ? true : undefined,
      );
    },
  );

  test("AC7: a stuck login starts no runtime and leaves no login state", async () => {
    const setup = piSetup("Stuck OpenAI");
    setup.fake.acquire = () =>
      Promise.reject(new LoginHeldError("login_stuck", "hold-9"));

    startOpenAiProfileLogin(setup.profile.id);
    await waitFor(() =>
      setup.state()?.status === "connecting" ? undefined : true,
    );
    assert.equal(setup.runtimes(), 0);
    assert.deepEqual(setup.events, [`acquire ${setup.profile.id}`]);
    assert.equal(setup.state()?.status, "disconnected");
    assert.equal(setup.state()?.error, undefined);
    assert.equal(loginHolds.loginStuckOf(setup.profile), true);
  });

  test.each([
    ["the gateway is unreachable", () => new Error("unreachable")],
    ["a hold exists", () => new LoginHeldError("hold_exists", "hold-9")],
    [
      "a stuck refusal names no hold",
      () => new LoginHeldError("login_stuck", undefined),
    ],
  ])(
    "AC7: when %s the login shows U7's unavailable text and starts nothing",
    async (_case, refusal) => {
      const setup = piSetup("Unavailable OpenAI");
      setup.fake.acquire = () => Promise.reject(refusal());

      startOpenAiProfileLogin(setup.profile.id);
      await waitFor(() =>
        setup.state()?.status === "error" ? true : undefined,
      );
      assert.equal(setup.state()?.error, GATEWAY_LOGIN_UNAVAILABLE_TEXT);
      assert.equal(setup.runtimes(), 0);
      assert.deepEqual(setup.events, [`acquire ${setup.profile.id}`]);
      assert.equal(loginHolds.loginStuckOf(setup.profile), false);
    },
  );

  test("AC7: a deletion during the login releases only after the provider settles", async () => {
    const setup = piSetup("Deleted OpenAI");
    // Read before the deletion: `piAgentDir` creates what it names.
    const root = dirname(piAgentDir(setup.profile.id));
    startOpenAiProfileLogin(setup.profile.id);
    await waitFor(() => (setup.events.includes("login") ? true : undefined));

    deleteCredentialProfile(setup.profile.id);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(setup.events, [`acquire ${setup.profile.id}`, "login"]);

    setup.settle().resolve();
    await waitFor(() =>
      setup.events.includes("release hold-1") ? true : undefined,
    );
    assert.deepEqual(setup.events.slice(2), ["settled", "release hold-1"]);
    await waitFor(() => (existsSync(root) ? undefined : true));
  });

  test("AC7: a deletion while the hold is acquired starts nothing and releases it", async () => {
    const setup = piSetup("Deleted while acquiring");
    const acquired = deferred<string>();
    setup.fake.acquire = () => acquired.promise;
    startOpenAiProfileLogin(setup.profile.id);
    deleteCredentialProfile(setup.profile.id);

    acquired.resolve("hold-1");
    await waitFor(() =>
      setup.events.includes("release hold-1") ? true : undefined,
    );
    assert.deepEqual(setup.events, [
      `acquire ${setup.profile.id}`,
      "release hold-1",
    ]);
    assert.equal(setup.runtimes(), 0);
  });

  test("AC10: Clear on this boot's running pi login is refused with pi's text and keeps the hold (DQ2)", async () => {
    const setup = piSetup("Cleared OpenAI");
    startOpenAiProfileLogin(setup.profile.id);
    await waitFor(() => (setup.events.includes("login") ? true : undefined));
    setup.fake.status(setup.profile.id, { loginStuck: true, holdId: "hold-1" });

    await assert.rejects(loginHolds.clearUnfinishedLogin(setup.profile), {
      message: TIMED_OUT,
    });
    assert.deepEqual(setup.events, [`acquire ${setup.profile.id}`, "login"]);
    assert.equal(setup.state()?.status, "connecting");

    setup.settle().resolve();
    await waitFor(() => (setup.state()?.status === "ready" ? true : undefined));
    assert.deepEqual(setup.events.slice(2), ["settled", "release hold-1"]);
  });

  test("AC8: with the switch off the login runs without a hold, is never stuck, and Clear does nothing", async () => {
    const setup = piSetup("Unheld OpenAI", { link: false });
    startOpenAiProfileLogin(setup.profile.id);
    await waitFor(() => (setup.events.includes("login") ? true : undefined));
    setup.settle().resolve();
    await waitFor(() => (setup.state()?.status === "ready" ? true : undefined));
    assert.deepEqual(setup.events, ["login", "settled"]);
    assert.equal(loginHolds.loginStuckOf(setup.profile), false);
    await loginHolds.clearUnfinishedLogin(setup.profile);
    assert.deepEqual(setup.events, ["login", "settled"]);
  });
});

// Task-1402 B1: cancel, the UI timeout's abort and the outcome precedence
// (AC2, AC3, AC12, AC14). The commit wins; otherwise the first stop reason;
// the observer hears the outcome only after release, cleanup and the map.
describe("Task-1402 B1: cancel and outcome precedence", () => {
  const TIMED_OUT =
    "OpenAI device-code login timed out. The active login will finish before another can start.";
  type Login = Parameters<typeof setOpenAiProfileLoginForTests>[0];

  function setup(name: string, login: (events: string[]) => Login) {
    const profile = createCredentialProfile({ name, provider: "openai-codex" });
    const events: string[] = [];
    const fake = fakeLoginHoldLink(events);
    loginHolds.setLoginHoldLinkForTests(fake.link);
    let calls = 0;
    const run = login(events)!;
    setOpenAiProfileLoginForTests(async (...args) => {
      calls += 1;
      return await run(...args);
    });
    const observer = recordingObserver(events);
    return {
      profile,
      events,
      fake,
      observer,
      calls: () => calls,
      // Read before any deletion: `piAgentDir` creates what it names.
      root: dirname(piAgentDir(profile.id)),
      authPath: join(piAgentDir(profile.id), "auth.json"),
      state: () => listCredentialProfiles().find((p) => p.id === profile.id),
    };
  }

  /** pi's login as measured: the device code, then a rejection on abort. */
  const honorsAbort: (events: string[]) => Login =
    (events) => async (_runtime, interaction) => {
      events.push("login");
      interaction.notify({
        type: "device_code",
        verificationUri: "https://auth.example/verify",
        userCode: "CANCEL-ME",
      });
      await new Promise<never>((_resolve, reject) =>
        interaction.signal!.addEventListener(
          "abort",
          () => {
            events.push("aborted");
            reject(new Error("This operation was aborted"));
          },
          { once: true },
        ),
      );
    };

  /** A login that commits its own credential, then synchronizes until `sync` settles. */
  function commitsThenSyncs(sync: Promise<void>) {
    return (events: string[]): Login =>
      async (_runtime, interaction, committed, authPath) => {
        events.push("login");
        interaction.signal!.addEventListener("abort", () =>
          events.push("aborted"),
        );
        writeFileSync(authPath, '{"openai-codex":{}}', { mode: 0o600 });
        committed();
        await sync;
      };
  }

  afterEach(() => {
    vi.restoreAllMocks();
    loginHolds.setLoginHoldLinkForTests(null);
  });

  test.each(["no credential", "an earlier credential"] as const)(
    "AC2: Cancel before the commit aborts pi's login; it settles cancelled after the release, with %s and no error, and a fresh start runs a new login",
    async (before) => {
      const t = setup(`Cancel ${before}`, honorsAbort);
      if (before === "an earlier credential")
        writeFileSync(t.authPath, '{"openai-codex":{}}', { mode: 0o600 });
      let atSettle: { status?: string; error?: string } | undefined;
      let freshStart: boolean | undefined;
      startOpenAiProfileLogin(t.profile.id, {
        device: t.observer.device,
        settled(outcome, text) {
          t.observer.settled(outcome, text);
          const state = t.state();
          atSettle = {
            ...(state?.status ? { status: state.status } : {}),
            ...(state?.error ? { error: state.error } : {}),
          };
          // The operation has already left its map: a start runs anew.
          freshStart = startOpenAiProfileLogin(t.profile.id);
        },
      });
      await waitFor(() => t.observer.code);
      assert.equal(t.state()?.status, "connecting");

      cancelOpenAiProfileLogin(t.profile.id);
      await waitFor(() => t.observer.outcome);
      assert.deepEqual(t.observer.outcome, ["cancelled", undefined]);
      assert.deepEqual(t.events.slice(0, 5), [
        `acquire ${t.profile.id}`,
        "login",
        "aborted",
        "release hold-1",
        "settled cancelled",
      ]);
      assert.deepEqual(atSettle, {
        status: before === "no credential" ? "disconnected" : "ready",
      });
      assert.equal(freshStart, true);
      await waitFor(() => (t.calls() === 2 ? true : undefined));
      cancelOpenAiProfileLogin(t.profile.id);
      await waitFor(() =>
        t.events.includes("release hold-2") ? true : undefined,
      );
    },
  );

  test("AC3: Cancel before the hold is granted starts no login, releases the later hold and settles cancelled", async () => {
    const t = setup("Cancel before hold", honorsAbort);
    const acquired = deferred<string>();
    t.fake.acquire = () => acquired.promise;
    startOpenAiProfileLogin(t.profile.id, t.observer);
    cancelOpenAiProfileLogin(t.profile.id);
    acquired.resolve("hold-1");
    await waitFor(() => t.observer.outcome);
    assert.deepEqual(t.observer.outcome, ["cancelled", undefined]);
    assert.equal(t.calls(), 0);
    assert.deepEqual(t.events, [
      `acquire ${t.profile.id}`,
      "release hold-1",
      "settled cancelled",
    ]);
    assert.equal(t.state()?.status, "disconnected");
    assert.equal(t.state()?.error, undefined);
  });

  test("AC12: the UI timeout aborts an uncommitted login; a later Cancel changes nothing; it settles with the timeout's error after the release", async () => {
    const settle = deferred<void>();
    const t = setup("Timed out", (events) => async (_runtime, interaction) => {
      events.push("login");
      interaction.signal!.addEventListener("abort", () =>
        events.push("aborted"),
      );
      await settle.promise;
    });
    setOpenAiProfileLoginTimeoutForTests(20);
    startOpenAiProfileLogin(t.profile.id, t.observer);
    await waitFor(() => (t.events.includes("aborted") ? true : undefined));
    assert.equal(t.state()?.status, "connecting");
    assert.equal(t.state()?.error, undefined);
    cancelOpenAiProfileLogin(t.profile.id);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(t.observer.settles, 0, "no outcome before pi settled");

    settle.reject(new Error("This operation was aborted"));
    await waitFor(() => t.observer.outcome);
    assert.deepEqual(t.observer.outcome, ["error", TIMED_OUT]);
    assert.deepEqual(t.events.slice(-2), ["release hold-1", "settled error"]);
    assert.equal(t.events.filter((e) => e === "aborted").length, 1);
    assert.equal(t.state()?.status, "error");
    assert.equal(t.state()?.error, TIMED_OUT);
  });

  test("AC12: Cancel then the timeout ends cancelled", async () => {
    const settle = deferred<void>();
    const t = setup("Cancel then timeout", (events) => async (_r, i) => {
      events.push("login");
      i.signal!.addEventListener("abort", () => events.push("aborted"));
      await settle.promise;
    });
    setOpenAiProfileLoginTimeoutForTests(40);
    startOpenAiProfileLogin(t.profile.id, t.observer);
    await waitFor(() => (t.events.includes("login") ? true : undefined));
    cancelOpenAiProfileLogin(t.profile.id);
    await new Promise((resolve) => setTimeout(resolve, 80));
    settle.reject(new Error("This operation was aborted"));
    await waitFor(() => t.observer.outcome);
    assert.deepEqual(t.observer.outcome, ["cancelled", undefined]);
    assert.equal(t.state()?.status, "disconnected");
    assert.equal(t.state()?.error, undefined);
  });

  test.each(["cancel", "timeout", "sync failure"] as const)(
    "AC14: after the own commit, a %s neither aborts nor changes the outcome: ready after the settle",
    async (event) => {
      const sync = deferred<void>();
      const t = setup(`Committed ${event}`, commitsThenSyncs(sync.promise));
      if (event === "timeout") setOpenAiProfileLoginTimeoutForTests(20);
      startOpenAiProfileLogin(t.profile.id, t.observer);
      await waitFor(() => (t.state()?.status === "ready" ? true : undefined));
      assert.equal(t.state()?.health.state, "ok");
      if (event === "cancel") cancelOpenAiProfileLogin(t.profile.id);
      if (event === "timeout")
        await new Promise((resolve) => setTimeout(resolve, 50));
      assert.equal(t.events.includes("aborted"), false);
      assert.equal(t.observer.settles, 0);
      // A start meanwhile joins the running operation.
      assert.equal(startOpenAiProfileLogin(t.profile.id), false);
      assert.equal(t.calls(), 1);

      if (event === "sync failure")
        sync.reject(new Error("post-login synchronization failed"));
      else sync.resolve();
      await waitFor(() => t.observer.outcome);
      assert.deepEqual(t.observer.outcome, ["ready", undefined]);
      assert.deepEqual(t.events.slice(-2), ["release hold-1", "settled ready"]);
      assert.equal(t.events.includes("aborted"), false);
      assert.equal(t.state()?.status, "ready");
      assert.equal(t.state()?.error, undefined);
      assert.equal(startOpenAiProfileLogin(t.profile.id), true);
      cancelOpenAiProfileLogin(t.profile.id);
    },
  );

  test("AC14: a login that commits right after the abort still ends ready, with no error", async () => {
    const t = setup(
      "Commit races abort",
      (events) => async (_runtime, interaction, committed, authPath) => {
        events.push("login");
        await new Promise<void>((resolve) =>
          interaction.signal!.addEventListener("abort", () => resolve(), {
            once: true,
          }),
        );
        events.push("aborted");
        writeFileSync(authPath, '{"openai-codex":{}}', { mode: 0o600 });
        committed();
        throw new Error("This operation was aborted");
      },
    );
    startOpenAiProfileLogin(t.profile.id, t.observer);
    await waitFor(() => (t.events.includes("login") ? true : undefined));
    cancelOpenAiProfileLogin(t.profile.id);
    await waitFor(() => t.observer.outcome);
    assert.deepEqual(t.observer.outcome, ["ready", undefined]);
    assert.equal(t.state()?.status, "ready");
    assert.equal(t.state()?.error, undefined);
  });

  test("AC14: a deletion after the commit ends cancelled with the deletion text and removes the directory after the settle", async () => {
    const sync = deferred<void>();
    const t = setup("Deleted after commit", commitsThenSyncs(sync.promise));
    startOpenAiProfileLogin(t.profile.id, t.observer);
    await waitFor(() => (t.state()?.status === "ready" ? true : undefined));
    deleteCredentialProfile(t.profile.id);
    assert.equal(t.events.includes("aborted"), false);
    assert.equal(t.observer.settles, 0);
    // The still-synchronizing login writes into its stale directory.
    mkdirSync(dirname(t.authPath), { recursive: true });
    writeFileSync(t.authPath, '{"openai-codex":{}}');
    sync.resolve();
    await waitFor(() => t.observer.outcome);
    assert.deepEqual(t.observer.outcome, [
      "cancelled",
      "Profile deleted; OpenAI login cancelled.",
    ]);
    assert.deepEqual(t.events.slice(-2), [
      "release hold-1",
      "settled cancelled",
    ]);
    // The commit's own snapshot refresh may still write; it removes it too.
    await waitFor(() => (existsSync(t.root) ? undefined : true));
  });
});

afterEach(() => {
  setOpenAiProfileLoginTimeoutForTests(null);
});

afterAll(() => {
  setOpenAiProfileLoginForTests(null);
  setOpenAiProfileLoginTimeoutForTests(null);
  rmSync(tmp, { recursive: true, force: true });
});
