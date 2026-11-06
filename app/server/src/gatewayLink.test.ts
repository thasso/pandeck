/**
 * The server's link to the in-process credential gateway (`gatewayLink.ts`):
 * its boot order, profile changes reaching the gateway in order, an
 * unavailable gateway failing grants with U7's text, and the login hold calls
 * across link lifetimes, and a stuck hold's Clear through the login-hold seam
 * (G5b AC9 (c), AC10). Each OpenAI-compatible account's endpoint and key are
 * pushed per account, in order with its profile changes (T1373 AC8, AC13,
 * AC14, AC16). Fake profiles under the setup's temp `DATA_DIR` and a temp
 * `HOME`; a fake TLS upstream stands in for ChatGPT and fake loopback
 * endpoints for compatible servers. Every hold's owner is this process, so its
 * holds are observed through a fake probe.
 */
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import https from "node:https";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, test, vi } from "vitest";

const home = mkdtempSync(join(tmpdir(), "gateway-link-home-"));
process.env.HOME = home;

const profiles = await import("./credentialProfiles.ts");
const {
  openAiCompatibleEndpointPath,
  readOpenAiCompatibleEndpoint,
  writeOpenAiCompatibleEndpoint,
} = await import("./openAiCompatibleAccounts.ts");
const config = await import("./config.ts");
const { DEFAULT_WORKER_ID } = await import("./workers/placement.ts");
const {
  GATEWAY_LOGIN_UNAVAILABLE_TEXT,
  GATEWAY_UNAVAILABLE_TEXT,
  LoginHeldError,
  installedGatewayLink,
  serverGatewayAccess,
  startGatewayLink,
} = await import("./gatewayLink.ts");
const { startGatewayLinkForTests } = await import("./test/gatewayLink.ts");
const {
  COMPAT_KEY_A,
  COMPAT_KEY_B,
  COMPAT_KEY_C,
  endChild,
  fakeProcesses,
  spawnIdleChild,
  startFakeCompatEndpoint,
  startFakeUpstreams,
} = await import("./test/gatewayFixtures.ts");
const loginHolds = await import("./loginHolds.ts");
const { processStartTime } = await import("./gateway/processIdentity.ts");
const { startGateway } = await import("./gateway/gateway.ts");
const { refusalText } = await import("./gateway/refusals.ts");
const {
  CONTROL_METHODS,
  GATEWAY_CONTROL_PROTOCOL,
  decodeLeaseGranted,
  encodeControlRequest,
} = await import("./gateway/controlMethods.ts");
const { WorkerConnection } = await import("./workerProtocol/connection.ts");
const { createInProcessTransport } =
  await import("./workerProtocol/inProcessTransport.ts");
const { loadOrCreateCa, issueLeafCertificate } =
  await import("./packageProxy/certificateAuthority.ts");
const { analyzeProviderError, isLoginDeath, runFailureFacts } =
  await import("./providerErrors.ts");
type GatewayLink = import("./gatewayLink.ts").GatewayLink;
type GatewayLinkOptions = import("./gatewayLink.ts").GatewayLinkOptions;
type GatewayOptions = import("./gateway/gateway.ts").GatewayOptions;
type FakeCompatEndpoint =
  import("./test/gatewayFixtures.ts").FakeCompatEndpoint;

// Synthetic fixture values; none is a real credential.
const FAKE_ACCESS = "fake-codex-access";
const FAKE_REFRESH = "fake-refresh";
const FAKE_ACCOUNT = "acct-test";
const FAKE_CLAUDE_ACCESS = "fake-link-claude-access";
const FAKE_CLAUDE_REFRESH = "fake-link-claude-refresh";

let upstream: https.Server;
let upstreamPort = 0;
const seen: {
  authorization: string | undefined;
  account: string | undefined;
}[] = [];
let ca: string;

beforeAll(async () => {
  const pair = await loadOrCreateCa();
  ca = pair.certPem;
  const leaf = issueLeafCertificate(pair, "chatgpt.com");
  upstream = https.createServer(
    { key: leaf.keyPem, cert: leaf.certPem },
    (req, res) => {
      req.resume();
      req.on("end", () => {
        seen.push({
          authorization: req.headers.authorization,
          account: req.headers["chatgpt-account-id"] as string | undefined,
        });
        res.writeHead(200, { "content-type": "application/json" });
        res.end('{"ok":true}');
      });
    },
  );
  await new Promise<void>((resolve) =>
    upstream.listen(0, "127.0.0.1", () => resolve()),
  );
  upstreamPort = (upstream.address() as net.AddressInfo).port;
});

const links: GatewayLink[] = [];
const scratch: string[] = [];
let lines: string[] = [];

afterEach(async () => {
  vi.useRealTimers();
  while (links.length) await links.pop()!.close();
  for (const dir of scratch.splice(0))
    rmSync(dir, { recursive: true, force: true });
  upstream.closeAllConnections();
  seen.length = 0;
  lines = [];
});

afterAll(async () => {
  await new Promise<void>((resolve) => upstream.close(() => resolve()));
  rmSync(home, { recursive: true, force: true });
});

function stateDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "gateway-link-state-"));
  scratch.push(dir);
  return join(dir, "gateway");
}

function link(options: Partial<GatewayLinkOptions> = {}): GatewayLink {
  const started = startGatewayLink({
    stateDir: stateDir(),
    port: 0,
    log: (line) => lines.push(line),
    upstreams: {
      "openai-codex": {
        connect: { host: "127.0.0.1", port: upstreamPort },
        ca,
      },
    },
    // A closed loopback port: no renewal reaches the real token endpoint.
    claudeTokenEndpoint: { connect: { host: "127.0.0.1", port: 9 } },
    ...options,
  });
  links.push(started);
  return started;
}

function codexProfile(name: string): string {
  const id = profiles.createCredentialProfile({
    provider: "openai-codex",
    name,
  }).id;
  writeFileSync(
    join(profiles.piAgentDir(id), "auth.json"),
    JSON.stringify({
      "openai-codex": {
        type: "oauth",
        access: FAKE_ACCESS,
        refresh: `${FAKE_REFRESH}`,
        expires: Date.now() + 86_400_000,
        accountId: FAKE_ACCOUNT,
      },
    }),
  );
  return id;
}

async function codexRequest(
  gateway: { url: string },
  token: string,
): Promise<{ status: number; text: string }> {
  const response = await fetch(
    `${gateway.url}/chatgpt/backend-api/codex/responses`,
    {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
      body: "{}",
    },
  );
  return { status: response.status, text: await response.text() };
}

function registry(dir: string): unknown[] {
  return (
    JSON.parse(readFileSync(join(dir, "profiles.json"), "utf8")) as {
      profiles: unknown[];
    }
  ).profiles;
}

async function until(check: () => boolean): Promise<void> {
  for (let i = 0; i < 500; i += 1) {
    if (check()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 2));
  }
  throw new Error(`condition was not reached:\n${lines.join("\n")}`);
}

/** Field 22 of `/proc/self/stat`, counted after the last `)`. */
function ownStartTime(): string {
  const stat = readFileSync("/proc/self/stat", "utf8");
  return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19]!;
}

test("the switch is off unless ASSISTANT_GATEWAY=1, and the port defaults to 8788", async () => {
  assert.equal(process.env.ASSISTANT_GATEWAY, undefined);
  assert.equal(config.GATEWAY_ENABLED, false);
  assert.equal(config.GATEWAY_PORT, 8788);
  vi.resetModules();
  process.env.ASSISTANT_GATEWAY = "1";
  process.env.ASSISTANT_GATEWAY_PORT = "8790";
  try {
    const on = await import("./config.ts");
    assert.equal(on.GATEWAY_ENABLED, true);
    assert.equal(on.GATEWAY_PORT, 8790);
  } finally {
    delete process.env.ASSISTANT_GATEWAY;
    delete process.env.ASSISTANT_GATEWAY_PORT;
    vi.resetModules();
  }
  // The link's in-process Worker is the one `placement.ts` names.
  assert.equal(DEFAULT_WORKER_ID, "local");
});

test("boot: hello as this process, sync every profile, then reconcile the in-process Worker before the first grant", async () => {
  const dir = stateDir();
  const defaultTokenFile = join(
    profiles.piAgentDir(profiles.DEFAULT_OPENAI_PROFILE_ID),
    "auth.json",
  );
  // An earlier boot's leases: an engine of the in-process Worker, one of
  // another Worker, and a server lease.
  const earlier = await startGateway({
    stateDir: dir,
    port: 0,
    log: (line) => lines.push(line),
  });
  const [dialEnd, gatewayEnd] = createInProcessTransport();
  earlier.attachControl(gatewayEnd);
  const control = new WorkerConnection(dialEnd, {
    handshake: { role: "worker", workerId: "pandeck-server" },
    protocol: GATEWAY_CONTROL_PROTOCOL,
  });
  const send = (method: string, request: object) =>
    control.request(
      method,
      encodeControlRequest(
        request as Parameters<typeof encodeControlRequest>[0],
      ),
    );
  await send(CONTROL_METHODS.hello, {
    serverBootId: "earlier-boot",
    pid: 1,
    startTime: null,
  });
  await send(CONTROL_METHODS.syncProfiles, {
    profiles: [
      {
        id: profiles.DEFAULT_OPENAI_PROFILE_ID,
        provider: "openai-codex",
        name: "Default",
        enabled: true,
        tokenFile: defaultTokenFile,
      },
    ],
  });
  const grant = async (request: object) =>
    decodeLeaseGranted(await send(CONTROL_METHODS.grant, request)).leaseId;
  const oldEngine = await grant({
    kind: "engine",
    workerId: "local",
    sessionId: "old-session",
    profileId: profiles.DEFAULT_OPENAI_PROFILE_ID,
  });
  const otherWorker = await grant({
    kind: "engine",
    workerId: "elsewhere",
    sessionId: "remote-session",
    profileId: profiles.DEFAULT_OPENAI_PROFILE_ID,
  });
  const oldServer = await grant({
    kind: "server",
    profileId: profiles.DEFAULT_OPENAI_PROFILE_ID,
  });
  await earlier.close();

  const booted = link({ stateDir: dir });
  // Called before ready: it waits for the reconcile, which leaves it alone.
  const early = booted.grantEngineLease({
    workerId: undefined,
    sessionId: "this-boot",
    profileId: profiles.DEFAULT_OPENAI_PROFILE_ID,
  });
  assert.equal(await booted.ready, true, lines.join("\n"));
  const granted = await early;
  const records = new Map(
    booted.gateway!.leases.records().map((record) => [record.leaseId, record]),
  );
  assert.equal(records.get(oldEngine)?.revoked, "session-ended");
  assert.equal(records.get(oldServer)?.revoked, "session-ended");
  assert.equal(records.get(otherWorker)?.revoked, undefined);
  const fresh = records.get(granted.leaseId);
  assert.equal(fresh?.revoked, undefined);
  assert.deepEqual(fresh?.owner, { workerId: "local", sessionId: "this-boot" });
  const order = lines
    .filter((line) => line.startsWith("control "))
    .map((line) => line.split(/[ :]/)[1]);
  assert.deepEqual(order.slice(-4), [
    CONTROL_METHODS.hello,
    CONTROL_METHODS.syncProfiles,
    CONTROL_METHODS.reconcileWorker,
    CONTROL_METHODS.grant,
  ]);

  // The registry is every profile, the default Claude one at the user's own
  // `~/.claude`, which the link only names.
  const expected = profiles
    .listCredentialProfiles()
    .map((profile) => ({
      id: profile.id,
      provider: profile.provider,
      name: profile.name,
      enabled: profile.enabled,
      tokenFile:
        profile.provider === "claude"
          ? join(profiles.claudeConfigDir(profile.id), ".credentials.json")
          : join(profiles.piAgentDir(profile.id), "auth.json"),
    }))
    .sort((a, b) => a.id.localeCompare(b.id));
  assert.deepEqual(
    (registry(dir) as { id: string }[]).sort((a, b) =>
      a.id.localeCompare(b.id),
    ),
    expected,
  );
  assert.equal(
    expected.find((p) => p.id === profiles.DEFAULT_CLAUDE_PROFILE_ID)
      ?.tokenFile,
    join(home, ".claude", ".credentials.json"),
  );
  assert.equal(existsSync(join(home, ".claude")), false);

  // The hello the gateway recorded names this process.
  const hello = booted.gateway!.lastHello();
  assert.equal(hello?.pid, process.pid);
  if (process.platform === "linux")
    assert.equal(hello?.startTime, ownStartTime());
  assert.match(hello?.serverBootId ?? "", /^[A-Za-z0-9_-]{22}$/);
});

test("profile changes reach the gateway in order; disable is metadata, deletion revokes", async () => {
  const dir = stateDir();
  const booted = link({ stateDir: dir });
  assert.equal(await booted.ready, true);
  const id = codexProfile("Link A");
  await until(() =>
    (registry(dir) as { id: string }[]).some((p) => p.id === id),
  );
  const lease = await booted.grantEngineLease({
    workerId: "local",
    sessionId: "s-a",
    profileId: id,
  });
  assert.equal((await codexRequest(booted.gateway!, lease.token)).status, 200);

  profiles.setCredentialProfileEnabled(id, false);
  await until(() =>
    (registry(dir) as { id: string; enabled: boolean }[]).some(
      (p) => p.id === id && !p.enabled,
    ),
  );
  assert.equal((await codexRequest(booted.gateway!, lease.token)).status, 200);
  assert.deepEqual(seen.at(-1), {
    authorization: `Bearer ${FAKE_ACCESS}`,
    account: FAKE_ACCOUNT,
  });

  profiles.deleteCredentialProfile(id);
  await until(() =>
    (registry(dir) as { id: string }[]).every((p) => p.id !== id),
  );
  const before = seen.length;
  const refused = await codexRequest(booted.gateway!, lease.token);
  assert.equal(refused.status, 401);
  assert.ok(
    refused.text.includes(
      refusalText({ case: "revoked-lease", reason: "profile-removed" }),
    ),
    refused.text,
  );
  assert.ok(refused.text.includes("(the account was removed)"));
  assert.ok(!refused.text.includes("disabled"));
  assert.equal(seen.length, before, "no upstream request");

  // In quick succession: a create then a delete, and a create then a rename
  // and a disable, each arrive in the order they happened.
  const gone = codexProfile("Link gone");
  profiles.deleteCredentialProfile(gone);
  const kept = codexProfile("Link kept");
  profiles.renameCredentialProfile(kept, "Link renamed");
  profiles.setCredentialProfileEnabled(kept, false);
  // A request made after them is answered after them: requests take one queue.
  await booted.revokeLease("0".repeat(22), "session-ended");
  const after = registry(dir) as {
    id: string;
    name: string;
    enabled: boolean;
  }[];
  assert.equal(
    after.some((p) => p.id === gone),
    false,
  );
  const renamed = after.find((p) => p.id === kept);
  assert.equal(renamed?.name, "Link renamed");
  assert.equal(renamed?.enabled, false);
  profiles.deleteCredentialProfile(kept);
});

test("a gateway that failed to start, or whose control ended, fails grants with U7's text", async () => {
  const taken = net.createServer();
  await new Promise<void>((resolve) =>
    taken.listen(0, "127.0.0.1", () => resolve()),
  );
  try {
    const failed = link({ port: (taken.address() as net.AddressInfo).port });
    assert.equal(await failed.ready, false);
    assert.ok(lines.some((line) => line.startsWith("unavailable: ")));
    await assert.rejects(
      failed.grantEngineLease({
        workerId: "local",
        sessionId: "s",
        profileId: profiles.DEFAULT_OPENAI_PROFILE_ID,
      }),
      { message: GATEWAY_UNAVAILABLE_TEXT },
    );
    // Best-effort calls on a failed link only log.
    await failed.bindLeaseSession("0".repeat(22), "s");
    await failed.revokeLease("0".repeat(22), "session-ended");
    // It stays installed, so profiled opens keep failing rather than skip it.
    assert.equal(installedGatewayLink(), failed);
    await links.pop()!.close();
  } finally {
    await new Promise<void>((resolve) => taken.close(() => resolve()));
  }

  const ended = link();
  assert.equal(await ended.ready, true);
  await ended.gateway!.close();
  await assert.rejects(
    ended.grantEngineLease({
      workerId: "local",
      sessionId: "s",
      profileId: profiles.DEFAULT_OPENAI_PROFILE_ID,
    }),
    { message: GATEWAY_UNAVAILABLE_TEXT },
  );

  // Not a dead login, whatever provider carries it.
  assert.equal(
    isLoginDeath(GATEWAY_UNAVAILABLE_TEXT, { provider: "anthropic" }),
    false,
  );
  for (const provider of ["anthropic", "claude-sdk", "openai-codex"])
    assert.equal(
      runFailureFacts(
        analyzeProviderError(GATEWAY_UNAVAILABLE_TEXT, { provider }),
      ).loginDeath,
      undefined,
    );
});

test("a link not ready in 10 s fails the grant then", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  let fail!: (err: Error) => void;
  const pending = link({
    start: () => new Promise((_resolve, reject) => (fail = reject)),
  });
  const outcome: { value: "pending" | "granted" | Error } = {
    value: "pending",
  };
  void pending
    .grantEngineLease({
      workerId: "local",
      sessionId: "s",
      profileId: profiles.DEFAULT_OPENAI_PROFILE_ID,
    })
    .then(
      () => (outcome.value = "granted"),
      (err: Error) => (outcome.value = err),
    );
  await vi.advanceTimersByTimeAsync(9_999);
  assert.equal(outcome.value, "pending");
  await vi.advanceTimersByTimeAsync(1);
  const failure: unknown = outcome.value;
  assert.ok(failure instanceof Error);
  assert.equal(failure.message, GATEWAY_UNAVAILABLE_TEXT);
  fail(new Error("the test ends the start"));
  assert.equal(await pending.ready, false);
});

/** Starts the gateway with its holds' processes observed as `state`, never for real. */
function observed(
  state: "running" | "exited",
  extra: Partial<GatewayOptions> = {},
) {
  const processes = fakeProcesses(state);
  return (options: GatewayOptions) =>
    startGateway({ ...options, processProbe: processes.probe, ...extra });
}

const heldBy =
  (refusal: "hold_exists" | "login_stuck", holdId: string) =>
  (err: unknown): boolean =>
    err instanceof LoginHeldError &&
    err.refusal === refusal &&
    err.holdId === holdId;

test("AC16: the login hold calls, the recorded status, and a hold waiting for the lane holding up no other request", async () => {
  const claude = profiles.createCredentialProfile({
    provider: "claude",
    name: "Link Claude",
  }).id;
  const codex = codexProfile("Link hold B");
  let now = Date.now();
  const linked = await startGatewayLinkForTests({
    start: observed("running", { now: () => now }),
  });
  const child = spawnIdleChild();
  try {
    const { link } = linked;
    const gw = link.gateway!;
    const id = await link.acquireLoginHold(claude);
    const hello = gw.lastHello()!;
    const [record] = gw.holds();
    assert.equal(record?.holdId, id);
    assert.deepEqual(record?.owner, {
      serverBootId: hello.serverBootId,
      pid: hello.pid,
      startTime: hello.startTime,
    });
    // The writer is this test's own child.
    await link.registerLoginWriter(id, child.pid);
    assert.deepEqual(gw.holds()[0]?.writer, {
      pid: child.pid,
      startTime: processStartTime(child.pid),
    });
    await assert.rejects(
      link.acquireLoginHold(claude),
      heldBy("hold_exists", id),
    );
    await link.releaseLoginHold(id);
    assert.deepEqual(gw.holds(), []);

    const stuck = await link.acquireLoginHold(claude);
    assert.equal(link.loginStatus(claude), undefined);
    now += 30 * 60 * 1000;
    gw.checkHolds();
    await until(() => link.loginStatus(claude)?.loginStuck === true);
    assert.deepEqual(link.loginStatus(claude), {
      loginStuck: true,
      holdId: stuck,
    });
    await link.forceReleaseLoginHold(stuck);
    await until(() => link.loginStatus(claude)?.loginStuck === false);
    assert.deepEqual(gw.holds(), []);

    let finish!: () => void;
    const item = gw.lane.run(
      claude,
      () => new Promise<void>((resolve) => (finish = resolve)),
    );
    let answered = false;
    const waiting = link.acquireLoginHold(claude).finally(() => {
      answered = true;
    });
    const lease = await link.grantEngineLease({
      workerId: "local",
      sessionId: "s-hold",
      profileId: codex,
    });
    profiles.renameCredentialProfile(codex, "Link hold renamed");
    await until(() =>
      (registry(linked.stateDir) as { id: string; name: string }[]).some(
        (p) => p.id === codex && p.name === "Link hold renamed",
      ),
    );
    // A request after them is answered after them; the hold still waits.
    await link.revokeLease(lease.leaseId, "session-ended");
    assert.equal(answered, false);
    finish();
    await item;
    const third = await waiting;
    assert.deepEqual(
      gw.holds().map((hold) => hold.holdId),
      [third],
    );
    await link.releaseLoginHold(third);
  } finally {
    await endChild(child);
    await linked.close();
    profiles.deleteCredentialProfile(claude);
    profiles.deleteCredentialProfile(codex);
  }
});

test("AC16: a link that is not ready fails the login calls with U7's login text", async () => {
  const failed = link({
    start: () => Promise.reject(new Error("the test refuses the start")),
  });
  assert.equal(await failed.ready, false);
  await assert.rejects(
    failed.acquireLoginHold(profiles.DEFAULT_OPENAI_PROFILE_ID),
    {
      message: GATEWAY_LOGIN_UNAVAILABLE_TEXT,
    },
  );
  await assert.rejects(failed.forceReleaseLoginHold("h1"), {
    message: GATEWAY_LOGIN_UNAVAILABLE_TEXT,
  });
  // Best-effort: only logged.
  await failed.releaseLoginHold("h1");
  assert.equal(
    failed.loginStatus(profiles.DEFAULT_OPENAI_PROFILE_ID),
    undefined,
  );
});

test("AC22: every link lifetime is a new boot; an earlier boot's hold stays while its owner runs and ends once it exited", async () => {
  const id = codexProfile("Link restart");
  const dir = stateDir();
  try {
    const first = await startGatewayLinkForTests({
      stateDir: dir,
      start: observed("running"),
    });
    let held: string;
    let firstBoot: string;
    try {
      held = await first.link.acquireLoginHold(id);
      firstBoot = first.link.gateway!.lastHello()!.serverBootId;
    } finally {
      await first.close();
    }
    assert.ok(
      existsSync(join(dir, "holds.json")),
      "the helper leaves a state directory it did not make",
    );

    const second = await startGatewayLinkForTests({
      stateDir: dir,
      start: observed("running"),
    });
    try {
      assert.notEqual(
        second.link.gateway!.lastHello()!.serverBootId,
        firstBoot,
      );
      assert.deepEqual(
        second.link.gateway!.holds().map((hold) => hold.holdId),
        [held],
      );
      await assert.rejects(
        second.link.acquireLoginHold(id),
        heldBy("login_stuck", held),
      );
    } finally {
      await second.close();
    }

    const third = await startGatewayLinkForTests({
      stateDir: dir,
      start: observed("exited"),
    });
    try {
      assert.deepEqual(third.link.gateway!.holds(), []);
      const next = await third.link.acquireLoginHold(id);
      assert.notEqual(next, held);
      await third.link.releaseLoginHold(next);
    } finally {
      await third.close();
    }
  } finally {
    profiles.deleteCredentialProfile(id);
  }
});

/** A compatible chat request through the link's gateway, under `basePath`. */
async function compatRequest(
  gateway: { url: string },
  token: string,
  basePath = "/v1",
): Promise<{ status: number; text: string }> {
  const response = await fetch(
    `${gateway.url}/compat${basePath}/chat/completions`,
    {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
      body: "{}",
    },
  );
  return { status: response.status, text: await response.text() };
}

/** The control methods the gateway logged, in order. */
const controlOrder = () =>
  lines
    .filter((line) => line.startsWith("control "))
    .map((line) => line.split(/[ :]/)[1]);

/** The authorizations of the chat requests `endpoint` got; discovery is not one. */
const forwarded = (endpoint: FakeCompatEndpoint) =>
  endpoint.seen
    .filter((seen) => seen.method === "POST")
    .map((seen) => seen.authorization);

/**
 * A compatible account on `baseUrl`, with `apiKey` when given, its models
 * discovered by the direct path (Settings' Test) so it is ready to run.
 */
async function compatibleAccount(
  name: string,
  baseUrl: string,
  apiKey?: string,
): Promise<string> {
  const id = profiles.createCredentialProfile({
    provider: "openai-compatible",
    name,
  }).id;
  profiles.patchOpenAiCompatibleEndpoint(id, {
    baseUrl,
    ...(apiKey ? { apiKey } : {}),
  });
  const { status } = await profiles.testOpenAiCompatibleProfile(id);
  assert.equal(status.ok, true, status.message);
  return id;
}

/** `compat-unset`'s marked 503 in the OpenAI shape. */
function assertUnset(reply: { status: number; text: string }): void {
  assert.equal(reply.status, 503, reply.text);
  const message = JSON.parse(reply.text).error.message;
  assert.equal(message, refusalText({ case: "compat-unset" }));
  assert.ok(message.startsWith("Pandeck gateway: "));
}

/** No log line holds a key, an endpoint's URL or its port. */
function assertNoLeak(values: string[]): void {
  for (const line of lines)
    for (const value of values)
      assert.ok(!line.includes(value), `a log line leaks: ${line}`);
}

test("AC8: the boot syncs compatible accounts tokenless and pushes each one's pair before ready; one not ready gets a clear", async () => {
  const endpoint = await startFakeCompatEndpoint(["m"], "compatible reply");
  const ids: string[] = [];
  try {
    const keyed = await compatibleAccount(
      "Link keyed",
      endpoint.baseUrl,
      COMPAT_KEY_A,
    );
    ids.push(keyed);
    const keyless = await compatibleAccount("Link keyless", endpoint.baseUrl);
    ids.push(keyless);
    // A URL but no models yet: not ready to run.
    const unready = profiles.createCredentialProfile({
      provider: "openai-compatible",
      name: "Link unready",
    }).id;
    ids.push(unready);
    profiles.patchOpenAiCompatibleEndpoint(unready, {
      baseUrl: endpoint.baseUrl,
    });

    const dir = stateDir();
    const booted = link({ stateDir: dir });
    assert.equal(await booted.ready, true, lines.join("\n"));
    const order = controlOrder();
    assert.deepEqual(order.slice(0, 3), [
      CONTROL_METHODS.hello,
      CONTROL_METHODS.syncProfiles,
      CONTROL_METHODS.reconcileWorker,
    ]);
    const pushes = lines.filter((line) => line.startsWith("control compat."));
    assert.deepEqual(
      pushes.sort(),
      [
        `control ${CONTROL_METHODS.compatClear} (profile ${unready}): ok`,
        `control ${CONTROL_METHODS.compatSet} (profile ${keyed}): ok`,
        `control ${CONTROL_METHODS.compatSet} (profile ${keyless}): ok`,
      ].sort(),
    );
    assert.equal(order.length, 6, order.join(","));
    const lastPush = Math.max(...pushes.map((line) => lines.indexOf(line)));
    const ready = lines.findIndex((line) => line.startsWith("ready: "));
    assert.ok(lastPush < ready, lines.join("\n"));

    for (const id of ids)
      assert.deepEqual(
        (registry(dir) as { id: string }[]).find((p) => p.id === id),
        {
          id,
          provider: "openai-compatible",
          name: profiles.credentialProfileById(id)!.name,
          enabled: true,
        },
      );
    assert.ok(
      !readFileSync(join(dir, "profiles.json"), "utf8").includes(COMPAT_KEY_A),
    );

    const lease = async (profileId: string) =>
      (
        await booted.grantEngineLease({
          workerId: undefined,
          sessionId: `s-${profileId}`,
          profileId,
        })
      ).token;
    assert.equal(
      (await compatRequest(booted.gateway!, await lease(keyed))).status,
      200,
    );
    assert.equal(
      (await compatRequest(booted.gateway!, await lease(keyless))).status,
      200,
    );
    assert.deepEqual(forwarded(endpoint), [
      `Bearer ${COMPAT_KEY_A}`,
      // A keyless account forwards pi's placeholder, as the direct path does.
      "Bearer none",
    ]);
    assertUnset(await compatRequest(booted.gateway!, await lease(unready)));
    assert.equal(forwarded(endpoint).length, 2, "the unset pair sends nothing");
    // AC14: the gateway reports no login state for a compatible account.
    for (const id of ids) assert.equal(booted.credentialStatus(id), undefined);
    assertNoLeak([COMPAT_KEY_A, endpoint.baseUrl]);
  } finally {
    for (const id of ids) profiles.deleteCredentialProfile(id);
    await endpoint.close();
  }
});

for (const broken of [
  {
    name: "unreadable",
    break: (file: string) => {
      rmSync(file);
      mkdirSync(file);
    },
  },
  { name: "malformed", break: (file: string) => writeFileSync(file, "{") },
])
  test(`F001: an account whose endpoint is ${broken.name} at boot is synced tokenless and cleared; the link is ready and the healthy account forwards`, async () => {
    const endpoint = await startFakeCompatEndpoint(["m"], "healthy reply");
    const ids: string[] = [];
    const file = () => openAiCompatibleEndpointPath(ids[0]!);
    try {
      ids.push(
        await compatibleAccount("Link broken", endpoint.baseUrl, COMPAT_KEY_A),
      );
      ids.push(
        await compatibleAccount("Link healthy", endpoint.baseUrl, COMPAT_KEY_B),
      );
      const [brokenId, healthy] = ids as [string, string];
      broken.break(file());
      assert.throws(() => readOpenAiCompatibleEndpoint(brokenId));

      const dir = stateDir();
      const booted = link({ stateDir: dir });
      assert.equal(await booted.ready, true, lines.join("\n"));
      for (const id of ids)
        assert.deepEqual(
          (registry(dir) as { id: string }[]).find((p) => p.id === id),
          {
            id,
            provider: "openai-compatible",
            name: profiles.credentialProfileById(id)!.name,
            enabled: true,
          },
        );
      // The read failure names the method and the id alone, then clears.
      assert.ok(
        lines.includes(
          `${CONTROL_METHODS.compatSet} (profile ${brokenId}): failed`,
        ),
        lines.join("\n"),
      );
      assert.deepEqual(
        lines.filter((line) => line.startsWith("control compat.")).sort(),
        [
          `control ${CONTROL_METHODS.compatClear} (profile ${brokenId}): ok`,
          `control ${CONTROL_METHODS.compatSet} (profile ${healthy}): ok`,
        ].sort(),
      );

      const engine = await booted.grantEngineLease({
        workerId: undefined,
        sessionId: "s-healthy",
        profileId: healthy,
      });
      assert.equal(
        (await compatRequest(booted.gateway!, engine.token)).status,
        200,
      );
      const server = await booted.serverAccess(healthy);
      assert.equal(
        (await compatRequest(booted.gateway!, server.leaseToken)).status,
        200,
      );
      assert.deepEqual(forwarded(endpoint), [
        `Bearer ${COMPAT_KEY_B}`,
        `Bearer ${COMPAT_KEY_B}`,
      ]);
      const unset = await booted.grantEngineLease({
        workerId: undefined,
        sessionId: "s-broken",
        profileId: brokenId,
      });
      assertUnset(await compatRequest(booted.gateway!, unset.token));
      assert.equal(forwarded(endpoint).length, 2);
      assertNoLeak([COMPAT_KEY_A, COMPAT_KEY_B, endpoint.baseUrl]);
    } finally {
      if (ids[0]) rmSync(file(), { recursive: true, force: true });
      for (const id of ids) profiles.deleteCredentialProfile(id);
      await endpoint.close();
    }
  });

test("AC8: a rotation, URL edit or rename pushes upsert then set; disabling keeps the pair; deletion removes, revokes and pushes nothing", async () => {
  const first = await startFakeCompatEndpoint(["m"], "first reply");
  const second = await startFakeCompatEndpoint(["m"], "second reply");
  const id = await compatibleAccount(
    "Link edited",
    first.baseUrl,
    COMPAT_KEY_A,
  );
  try {
    const booted = link();
    assert.equal(await booted.ready, true, lines.join("\n"));
    const { token } = await booted.grantEngineLease({
      workerId: undefined,
      sessionId: "s-edited",
      profileId: id,
    });
    const server = await booted.serverAccess(id);
    assert.equal((await compatRequest(booted.gateway!, token)).status, 200);

    /** Runs `change`, then waits for `methods` to follow it, in order. */
    const pushed = async (change: () => unknown, methods: string[]) => {
      const from = controlOrder().length;
      await change();
      await until(() => controlOrder().length >= from + methods.length);
      assert.deepEqual(controlOrder().slice(from), methods);
    };
    const upsertSet = [
      CONTROL_METHODS.upsertProfile,
      CONTROL_METHODS.compatSet,
    ];

    await pushed(
      () =>
        profiles.patchOpenAiCompatibleEndpoint(id, { apiKey: COMPAT_KEY_B }),
      upsertSet,
    );
    assert.equal((await compatRequest(booted.gateway!, token)).status, 200);
    assert.deepEqual(forwarded(first), [
      `Bearer ${COMPAT_KEY_A}`,
      `Bearer ${COMPAT_KEY_B}`,
    ]);

    // A new URL starts with no models: not ready, so its pair is cleared
    // until Test rediscovers them. A new origin needs its key in the edit.
    await pushed(
      () =>
        profiles.patchOpenAiCompatibleEndpoint(id, {
          baseUrl: second.baseUrl,
          apiKey: COMPAT_KEY_C,
        }),
      [CONTROL_METHODS.upsertProfile, CONTROL_METHODS.compatClear],
    );
    assertUnset(await compatRequest(booted.gateway!, token));
    await pushed(() => profiles.testOpenAiCompatibleProfile(id), upsertSet);
    assert.equal((await compatRequest(booted.gateway!, token)).status, 200);
    assert.equal(
      (await compatRequest(booted.gateway!, server.leaseToken)).status,
      200,
    );
    assert.deepEqual(forwarded(second), [
      `Bearer ${COMPAT_KEY_C}`,
      `Bearer ${COMPAT_KEY_C}`,
    ]);
    assert.equal(forwarded(first).length, 2, "the old endpoint gets nothing");

    await pushed(
      () => profiles.renameCredentialProfile(id, "Link renamed"),
      upsertSet,
    );
    // `enabled` is metadata: the pair and the leases stay.
    await pushed(
      () => profiles.setCredentialProfileEnabled(id, false),
      upsertSet,
    );
    assert.equal((await compatRequest(booted.gateway!, token)).status, 200);
    assert.equal(forwarded(second).length, 3);

    await pushed(
      () => profiles.deleteCredentialProfile(id),
      [CONTROL_METHODS.removeProfile],
    );
    for (const lease of [token, server.leaseToken]) {
      const refused = await compatRequest(booted.gateway!, lease);
      assert.equal(refused.status, 401);
      assert.equal(
        JSON.parse(refused.text).error.message,
        refusalText({ case: "revoked-lease", reason: "profile-removed" }),
      );
    }
    assert.equal(forwarded(second).length, 3, "no upstream request");
    assertNoLeak([
      COMPAT_KEY_A,
      COMPAT_KEY_B,
      COMPAT_KEY_C,
      first.baseUrl,
      second.baseUrl,
    ]);
  } finally {
    if (profiles.credentialProfileById(id))
      profiles.deleteCredentialProfile(id);
    await first.close();
    await second.close();
  }
});

test("AC8, AC16: legacy invalid keys and URLs are control-refused, logged by code alone, not retried, and leave A at the marked 503 while B forwards", async () => {
  const a = await startFakeCompatEndpoint(["m"], "a reply");
  const b = await startFakeCompatEndpoint(["m"], "b reply");
  // A valid URL whose long ASCII path takes it past control's 2048 bytes.
  const longPath = `/v1/${"p".repeat(2100)}`;
  const long = await startFakeCompatEndpoint(["m"], "long reply", {
    basePath: longPath,
  });
  assert.ok(Buffer.byteLength(long.baseUrl) > 2048);
  const overlongKey = COMPAT_KEY_C.padEnd(8193, "k");
  const ids: string[] = [];
  try {
    const idA = await compatibleAccount("Link A", a.baseUrl, COMPAT_KEY_A);
    ids.push(idA);
    const idB = await compatibleAccount("Link B", b.baseUrl, COMPAT_KEY_B);
    ids.push(idB);
    const booted = link();
    assert.equal(await booted.ready, true, lines.join("\n"));
    const lease = async (profileId: string) =>
      (
        await booted.grantEngineLease({
          workerId: undefined,
          sessionId: `s-${profileId}`,
          profileId,
        })
      ).token;
    const tokenA = await lease(idA);
    const tokenB = await lease(idB);
    assert.equal((await compatRequest(booted.gateway!, tokenA)).status, 200);
    assert.equal((await compatRequest(booted.gateway!, tokenB)).status, 200);

    const refusedLine = `${CONTROL_METHODS.compatSet} (profile ${idA}): invalid_params`;
    const refusedLines = () =>
      lines.filter((line) => line.endsWith(refusedLine));
    /** A's refused set: the gateway's control line and the link's own. */
    const refused = async (change: () => unknown) => {
      const before = refusedLines().length;
      await change();
      await until(() => refusedLines().length === before + 2);
      assert.deepEqual(refusedLines().slice(before).sort(), [
        refusedLine,
        `control ${refusedLine}`,
      ]);
    };

    // Seed a pre-existing legacy key through the endpoint fixture writer; new
    // saves reject it. A metadata change republishes it without repairing it.
    writeOpenAiCompatibleEndpoint(idA, {
      ...readOpenAiCompatibleEndpoint(idA),
      apiKey: overlongKey,
    });
    await refused(() => profiles.patchCredentialProfile(idA, { priority: 1 }));
    assert.equal(
      readOpenAiCompatibleEndpoint(idA).apiKey === overlongKey,
      true,
    );
    assertUnset(await compatRequest(booted.gateway!, tokenA));
    assert.equal(forwarded(a).length, 1, "the endpoint sees nothing");
    assert.equal((await compatRequest(booted.gateway!, tokenB)).status, 200);
    // Not retried: no later push for A until the account changes.
    const pushesOfA = () =>
      lines.filter((line) => line.includes(`(profile ${idA})`)).length;
    const counted = pushesOfA();
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
    assert.equal(pushesOfA(), counted);

    // Seed a legacy overlength URL the same way. Metadata publication pushes
    // it to the gateway; normal save validation remains unchanged.
    writeOpenAiCompatibleEndpoint(idA, {
      ...readOpenAiCompatibleEndpoint(idA),
      baseUrl: long.baseUrl,
      apiKey: COMPAT_KEY_A,
    });
    await refused(() => profiles.patchCredentialProfile(idA, { priority: 2 }));
    assert.equal(readOpenAiCompatibleEndpoint(idA).baseUrl, long.baseUrl);
    assert.deepEqual(long.seen, [], "legacy URL was never discovered");
    assertUnset(await compatRequest(booted.gateway!, tokenA, longPath));
    assertUnset(await compatRequest(booted.gateway!, tokenA));
    assert.deepEqual(forwarded(long), []);
    assert.equal(forwarded(a).length, 1);
    assert.equal((await compatRequest(booted.gateway!, tokenB)).status, 200);
    assert.deepEqual(forwarded(b), Array(3).fill(`Bearer ${COMPAT_KEY_B}`));

    // A's lines name the method, the account and the code, nothing more.
    for (const line of lines.filter((l) => l.includes(`(profile ${idA})`)))
      assert.match(
        line,
        /^(control )?(profiles\.upsert|compat\.set|compat\.clear) \(profile [\w-]+\): (ok|invalid_params)$/,
      );
    assertNoLeak([
      COMPAT_KEY_A,
      COMPAT_KEY_B,
      COMPAT_KEY_C,
      a.baseUrl,
      b.baseUrl,
      long.baseUrl,
    ]);
  } finally {
    for (const id of ids) profiles.deleteCredentialProfile(id);
    await a.close();
    await b.close();
    await long.close();
  }
});

test("AC13: with the link running, Test reaches the endpoint's /models directly; the gateway forwards nothing", async () => {
  const endpoint = await startFakeCompatEndpoint(["m"], "compatible reply");
  const booted = link();
  assert.equal(await booted.ready, true);
  const before = { ...booted.gateway!.stats };
  const id = await compatibleAccount(
    "Link tested",
    endpoint.baseUrl,
    COMPAT_KEY_A,
  );
  try {
    assert.deepEqual(
      endpoint.seen.map(({ method, url }) => [method, url]),
      [["GET", "/v1/models"]],
    );
    assert.equal(endpoint.seen[0]!.authorization, `Bearer ${COMPAT_KEY_A}`);
    assert.deepEqual(booted.gateway!.stats, before);
    assert.equal(booted.credentialStatus(id), undefined);
  } finally {
    profiles.deleteCredentialProfile(id);
    await endpoint.close();
  }
});

/** The gateway's server leases, oldest first. */
function serverLeases(running: GatewayLink) {
  return running
    .gateway!.leases.records()
    .filter((record) => record.kind === "server")
    .sort((a, b) => a.grantedAt - b.grantedAt);
}

/** A usage read through the link's gateway, as the server sends it. */
async function usageRequest(
  gateway: { url: string },
  token: string,
): Promise<{ status: number; text: string }> {
  const response = await fetch(
    `${gateway.url}/chatgpt/backend-api/wham/usage`,
    { headers: { authorization: `Bearer ${token}` } },
  );
  return { status: response.status, text: await response.text() };
}

test("AC4: a server lease is granted once per profile per boot, and never without a link", async () => {
  const a = codexProfile("Server A");
  const b = codexProfile("Server B");
  try {
    assert.equal(installedGatewayLink(), undefined);
    assert.equal(await serverGatewayAccess(a), undefined);

    const booted = link();
    assert.equal(await booted.ready, true);
    const [first, second] = await Promise.all([
      serverGatewayAccess(a),
      booted.serverAccess(a),
    ]);
    const later = await booted.serverAccess(a);
    assert.ok(first);
    assert.deepEqual(second, first);
    assert.deepEqual(later, first);
    assert.equal(first.baseUrl, booted.gateway!.url);
    const other = await booted.serverAccess(b);
    assert.notEqual(other.leaseToken, first.leaseToken);

    const records = serverLeases(booted);
    assert.deepEqual(
      records.map((record) => record.profileId),
      [a, b],
    );
    const boot = booted.gateway!.lastHello()!.serverBootId;
    for (const record of records) {
      assert.equal(record.kind, "server");
      assert.deepEqual(record.owner, { serverBootId: boot });
      assert.equal(record.revoked, undefined);
    }
    assert.equal(
      (await usageRequest(booted.gateway!, first.leaseToken)).status,
      200,
    );
    assert.deepEqual(seen.at(-1), {
      authorization: `Bearer ${FAKE_ACCESS}`,
      account: FAKE_ACCOUNT,
    });

    await booted.close();
    links.pop();
    assert.equal(await serverGatewayAccess(a), undefined);
  } finally {
    profiles.deleteCredentialProfile(a);
    profiles.deleteCredentialProfile(b);
  }
});

test("AC5: deleting a profile drops its server lease, even one granted while it went; a disable keeps it", async () => {
  const id = codexProfile("Server removed");
  const dir = stateDir();
  const booted = link({ stateDir: dir });
  assert.equal(await booted.ready, true);
  const access = await booted.serverAccess(id);

  profiles.setCredentialProfileEnabled(id, false);
  await until(() =>
    (registry(dir) as { id: string; enabled: boolean }[]).some(
      (p) => p.id === id && !p.enabled,
    ),
  );
  assert.deepEqual(await booted.serverAccess(id), access);
  assert.equal(
    (await usageRequest(booted.gateway!, access.leaseToken)).status,
    200,
  );

  profiles.deleteCredentialProfile(id);
  await until(() =>
    (registry(dir) as { id: string }[]).every((p) => p.id !== id),
  );
  const before = seen.length;
  const refused = await usageRequest(booted.gateway!, access.leaseToken);
  assert.equal(refused.status, 401);
  assert.ok(
    refused.text.includes(
      refusalText({ case: "revoked-lease", reason: "profile-removed" }),
    ),
    refused.text,
  );
  assert.ok(refused.text.includes("(the account was removed)"));
  assert.equal(seen.length, before, "no upstream request");
  // Not the old token: a new grant, which the gateway refuses now.
  await assert.rejects(booted.serverAccess(id), {
    message: GATEWAY_UNAVAILABLE_TEXT,
  });

  // Deleted while the gateway grants: the removal follows the grant on the
  // queue, revokes it, and the link keeps nothing.
  const racing = codexProfile("Server racing");
  await until(() =>
    (registry(dir) as { id: string }[]).some((p) => p.id === racing),
  );
  let deleted = false;
  const original = lines.push.bind(lines);
  lines.push = (...items: string[]) => {
    if (
      !deleted &&
      items.some((line) =>
        line.startsWith(`control ${CONTROL_METHODS.grant} (profile ${racing},`),
      )
    ) {
      deleted = true;
      profiles.deleteCredentialProfile(racing);
    }
    return original(...items);
  };
  let inFlight;
  try {
    inFlight = await booted.serverAccess(racing);
  } finally {
    lines.push = original;
  }
  assert.ok(deleted, "the profile went while its grant was answered");
  await booted.revokeLease("0".repeat(22), "session-ended");
  const revoked = await usageRequest(booted.gateway!, inFlight.leaseToken);
  assert.equal(revoked.status, 401);
  assert.ok(revoked.text.includes("(the account was removed)"));
  await assert.rejects(booted.serverAccess(racing), {
    message: GATEWAY_UNAVAILABLE_TEXT,
  });
});

test("AC6: a new boot on the same state revokes the earlier boot's server leases and grants its own", async () => {
  const id = codexProfile("Server restart");
  const dir = stateDir();
  try {
    const first = link({ stateDir: dir });
    assert.equal(await first.ready, true);
    const old = await first.serverAccess(id);
    await first.close();
    links.pop();

    const second = link({ stateDir: dir });
    assert.equal(await second.ready, true);
    const refused = await usageRequest(second.gateway!, old.leaseToken);
    assert.equal(refused.status, 401);
    assert.ok(
      refused.text.includes(
        refusalText({ case: "revoked-lease", reason: "session-ended" }),
      ),
      refused.text,
    );
    assert.ok(
      lines.some((line) =>
        /ready: \d+ profiles; revoked 1 server and 0 engine leases/.test(line),
      ),
      lines.join("\n"),
    );
    const fresh = await second.serverAccess(id);
    assert.notEqual(fresh.leaseToken, old.leaseToken);
    assert.equal(
      (await usageRequest(second.gateway!, fresh.leaseToken)).status,
      200,
    );
  } finally {
    profiles.deleteCredentialProfile(id);
  }
});

test("AC7 (link): an unavailable link fails a server lease with U7's text, and the next call tries again", async () => {
  const taken = net.createServer();
  await new Promise<void>((resolve) =>
    taken.listen(0, "127.0.0.1", () => resolve()),
  );
  try {
    const failed = link({ port: (taken.address() as net.AddressInfo).port });
    assert.equal(await failed.ready, false);
    for (let i = 0; i < 2; i += 1)
      await assert.rejects(
        serverGatewayAccess(profiles.DEFAULT_OPENAI_PROFILE_ID),
        { message: GATEWAY_UNAVAILABLE_TEXT },
      );
    assert.equal(
      lines.filter((line) =>
        line.startsWith(`${CONTROL_METHODS.grant} (server, profile `),
      ).length,
      2,
      "each call tried again",
    );
  } finally {
    await new Promise<void>((resolve) => taken.close(() => resolve()));
  }
});

test("AC18 (link): no link or gateway log line of a server lease holds a token, access token or account id", async () => {
  const id = codexProfile("Server logged");
  const dir = stateDir();
  const booted = link({ stateDir: dir });
  assert.equal(await booted.ready, true);
  const access = await booted.serverAccess(id);
  await usageRequest(booted.gateway!, access.leaseToken);
  profiles.deleteCredentialProfile(id);
  await until(() =>
    (registry(dir) as { id: string }[]).every((p) => p.id !== id),
  );
  await usageRequest(booted.gateway!, access.leaseToken);
  const secret = access.leaseToken.split(".").at(-1)!;
  assert.ok(lines.length > 0);
  for (const line of lines)
    for (const value of [access.leaseToken, secret, FAKE_ACCESS, FAKE_ACCOUNT])
      assert.ok(!line.includes(value), `a log line holds ${value}: ${line}`);
});

test("AC14 (link): the link hands the gateway its renewCodex port", async () => {
  const renewCodex: NonNullable<GatewayOptions["renewCodex"]> = async () => ({
    ok: true,
  });
  let handed: GatewayOptions["renewCodex"];
  const booted = link({
    renewCodex,
    start: (options: GatewayOptions) => {
      handed = options.renewCodex;
      return startGateway(options);
    },
  });
  assert.equal(await booted.ready, true);
  assert.equal(handed, renewCodex);
});

test("AC9 (link): a rejected Codex renewal reaches credentialStatus, and a new login clears it", async () => {
  const id = codexProfile("Renewal Codex");
  const authFile = join(profiles.piAgentDir(id), "auth.json");
  const login = JSON.parse(readFileSync(authFile, "utf8"));
  login["openai-codex"].expires = Date.now() + 30_000;
  writeFileSync(authFile, JSON.stringify(login));
  let answer: Awaited<ReturnType<NonNullable<GatewayOptions["renewCodex"]>>> = {
    ok: false,
    kind: "rejected",
    code: "400",
  };
  try {
    const booted = link({ renewCodex: async () => answer });
    assert.equal(await booted.ready, true);
    assert.equal(booted.credentialStatus(id), undefined);
    const access = await booted.serverAccess(id);
    const refused = await codexRequest(booted.gateway!, access.leaseToken);
    assert.equal(refused.status, 401);
    const message = JSON.parse(refused.text).error.message;
    assert.equal(
      message,
      refusalText({ case: "needs-login", name: "Renewal Codex" }),
    );
    assert.equal(isLoginDeath(message, { statusCode: 401 }), false);
    await until(() => booted.credentialStatus(id)?.needsLogin === true);

    answer = { ok: true };
    login["openai-codex"].expires = Date.now() + 86_400_000;
    writeFileSync(authFile, JSON.stringify(login));
    assert.equal(
      (await codexRequest(booted.gateway!, access.leaseToken)).status,
      200,
    );
    await until(() => booted.credentialStatus(id)?.needsLogin === false);
  } finally {
    profiles.deleteCredentialProfile(id);
  }
});

test("G5b AC9 (c), AC10 (link): a server gone before naming its writer leaves the hold held, stuck at the deadline; Clear force-releases it and renews, and an unknown hold counts as released", async () => {
  const claude = profiles.createCredentialProfile({
    provider: "claude",
    name: "Link stuck Claude",
  }).id;
  const profile = { id: claude, provider: "claude" } as const;
  writeFileSync(
    join(profiles.claudeConfigDir(claude), ".credentials.json"),
    JSON.stringify({
      claudeAiOauth: {
        accessToken: FAKE_CLAUDE_ACCESS,
        refreshToken: FAKE_CLAUDE_REFRESH,
        expiresAt: Date.now() + 30_000,
      },
    }),
  );
  const upstreams = await startFakeUpstreams();
  const dir = stateDir();
  let now = Date.now();
  try {
    const first = await startGatewayLinkForTests({
      stateDir: dir,
      start: observed("running", { now: () => now }),
    });
    let held: string;
    try {
      held = await first.link.acquireLoginHold(claude);
    } finally {
      await first.close();
    }

    // Its owner exited, but a Claude hold without a writer has no evidence.
    const second = await startGatewayLinkForTests({
      stateDir: dir,
      start: observed("exited", { now: () => now }),
      claudeTokenEndpoint: upstreams.tokenEndpoint,
    });
    try {
      loginHolds.setLoginHoldLinkForTests(second.link);
      const gw = second.link.gateway!;
      await second.link.serverAccess(claude);
      assert.deepEqual(
        gw.holds().map((hold) => hold.holdId),
        [held],
      );
      assert.deepEqual(await loginHolds.takeLoginHold(profile, () => {}), {
        kind: "stuck",
      });
      assert.equal(loginHolds.loginStuckOf(profile), true);

      now += 30 * 60 * 1000;
      gw.checkHolds();
      await until(() => second.link.loginStatus(claude)?.loginStuck === true);
      await gw.renewDue();
      assert.equal(gw.holds().length, 1, "elapsed time releases nothing");
      assert.equal(upstreams.platform.length, 0);

      await loginHolds.clearUnfinishedLogin(profile);
      assert.deepEqual(gw.holds(), []);
      await until(() => upstreams.platform.length === 1);
      await until(() => second.link.loginStatus(claude)?.loginStuck === false);
      assert.equal(loginHolds.loginStuckOf(profile), false);

      // Another Clear of the same hold finds it gone: done, not a failure.
      await second.link.forceReleaseLoginHold(held);
      const next = await loginHolds.takeLoginHold(profile, () => {});
      assert.equal(next.kind, "held");
      if (next.kind === "held") next.hold.release();
      await until(() => gw.holds().length === 0);
      for (const line of second.lines)
        for (const value of [FAKE_CLAUDE_ACCESS, FAKE_CLAUDE_REFRESH])
          assert.ok(
            !line.includes(value),
            `a log line holds ${value}: ${line}`,
          );
    } finally {
      loginHolds.setLoginHoldLinkForTests(null);
      await second.close();
    }
  } finally {
    await upstreams.close();
    profiles.deleteCredentialProfile(claude);
  }
});
