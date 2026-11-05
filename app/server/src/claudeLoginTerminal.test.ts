import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import type { WebSocket } from "ws";
import { afterAll, afterEach, beforeEach, describe, test, vi } from "vitest";
import { loginStuckText } from "@assistant/shared";

const tmp = mkdtempSync(join(tmpdir(), "claude-login-terminal-test-"));
const previousDataDir = process.env.DATA_DIR;
const previousHome = process.env.HOME;
const previousNodeEnv = process.env.NODE_ENV;
process.env.DATA_DIR = join(tmp, "data");
process.env.HOME = join(tmp, "home");

const profiles = await import("./credentialProfiles.ts");
const terminal = await import("./claudeLoginTerminal.ts");
const { setChildProcessEnvOverlay } = await import("./subprocessEnv.ts");
const health = await import("./accountHealth.ts");
const loginHolds = await import("./loginHolds.ts");
const { GATEWAY_LOGIN_UNAVAILABLE_TEXT, LoginHeldError } =
  await import("./gatewayLink.ts");
const { deferred, fakeLoginHoldLink } =
  await import("./test/fakeLoginHoldLink.ts");
health.initializeAccountHealth({
  profiles: profiles.listCredentialProfiles,
  hasCredential: profiles.credentialProfileHasCredential,
  broadcast: () => {},
  push: async () => {},
  subscribeChanges: profiles.subscribeCredentialProfileChanges,
  subscribeDeleted: profiles.subscribeCredentialProfileDeleted,
});

class FakeChild extends EventEmitter {
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
  killedWith: NodeJS.Signals[] = [];
  kill(signal: NodeJS.Signals = "SIGTERM") {
    this.killedWith.push(signal);
    return true;
  }
}

class FakeSocket extends EventEmitter {
  readyState = 1;
  sent: unknown[] = [];
  // A capture record: it stores the arguments `close` was called with, so an
  // argument that WAS undefined has to be storable as undefined.
  closed?: { code?: number | undefined; reason?: string | undefined };
  send(value: string) {
    this.sent.push(JSON.parse(value));
  }
  close(code?: number, reason?: string) {
    this.closed = { code, reason };
    this.readyState = 3;
    this.emit("close");
  }
}

function request(profileId: string) {
  return {
    url: `/ws/claude-login?profileId=${encodeURIComponent(profileId)}`,
    headers: { host: "localhost" },
  } as never;
}

function childProcess(child: FakeChild): ChildProcessWithoutNullStreams {
  return child as unknown as ChildProcessWithoutNullStreams;
}

beforeEach(() => {
  rmSync(process.env.DATA_DIR!, { recursive: true, force: true });
  rmSync(process.env.HOME!, { recursive: true, force: true });
  profiles.ensureDefaultPiProfile();
});

afterEach(() => {
  terminal.stopClaudeLoginTerminals();
  terminal.setClaudeLoginSpawnForTests(null);
  terminal.setClaudeLoginTimeoutForTests(null);
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.ASSISTANT_TOKEN;
});

afterAll(() => {
  if (previousDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = previousDataDir;
  if (previousHome === undefined) delete process.env.HOME;
  else process.env.HOME = previousHome;
  if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = previousNodeEnv;
  rmSync(tmp, { recursive: true, force: true });
});

test("production resolves the native CLI bundled with the Agent SDK", () => {
  process.env.NODE_ENV = "production";
  try {
    const path = terminal.bundledClaudeCliPath();
    assert.equal(existsSync(path), true);
    assert.match(path, /claude-agent-sdk-.*\/claude(?:\.exe)?$/);
  } finally {
    if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousNodeEnv;
  }
});

test("streams the official profile-isolated CLI flow and never echoes the submitted authorization code", () => {
  const profile = profiles.createCredentialProfile({
    name: "Mobile Claude",
    provider: "claude",
  });
  const child = new FakeChild();
  // A capture record — see FakeSocket.closed.
  let invocation:
    | {
        executable: string;
        args: string[];
        env?: NodeJS.ProcessEnv | undefined;
      }
    | undefined;
  process.env.ANTHROPIC_API_KEY = "ambient-secret";
  process.env.ASSISTANT_TOKEN = "app-secret";
  terminal.setClaudeLoginSpawnForTests((executable, args, options) => {
    invocation = { executable, args, env: options.env };
    return childProcess(child);
  });
  const socket = new FakeSocket();
  setChildProcessEnvOverlay({ HTTPS_PROXY: "http://127.0.0.1:9/login" });
  try {
    terminal.attachClaudeLoginSocket(
      socket as unknown as WebSocket,
      request(profile.id),
    );
  } finally {
    setChildProcessEnvOverlay(null);
  }
  assert.equal(invocation?.env?.HTTPS_PROXY, "http://127.0.0.1:9/login");

  assert.deepEqual(invocation?.args, ["auth", "login", "--claudeai"]);
  assert.equal(
    invocation?.env?.CLAUDE_CONFIG_DIR,
    profiles.claudeConfigDir(profile.id),
  );
  assert.equal(invocation?.env?.ANTHROPIC_API_KEY, undefined);
  assert.equal(invocation?.env?.ASSISTANT_TOKEN, undefined);
  assert.match(String(invocation?.executable), /claude/);
  assert.equal((socket.sent[0] as { type?: string }).type, "snapshot");

  const loginUrl = "https://claude.com/cai/oauth/authorize?state=short-lived";
  child.stdout.write(`Open ${loginUrl}\nPaste code here > `);
  assert.match(
    JSON.stringify(socket.sent),
    /claude\.com\/cai\/oauth\/authorize/,
  );

  let stdin = "";
  child.stdin.on("data", (chunk) => {
    stdin += chunk.toString();
  });
  const authorizationCode = "secret-authorization-code";
  socket.emit(
    "message",
    Buffer.from(JSON.stringify({ type: "input", data: authorizationCode })),
  );
  assert.equal(stdin, `${authorizationCode}\n`);
  assert.doesNotMatch(
    JSON.stringify(socket.sent),
    new RegExp(authorizationCode),
  );

  mkdirSync(profiles.claudeConfigDir(profile.id), { recursive: true });
  writeFileSync(
    join(profiles.claudeConfigDir(profile.id), ".credentials.json"),
    '{"oauth":"provider-owned"}',
  );
  child.emit("close", 0, null);
  assert.equal((socket.sent.at(-1) as { status?: string }).status, "ready");
  assert.equal(
    profiles.listCredentialProfiles().find((item) => item.id === profile.id)
      ?.status,
    "ready",
  );
});

test("keeps one active process per profile across browser reconnects and supports cancellation", () => {
  const profile = profiles.createCredentialProfile({
    name: "Mobile Claude",
    provider: "claude",
  });
  const child = new FakeChild();
  let spawns = 0;
  terminal.setClaudeLoginSpawnForTests(() => {
    spawns += 1;
    return childProcess(child);
  });
  const first = new FakeSocket();
  const second = new FakeSocket();
  terminal.attachClaudeLoginSocket(
    first as unknown as WebSocket,
    request(profile.id),
  );
  terminal.attachClaudeLoginSocket(
    second as unknown as WebSocket,
    request(profile.id),
  );
  assert.equal(spawns, 1);

  second.emit("message", Buffer.from("null"));
  second.emit("message", Buffer.from(JSON.stringify({ type: "cancel" })));
  // The child obeys the SIGTERM; the run ends when it closes.
  child.emit("close", null, "SIGTERM");
  assert.deepEqual(child.killedWith, ["SIGTERM"]);
  assert.equal((first.sent.at(-1) as { status?: string }).status, "cancelled");
  assert.equal((second.sent.at(-1) as { status?: string }).status, "cancelled");
});

test.each(["cancelled", "error"] as const)(
  "a fresh Claude login keeps card health but no app alert on start and %s",
  (outcome) => {
    const profile = profiles.createCredentialProfile({
      name: "Fresh",
      provider: "claude",
    });
    const child = new FakeChild();
    terminal.setClaudeLoginSpawnForTests(() => childProcess(child));
    const socket = new FakeSocket();
    terminal.attachClaudeLoginSocket(
      socket as unknown as WebSocket,
      request(profile.id),
    );
    let current = profiles.credentialProfileSummaryById(profile.id)!;
    assert.equal(current.status, "connecting");
    assert.equal(current.health.state, "needs-login");
    if (outcome === "cancelled") {
      socket.emit("message", Buffer.from(JSON.stringify({ type: "cancel" })));
      // The child obeys the SIGTERM; the run ends when it closes.
      child.emit("close", null, "SIGTERM");
    } else child.emit("close", 1, null);
    current = profiles.credentialProfileSummaryById(profile.id)!;
    assert.equal(
      current.status,
      outcome === "cancelled" ? "disconnected" : "error",
    );
    assert.equal(current.health.state, "needs-login");
    const alerts: string[] = [];
    health.sendAccountLoginAlertsTo({
      send: (message) => {
        if (message.type === "accountLoginAlerts")
          alerts.push(...message.accounts.map((account) => account.profileId));
      },
    });
    assert.equal(alerts.includes(profile.id), false);
  },
);

test.each(["cancelled", "error", "ready"] as const)(
  "a Claude re-login with an old credential clears health only on genuine completion, not %s cleanup",
  (outcome) => {
    const profile = profiles.createCredentialProfile({
      name: "Rejected old login",
      provider: "claude",
    });
    writeFileSync(
      join(profiles.claudeConfigDir(profile.id), ".credentials.json"),
      '{"oauth":"old"}',
    );
    health.reportAccountRunFailure(
      profile.id,
      { kind: "auth", loginDeath: true },
      "claude-sdk",
    );
    const child = new FakeChild();
    terminal.setClaudeLoginSpawnForTests(() => childProcess(child));
    const socket = new FakeSocket();
    terminal.attachClaudeLoginSocket(
      socket as unknown as WebSocket,
      request(profile.id),
    );
    assert.equal(
      health.readAccountHealth(profile.id, true).state,
      "needs-login",
    );
    if (outcome === "cancelled") {
      socket.emit("message", Buffer.from(JSON.stringify({ type: "cancel" })));
      // The child obeys the SIGTERM; the run ends when it closes.
      child.emit("close", null, "SIGTERM");
    } else child.emit("close", outcome === "ready" ? 0 : 1, null);
    assert.equal(
      health.readAccountHealth(profile.id, true).state,
      outcome === "ready" ? "ok" : "needs-login",
    );
  },
);

test("profile deletion cancels an in-flight login before its private directory is removed", () => {
  const profile = profiles.createCredentialProfile({
    name: "Delete me",
    provider: "claude",
  });
  const child = new FakeChild();
  terminal.setClaudeLoginSpawnForTests(() => childProcess(child));
  terminal.attachClaudeLoginSocket(
    new FakeSocket() as unknown as WebSocket,
    request(profile.id),
  );

  profiles.deleteCredentialProfile(profile.id);
  assert.deepEqual(child.killedWith, ["SIGKILL"]);
  assert.equal(profiles.credentialProfileById(profile.id), undefined);
});

test("rejects a non-Claude profile without spawning a process", () => {
  let spawned = false;
  terminal.setClaudeLoginSpawnForTests(() => {
    spawned = true;
    return childProcess(new FakeChild());
  });
  const socket = new FakeSocket();
  terminal.attachClaudeLoginSocket(
    socket as unknown as WebSocket,
    request("default"),
  );
  assert.equal(spawned, false);
  assert.equal(socket.closed?.code, 1008);
  assert.equal((socket.sent[0] as { status?: string }).status, "error");
});

// G5b: the login hold around the child, and the one stop path (AC3-AC6, AC8,
// AC14). Every child is a fake that closes only when the test says so, which
// is how a child that ignores SIGTERM behaves.

/** A pasted-code sentinel and a fake token; neither may reach a log or a viewer. */
const PASTED = "code-SENTINEL-1367";
const FAKE_TOKEN = "fake-claude-token-1367";

class HoldChild extends EventEmitter {
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
  killedWith: NodeJS.Signals[] = [];
  written = "";
  constructor(readonly pid: number | undefined) {
    super();
    this.stdin.on("data", (chunk: Buffer) => {
      this.written += chunk.toString();
    });
  }
  kill(signal: NodeJS.Signals = "SIGTERM") {
    this.killedWith.push(signal);
    return true;
  }
  close(code: number | null, signal: NodeJS.Signals | null = null) {
    this.emit("close", code, signal);
  }
}

/** A viewer whose statuses also land in `events`, after the link's calls. */
class EventSocket extends FakeSocket {
  constructor(private readonly events: string[]) {
    super();
  }
  override send(value: string) {
    super.send(value);
    const message = JSON.parse(value) as { type: string; status?: string };
    if (message.type === "status") this.events.push(`status ${message.status}`);
  }
}

const children: HoldChild[] = [];
let logged: string[] = [];

function holdSetup(options: { pid?: number | undefined; link?: boolean } = {}) {
  const profile = profiles.createCredentialProfile({
    name: "Held Claude",
    provider: "claude",
  });
  const events: string[] = [];
  const fake = fakeLoginHoldLink(events);
  loginHolds.setLoginHoldLinkForTests(
    options.link === false ? undefined : fake.link,
  );
  const spawned: HoldChild[] = [];
  let env: NodeJS.ProcessEnv | undefined;
  terminal.setClaudeLoginSpawnForTests((_executable, _args, spawnOptions) => {
    events.push("spawn");
    env = spawnOptions.env;
    const child = new HoldChild("pid" in options ? options.pid : 4321);
    spawned.push(child);
    children.push(child);
    return childProcess(child as unknown as FakeChild);
  });
  const attach = () => {
    const socket = new EventSocket(events);
    terminal.attachClaudeLoginSocket(
      socket as unknown as WebSocket,
      request(profile.id),
    );
    return socket;
  };
  return { profile, events, fake, spawned, attach, env: () => env };
}

const input = (socket: FakeSocket, data: string) =>
  socket.emit("message", Buffer.from(JSON.stringify({ type: "input", data })));
const cancel = (socket: FakeSocket) =>
  socket.emit("message", Buffer.from(JSON.stringify({ type: "cancel" })));
const lastStatus = (socket: FakeSocket) =>
  socket.sent
    .filter(
      (
        message,
      ): message is { type: "status"; status: string; error?: string } =>
        (message as { type?: string }).type === "status",
    )
    .at(-1);
/** Lets the promise reactions queued so far run. */
const ticks = async () => {
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
};

describe("G5b: the login hold", () => {
  beforeEach(() => {
    logged = [];
    for (const method of ["log", "info", "warn", "error"] as const)
      vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
        logged.push(args.map(String).join(" "));
      });
  });

  afterEach(() => {
    // AC14: no pasted code, token or hold id reaches a log line.
    for (const line of logged)
      for (const value of [PASTED, FAKE_TOKEN, "hold-1", "hold-2"])
        assert.ok(!line.includes(value), `a log line leaks: ${line}`);
    vi.restoreAllMocks();
    vi.useRealTimers();
    for (const child of children.splice(0))
      if (child.listenerCount("close") > 0) child.close(null, "SIGKILL");
    loginHolds.setLoginHoldLinkForTests(null);
  });

  test("G5b AC3: no spawn before the hold; the writer is named right after it; input waits for the acknowledgement, in order", async () => {
    const setup = holdSetup();
    const acquired = deferred<string>();
    const registered = deferred<void>();
    setup.fake.acquire = () => acquired.promise;
    setup.fake.register = () => registered.promise;
    const socket = setup.attach();
    assert.deepEqual(setup.events, [`acquire ${setup.profile.id}`]);
    input(socket, "first");
    input(socket, PASTED);
    acquired.resolve("hold-1");
    await ticks();
    assert.deepEqual(setup.events.slice(1), ["spawn", "writer hold-1 4321"]);
    const [child] = setup.spawned;
    input(socket, "third");
    await ticks();
    assert.equal(child!.written, "", "nothing before the acknowledgement");
    registered.resolve();
    await ticks();
    assert.equal(child!.written, `first\n${PASTED}\nthird\n`);
    input(socket, "fourth");
    assert.equal(child!.written, `first\n${PASTED}\nthird\nfourth\n`);
    // AC14: the pasted code never reaches a viewer.
    assert.doesNotMatch(JSON.stringify(socket.sent), new RegExp(PASTED));
  });

  test.each(["cancel", "timeout"] as const)(
    "G5b AC3: input queued, then a %s, then the acknowledgement writes nothing; later input is ignored",
    async (how) => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      terminal.setClaudeLoginTimeoutForTests(1_000);
      const setup = holdSetup();
      const registered = deferred<void>();
      setup.fake.register = () => registered.promise;
      const socket = setup.attach();
      await ticks();
      const [child] = setup.spawned;
      input(socket, PASTED);
      if (how === "cancel") cancel(socket);
      else vi.advanceTimersByTime(1_000);
      assert.deepEqual(child!.killedWith, ["SIGTERM"]);
      input(socket, "after the stop");
      registered.resolve();
      await ticks();
      assert.equal(child!.written, "");
      child!.close(null, "SIGTERM");
      assert.equal(child!.written, "");
      assert.equal(
        lastStatus(socket)?.status,
        how === "cancel" ? "cancelled" : "error",
      );
    },
  );

  test("G5b AC3: a child closed before the acknowledgement gets nothing from it", async () => {
    const setup = holdSetup();
    const registered = deferred<void>();
    setup.fake.register = () => registered.promise;
    const socket = setup.attach();
    await ticks();
    const [child] = setup.spawned;
    input(socket, PASTED);
    child!.close(1);
    assert.deepEqual(lastStatus(socket), {
      type: "status",
      status: "error",
      error: "Claude login exited with code 1.",
    });
    registered.resolve();
    await ticks();
    assert.equal(child!.written, "");
    assert.deepEqual(setup.events.slice(-2), [
      "release hold-1",
      "status error",
    ]);
  });

  test("G5b AC3/AC5: a failed registration writes nothing, sends SIGTERM and releases only after close", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const setup = holdSetup();
    setup.fake.register = () =>
      Promise.reject(new Error(GATEWAY_LOGIN_UNAVAILABLE_TEXT));
    const socket = setup.attach();
    input(socket, PASTED);
    await ticks();
    const [child] = setup.spawned;
    assert.deepEqual(child!.killedWith, ["SIGTERM"]);
    assert.equal(child!.written, "");
    assert.ok(!setup.events.includes("release hold-1"));
    assert.equal(lastStatus(socket), undefined);
    vi.advanceTimersByTime(5_000);
    assert.deepEqual(child!.killedWith, ["SIGTERM", "SIGKILL"]);
    child!.close(null, "SIGKILL");
    assert.deepEqual(setup.events.slice(-2), [
      "release hold-1",
      "status error",
    ]);
    assert.equal(lastStatus(socket)?.error, GATEWAY_LOGIN_UNAVAILABLE_TEXT);
  });

  test("G5b AC3: a second viewer during the acquire joins the one run: one acquire, one spawn", async () => {
    const setup = holdSetup();
    const acquired = deferred<string>();
    setup.fake.acquire = () => acquired.promise;
    const first = setup.attach();
    const second = setup.attach();
    acquired.resolve("hold-1");
    await ticks();
    assert.equal(
      setup.events.filter((event) => event.startsWith("acquire")).length,
      1,
    );
    assert.equal(setup.spawned.length, 1);
    assert.equal((second.sent[0] as { type?: string }).type, "snapshot");
    assert.equal((first.sent[0] as { type?: string }).type, "snapshot");
  });

  test("G5b AC4: the held child's environment pins BROWSER=false and NO_COLOR=1", async () => {
    const setup = holdSetup();
    setup.attach();
    await ticks();
    assert.equal(setup.env()?.BROWSER, "false");
    assert.equal(setup.env()?.NO_COLOR, "1");
  });

  const STOPS = [
    ["timeout", "SIGTERM"],
    ["cancel", "SIGTERM"],
    ["server stop", "SIGTERM"],
    ["stdin error", "SIGTERM"],
    ["deletion", "SIGKILL"],
    ["Clear", "SIGKILL"],
  ] as const;

  test.each(STOPS)(
    "G5b AC5: a %s signals a SIGTERM-ignoring child (%s) and neither releases nor finishes before its close",
    async (how, first) => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      terminal.setClaudeLoginTimeoutForTests(1_000);
      const setup = holdSetup();
      const socket = setup.attach();
      await ticks();
      const [child] = setup.spawned;
      if (how === "timeout") vi.advanceTimersByTime(1_000);
      else if (how === "cancel") cancel(socket);
      else if (how === "server stop") terminal.stopClaudeLoginTerminals();
      else if (how === "stdin error")
        child!.stdin.emit("error", new Error("EPIPE"));
      else if (how === "deletion")
        profiles.deleteCredentialProfile(setup.profile.id);
      else {
        setup.fake.status(setup.profile.id, {
          loginStuck: true,
          holdId: "hold-1",
        });
        await loginHolds.clearUnfinishedLogin(setup.profile);
        assert.ok(!setup.events.includes("force hold-1"), "no force release");
      }
      assert.deepEqual(child!.killedWith, [first]);
      if (how === "server stop") assert.equal(socket.closed?.code, 1012);
      vi.advanceTimersByTime(4_999);
      assert.deepEqual(child!.killedWith, [first]);
      vi.advanceTimersByTime(1);
      assert.deepEqual(
        child!.killedWith,
        first === "SIGTERM" ? ["SIGTERM", "SIGKILL"] : ["SIGKILL"],
      );
      assert.ok(!setup.events.includes("release hold-1"), "no release yet");
      assert.ok(!setup.events.some((event) => event.startsWith("status")));
      child!.close(null, "SIGKILL");
      const released = setup.events.indexOf("release hold-1");
      assert.ok(released > 0, "released on close");
      if (how !== "server stop")
        assert.equal(
          setup.events[released + 1],
          "status " +
            (how === "timeout" || how === "stdin error"
              ? "error"
              : "cancelled"),
        );
    },
  );

  test("G5b AC5: a close before the 5 s clears the SIGKILL timer", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const setup = holdSetup();
    const socket = setup.attach();
    await ticks();
    const [child] = setup.spawned;
    cancel(socket);
    vi.advanceTimersByTime(1_000);
    child!.close(null, "SIGTERM");
    vi.advanceTimersByTime(10_000);
    assert.deepEqual(child!.killedWith, ["SIGTERM"]);
    assert.equal(lastStatus(socket)?.status, "cancelled");
  });

  test("G5b AC5: a spawn with no pid releases at once and finishes on its error", async () => {
    const setup = holdSetup({ pid: undefined });
    const socket = setup.attach();
    await ticks();
    assert.deepEqual(setup.events.slice(1), ["spawn", "release hold-1"]);
    setup.spawned[0]!.emit("error", new Error("spawn claude ENOENT"));
    assert.equal(
      lastStatus(socket)?.error,
      "Could not start the official Claude CLI: spawn claude ENOENT",
    );
  });

  test("G5b AC5: the exit hook sends SIGKILL only to unclosed children, and is registered once", async () => {
    assert.equal(
      process
        .listeners("exit")
        .filter(
          (listener) => listener === terminal.killUnclosedClaudeLoginChildren,
        ).length,
      1,
    );
    const open = holdSetup();
    open.attach();
    await ticks();
    const done = holdSetup();
    done.attach();
    await ticks();
    done.spawned[0]!.close(1);
    terminal.killUnclosedClaudeLoginChildren();
    assert.deepEqual(open.spawned[0]!.killedWith, ["SIGKILL"]);
    assert.deepEqual(done.spawned[0]!.killedWith, []);
  });

  test("G5b AC6: a cancel during the acquire spawns nothing, releases once acquired and ends cancelled", async () => {
    const setup = holdSetup();
    const acquired = deferred<string>();
    setup.fake.acquire = () => acquired.promise;
    const socket = setup.attach();
    cancel(socket);
    assert.equal(lastStatus(socket), undefined);
    acquired.resolve("hold-1");
    await ticks();
    assert.equal(setup.spawned.length, 0);
    assert.deepEqual(setup.events.slice(1), [
      "release hold-1",
      "status cancelled",
    ]);
  });

  test.each([
    [
      "login_stuck with a hold id",
      new LoginHeldError("login_stuck", "hold-old"),
      "stuck",
    ],
    [
      "login_stuck without one",
      new LoginHeldError("login_stuck", undefined),
      "unavailable",
    ],
    [
      "hold_exists",
      new LoginHeldError("hold_exists", "hold-old"),
      "unavailable",
    ],
    [
      "an unreachable gateway",
      new Error(GATEWAY_LOGIN_UNAVAILABLE_TEXT),
      "unavailable",
    ],
  ] as const)(
    "G5b AC6: an acquire refused with %s spawns nothing and shows its text",
    async (_how, refusal, shown) => {
      const setup = holdSetup();
      setup.fake.acquire = () => Promise.reject(refusal);
      const socket = setup.attach();
      await ticks();
      assert.equal(setup.spawned.length, 0);
      assert.equal(
        lastStatus(socket)?.error,
        shown === "stuck"
          ? loginStuckText("Held Claude")
          : GATEWAY_LOGIN_UNAVAILABLE_TEXT,
      );
      assert.equal(loginHolds.loginStuckOf(setup.profile), shown === "stuck");
    },
  );

  test.each(["a Clear", "a status ending the hold"] as const)(
    "G5b AC11/AC12: a stuck refusal's text leaves the account with %s",
    async (how) => {
      const setup = holdSetup();
      setup.fake.acquire = () =>
        Promise.reject(new LoginHeldError("login_stuck", "hold-old"));
      const socket = setup.attach();
      await ticks();
      assert.equal(lastStatus(socket)?.error, loginStuckText("Held Claude"));
      const stuck = profiles.credentialProfileSummaryById(setup.profile.id);
      assert.equal(stuck?.loginStuck, true);
      assert.equal(stuck?.error, undefined, "the flag alone shows U7's text");
      assert.notEqual(stuck?.status, "connecting");
      if (how === "a Clear")
        await loginHolds.clearUnfinishedProfileLogin(setup.profile.id);
      else
        setup.fake.status(setup.profile.id, {
          loginStuck: false,
          holdId: "hold-old",
        });
      const cleared = profiles.credentialProfileSummaryById(setup.profile.id);
      assert.equal(cleared?.loginStuck, undefined);
      assert.equal(cleared?.error, undefined);
    },
  );

  test("G5b AC6: an unavailable refusal's text stays on the account until the next login", async () => {
    const setup = holdSetup();
    setup.fake.acquire = () =>
      Promise.reject(new Error(GATEWAY_LOGIN_UNAVAILABLE_TEXT));
    setup.attach();
    await ticks();
    const summary = profiles.credentialProfileSummaryById(setup.profile.id);
    assert.equal(summary?.status, "error");
    assert.equal(summary?.error, GATEWAY_LOGIN_UNAVAILABLE_TEXT);
    assert.equal(summary?.loginStuck, undefined);
  });

  test.each(["cancel", "timeout"] as const)(
    "G5b AC8: with the switch off a %s takes no hold and finishes on close, SIGKILL after 5 s, today's text",
    async (how) => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      terminal.setClaudeLoginTimeoutForTests(1_000);
      const setup = holdSetup({ link: false });
      const socket = setup.attach();
      assert.equal(setup.spawned.length, 1, "spawned at once, unheld");
      const [child] = setup.spawned;
      input(socket, PASTED);
      assert.equal(child!.written, `${PASTED}\n`);
      if (how === "cancel") cancel(socket);
      else vi.advanceTimersByTime(1_000);
      assert.equal(lastStatus(socket), undefined);
      vi.advanceTimersByTime(5_000);
      assert.deepEqual(child!.killedWith, ["SIGTERM", "SIGKILL"]);
      child!.close(null, "SIGKILL");
      assert.deepEqual(
        lastStatus(socket),
        how === "cancel"
          ? { type: "status", status: "cancelled" }
          : {
              type: "status",
              status: "error",
              error:
                "Claude login timed out after 10 minutes. Start it again to retry.",
            },
      );
      if (how === "cancel")
        assert.match(
          JSON.stringify(socket.sent),
          /\\nClaude login cancelled\.\\n/,
        );
      assert.deepEqual(setup.events, [
        "spawn",
        `status ${how === "cancel" ? "cancelled" : "error"}`,
      ]);
      assert.equal(loginHolds.loginStuckOf(setup.profile), false);
    },
  );
});
