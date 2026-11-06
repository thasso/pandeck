/**
 * Gateway control 1.2 against a running gateway: the handshake, the hello
 * rule, the registry binding every grant, deletion as the only revoking
 * registry change, the server-boot rule, the per-Worker reconcile, revocation
 * and owner completion, the login hold methods, and the compatible endpoint's
 * push. Control runs over an
 * in-process pair; model requests go over loopback HTTP to fake TLS
 * upstreams. Every credential is fake, and every hold's processes are
 * observed through a fake probe.
 */
import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rmdir,
  stat,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, test } from "vitest";
import { DATA_DIR } from "../config.ts";
import {
  CLAUDE_ACCESS,
  CLAUDE_PATH,
  CODEX_ACCESS,
  CODEX_ACCOUNT,
  CODEX_PATH,
  COMPAT_KEY_A,
  COMPAT_KEY_B,
  dialControl,
  fakeProcesses,
  modelRequest,
  startFakeCompatEndpoint,
  startFakeUpstreams,
  writeTokenFiles,
  type FakeUpstreams,
} from "../test/gatewayFixtures.ts";
import {
  FrameDecoder,
  encodeControlFrame,
  type Frame,
  type Payload,
} from "../workerProtocol/codec.ts";
import {
  WorkerConnection,
  WorkerMethodError,
  WorkerRequestError,
} from "../workerProtocol/connection.ts";
import { createInProcessTransport } from "../workerProtocol/inProcessTransport.ts";
import { WORKER_PROTOCOL_VERSION } from "../workerProtocol/version.ts";
import {
  CONTROL_METHODS,
  GATEWAY_CONTROL_PROTOCOL,
  GATEWAY_CONTROL_VERSION,
  decodeCredentialStatus,
  decodeLeaseGranted,
  decodeHoldReleased,
  decodeLeaseRevoked,
  decodeLeasesRevoked,
  decodeLoginHeld,
  encodeControlRequest,
  encodeCredentialStatus,
  type CredentialStatus,
  type LeaseGrant,
} from "./controlMethods.ts";
import {
  startGateway,
  type GatewayOptions,
  type RunningGateway,
} from "./gateway.ts";
import type { HoldStatus } from "./holds.ts";
import type { GatewayProfile, LoginProfile } from "./profiles.ts";
import { refusalText, type RevokeReason } from "./refusals.ts";

let upstreams: FakeUpstreams;
let profileA: LoginProfile;
let profileB: LoginProfile;
/** OpenAI-compatible accounts: no token file, no login. */
const compatA: GatewayProfile = {
  id: "openai-compatible-aaaaaaaaaaaa",
  provider: "openai-compatible",
  name: "Local A",
  enabled: true,
};
const compatB: GatewayProfile = {
  id: "openai-compatible-bbbbbbbbbbbb",
  provider: "openai-compatible",
  name: "Local B",
  enabled: true,
};
/** A synthetic pushed key that would add a header if forwarded raw. */
const HEADER_INJECTING_KEY = `${"key"}\r\nx-injected: 1`;

const running: RunningGateway[] = [];
/** The current test's gateway log lines and the capabilities it saw. */
let lines: string[] = [];
let capabilities: string[] = [];

beforeAll(async () => {
  upstreams = await startFakeUpstreams();
  const files = await writeTokenFiles();
  profileA = {
    id: "claude-a",
    provider: "claude",
    name: "Work Claude",
    enabled: true,
    tokenFile: files.claudeFile,
  };
  profileB = {
    id: "codex-b",
    provider: "openai-codex",
    name: "Work ChatGPT",
    enabled: true,
    tokenFile: files.codexFile,
  };
});

afterEach(async () => {
  // AC19: no log line holds a token, its secret, a secret hash or a credential.
  for (const gw of running)
    for (const record of gw.leases.records())
      capabilities.push(record.secretHash);
  const forbidden = [
    ...capabilities,
    CLAUDE_ACCESS,
    CODEX_ACCESS,
    CODEX_ACCOUNT,
  ];
  for (const line of lines)
    for (const value of forbidden)
      assert.ok(!line.includes(value), `a log line leaks: ${line}`);
  while (running.length) await running.pop()!.close();
  upstreams.reset();
  lines = [];
  capabilities = [];
});

afterAll(async () => {
  await upstreams.close();
});

async function gateway(
  stateDir?: string,
  options: GatewayOptions = {},
): Promise<RunningGateway> {
  const gw = await startGateway({
    log: (line) => lines.push(line),
    upstreams: upstreams.overrides,
    // The hello below names pid 4242, which no test may observe for real.
    processProbe: fakeProcesses().probe,
    ...(stateDir ? { stateDir } : {}),
    ...options,
  });
  running.push(gw);
  return gw;
}

function control(gw: RunningGateway): WorkerConnection {
  return dialControl(
    createInProcessTransport(),
    gw.attachControl,
    GATEWAY_CONTROL_PROTOCOL,
  );
}

async function hello(
  connection: WorkerConnection,
  serverBootId: string,
): Promise<string[]> {
  const answer = await connection.request(
    CONTROL_METHODS.hello,
    encodeControlRequest({ serverBootId, pid: 4242, startTime: "1234" }),
  );
  return decodeLeasesRevoked(answer).revoked;
}

async function sync(
  connection: WorkerConnection,
  profiles: GatewayProfile[],
): Promise<string[]> {
  const answer = await connection.request(
    CONTROL_METHODS.syncProfiles,
    encodeControlRequest({ profiles }),
  );
  return decodeLeasesRevoked(answer).revoked;
}

async function grant(
  connection: WorkerConnection,
  request: LeaseGrant,
): Promise<{ leaseId: string; token: string }> {
  const granted = decodeLeaseGranted(
    await connection.request(
      CONTROL_METHODS.grant,
      encodeControlRequest(request),
    ),
  );
  capabilities.push(granted.token, granted.token.split(".")[2]!);
  return granted;
}

const engine = (profileId: string, workerId = "w", sessionId = "s1") =>
  ({ kind: "engine", workerId, sessionId, profileId }) as const;

/** A connection after hello and a sync of A and B. */
async function ready(
  gw: RunningGateway,
  bootId = "boot-x",
): Promise<WorkerConnection> {
  const connection = control(gw);
  await hello(connection, bootId);
  await sync(connection, [profileA, profileB]);
  return connection;
}

async function rejectsWith(
  answer: Promise<unknown>,
  code: string,
): Promise<void> {
  await assert.rejects(
    answer,
    (err) => err instanceof WorkerRequestError && err.code === code,
  );
}

/** The model request a lease of `profile` makes. */
function forward(
  gw: RunningGateway,
  profile: GatewayProfile,
  token: string,
): Promise<{ status: number; text: string }> {
  return modelRequest(
    gw.port,
    profile.provider === "claude" ? CLAUDE_PATH : CODEX_PATH,
    token,
  );
}

async function assertForwards(
  gw: RunningGateway,
  profile: GatewayProfile,
  token: string,
): Promise<void> {
  const reply = await forward(gw, profile, token);
  assert.equal(reply.status, 200, reply.text);
}

async function assertRevoked(
  gw: RunningGateway,
  profile: GatewayProfile,
  token: string,
  reason: RevokeReason,
): Promise<void> {
  const reply = await forward(gw, profile, token);
  assert.equal(reply.status, 401);
  assert.equal(
    JSON.parse(reply.text).error.message,
    refusalText({ case: "revoked-lease", reason }),
  );
}

/** Every frame the gateway answers a raw hello of `version` with. */
async function rawHandshake(
  gw: RunningGateway,
  version: string,
): Promise<Frame[]> {
  const [dialer, listener] = createInProcessTransport();
  const frames: Frame[] = [];
  const decoder = new FrameDecoder();
  const closed = new Promise<void>((resolve) => dialer.onClose(resolve));
  dialer.onData((bytes) => decoder.push(bytes, (frame) => frames.push(frame)));
  gw.attachControl(listener);
  dialer.write(
    encodeControlFrame({ type: "hello", workerId: "pandeck-server", version }),
  );
  await Promise.race([
    closed,
    new Promise((resolve) => setTimeout(resolve, 50)),
  ]);
  dialer.close();
  return frames;
}

test("AC1: the control handshake admits only gateway control, and a Worker refuses it", async () => {
  const gw = await gateway();
  assert.deepEqual(await rawHandshake(gw, GATEWAY_CONTROL_VERSION), [
    { type: "welcome", version: GATEWAY_CONTROL_VERSION },
  ]);
  const refused = await rawHandshake(gw, WORKER_PROTOCOL_VERSION);
  assert.equal(refused.length, 1);
  assert.equal(refused[0]!.type, "refused");
  assert.equal(
    (refused[0] as { version: string }).version,
    GATEWAY_CONTROL_VERSION,
  );
  assert.ok((refused[0] as { reason: string }).reason.length > 0);

  // A worker-protocol dialer, as a Worker dials, is refused.
  const worker = dialControl(createInProcessTransport(), gw.attachControl);
  assert.match(await worker.ended, /^the server refused: /);

  // A worker-protocol dialer that is welcomed in gateway control ends.
  const [dialer, listener] = createInProcessTransport();
  const workerSide = new WorkerConnection(dialer, {
    handshake: { role: "worker", workerId: "local" },
  });
  listener.onData(() => {});
  listener.write(
    encodeControlFrame({ type: "welcome", version: GATEWAY_CONTROL_VERSION }),
  );
  assert.equal(
    await workerSide.ended,
    `the server speaks protocol ${GATEWAY_CONTROL_VERSION}`,
  );

  // And a control dialer welcomed by a worker-protocol listener ends.
  const [controlEnd, workerListener] = createInProcessTransport();
  new WorkerConnection(workerListener, {
    handshake: { role: "server", admit: () => undefined },
  });
  const controlSide = new WorkerConnection(controlEnd, {
    handshake: { role: "worker", workerId: "pandeck-server" },
    protocol: GATEWAY_CONTROL_PROTOCOL,
  });
  assert.equal(
    await controlSide.ended,
    `the server speaks protocol ${WORKER_PROTOCOL_VERSION}`,
  );

  const { compatible } = GATEWAY_CONTROL_PROTOCOL;
  assert.ok(compatible("gateway-control/1.0"));
  assert.ok(compatible("gateway-control/1.7"));
  for (const version of [
    "gateway-control/2.0",
    "gateway-control/01.0",
    "gateway-control/1",
    WORKER_PROTOCOL_VERSION,
    "1.0",
  ])
    assert.ok(!compatible(version), version);
});

test("AC2: every method before control.hello fails with hello_required and changes nothing", async () => {
  const stateDir = join(await mkdtemp(join(DATA_DIR, "gateway-state-")), "gw");
  const gw = await gateway(stateDir);
  const connection = control(gw);
  const requests: [string, unknown][] = [
    [CONTROL_METHODS.syncProfiles, { profiles: [profileA] }],
    [CONTROL_METHODS.upsertProfile, { profile: profileA }],
    [CONTROL_METHODS.removeProfile, { profileId: profileA.id }],
    [CONTROL_METHODS.grant, engine(profileA.id)],
    [CONTROL_METHODS.bindSession, { leaseId: "lease-1", sessionId: "s9" }],
    [CONTROL_METHODS.revoke, { leaseId: "lease-1", reason: "session-ended" }],
    [CONTROL_METHODS.reconcileWorker, { workerId: "w", live: [] }],
  ];
  for (const [method, json] of requests)
    await rejectsWith(connection.request(method, { json }), "hello_required");
  assert.deepEqual(gw.leases.records(), []);
  await assert.rejects(readFile(join(stateDir, "leases.json")), {
    code: "ENOENT",
  });
  await assert.rejects(readFile(join(stateDir, "profiles.json")), {
    code: "ENOENT",
  });
});

test("AC3: a grant binds its lease from the registry, never from the request", async () => {
  const gw = await gateway();
  const connection = await ready(gw);
  const lease = await grant(connection, engine(profileB.id));
  await assertForwards(gw, profileB, lease.token);
  assert.equal(upstreams.chatgpt.length, 1);
  const seen = upstreams.chatgpt[0]!.headers;
  assert.equal(seen.authorization, `Bearer ${CODEX_ACCESS}`);
  assert.equal(seen["chatgpt-account-id"], CODEX_ACCOUNT);
  // The same token on the other provider's route is forbidden.
  assert.equal(
    (await modelRequest(gw.port, CLAUDE_PATH, lease.token)).status,
    403,
  );
  assert.equal(upstreams.anthropic.length, 0);

  await rejectsWith(
    connection.request(
      CONTROL_METHODS.grant,
      encodeControlRequest(engine("nobody")),
    ),
    "unknown_profile",
  );

  // A provider and token file in the request are ignored.
  const smuggled = decodeLeaseGranted(
    await connection.request(CONTROL_METHODS.grant, {
      json: {
        ...engine(profileB.id),
        provider: "claude",
        tokenFile: profileA.tokenFile,
      },
    }),
  );
  capabilities.push(smuggled.token, smuggled.token.split(".")[2]!);
  const record = gw.leases
    .records()
    .find((r) => r.leaseId === smuggled.leaseId);
  assert.equal(record?.provider, "openai-codex");
  assert.equal(record?.tokenFile, profileB.tokenFile);
  await assertForwards(gw, profileB, smuggled.token);
  assert.equal(
    upstreams.chatgpt[1]!.headers.authorization,
    `Bearer ${CODEX_ACCESS}`,
  );
  assert.equal(upstreams.anthropic.length, 0);

  // A control log line names the method, the ids and the outcome.
  assert.ok(
    lines.includes(
      `control leases.grant (profile ${profileB.id}, lease ${lease.leaseId}): ok`,
    ),
  );
  assert.ok(
    lines.includes(`control leases.grant (profile nobody): unknown_profile`),
  );
});

test("AC4: disabling a profile is metadata: its leases keep forwarding and new grants succeed", async () => {
  const gw = await gateway();
  const connection = await ready(gw);
  const lease = await grant(connection, engine(profileA.id));
  const answer = decodeLeasesRevoked(
    await connection.request(
      CONTROL_METHODS.upsertProfile,
      encodeControlRequest({ profile: { ...profileA, enabled: false } }),
    ),
  );
  assert.deepEqual(answer.revoked, []);
  await assertForwards(gw, profileA, lease.token);
  const next = await grant(connection, engine(profileA.id, "w", "s2"));
  await assertForwards(gw, profileA, next.token);
  assert.equal(upstreams.anthropic.length, 2);
});

for (const how of ["profiles.remove", "a sync omitting it"] as const)
  test(`AC5: deleting a profile by ${how} revokes its leases as "the account was removed"`, async () => {
    const gw = await gateway();
    const connection = await ready(gw);
    const a1 = await grant(connection, engine(profileA.id));
    const a2 = await grant(connection, {
      kind: "server",
      profileId: profileA.id,
    });
    const b1 = await grant(connection, engine(profileB.id));
    const revoked =
      how === "profiles.remove"
        ? decodeLeasesRevoked(
            await connection.request(
              CONTROL_METHODS.removeProfile,
              encodeControlRequest({ profileId: profileA.id }),
            ),
          ).revoked
        : await sync(connection, [profileB]);
    assert.deepEqual(revoked.sort(), [a1.leaseId, a2.leaseId].sort());

    const text = refusalText({
      case: "revoked-lease",
      reason: "profile-removed",
    });
    assert.ok(text.includes("(the account was removed)"));
    assert.ok(!text.includes("disabled"));
    await assertRevoked(gw, profileA, a1.token, "profile-removed");
    await assertRevoked(gw, profileA, a2.token, "profile-removed");
    assert.equal(upstreams.anthropic.length, 0);
    await assertForwards(gw, profileB, b1.token);
    await rejectsWith(
      connection.request(
        CONTROL_METHODS.grant,
        encodeControlRequest(engine(profileA.id)),
      ),
      "unknown_profile",
    );
  });

test("AC8: a hello revokes the server leases of other boots and leaves engine leases alone", async () => {
  const gw = await gateway();
  const first = await ready(gw, "boot-x");
  const server = await grant(first, { kind: "server", profileId: profileA.id });
  const engineLease = await grant(first, engine(profileA.id));
  first.end("test");

  const second = control(gw);
  assert.deepEqual(await hello(second, "boot-y"), [server.leaseId]);
  await assertRevoked(gw, profileA, server.token, "session-ended");
  await assertForwards(gw, profileA, engineLease.token);

  const third = control(gw);
  assert.deepEqual(await hello(third, "boot-y"), []);
  await assertForwards(gw, profileA, engineLease.token);
});

test("a newer connection's hello ends the older connection", async () => {
  const gw = await gateway();
  const older = await ready(gw, "boot-x");
  const newer = control(gw);
  await hello(newer, "boot-x");
  assert.equal(await older.ended, "the peer closed the connection");
  assert.deepEqual(await sync(newer, [profileA]), []);
});

test("AC9: reconcileWorker revokes only that Worker's engine leases not in live", async () => {
  const gw = await gateway();
  const connection = await ready(gw, "boot-y");
  const e1 = await grant(connection, engine(profileA.id, "w", "s1"));
  const e2 = await grant(connection, engine(profileA.id, "w", "s2"));
  const f1 = await grant(connection, engine(profileB.id, "v", "s1"));
  const server = await grant(connection, {
    kind: "server",
    profileId: profileA.id,
  });
  const reconcile = async (live: string[]) =>
    decodeLeasesRevoked(
      await connection.request(
        CONTROL_METHODS.reconcileWorker,
        encodeControlRequest({ workerId: "w", live }),
      ),
    ).revoked;

  assert.deepEqual(await reconcile([e1.leaseId]), [e2.leaseId]);
  await assertRevoked(gw, profileA, e2.token, "session-ended");
  await assertForwards(gw, profileA, e1.token);
  await assertForwards(gw, profileB, f1.token);
  await assertForwards(gw, profileA, server.token);

  assert.deepEqual(await reconcile([]), [e1.leaseId]);
  await assertRevoked(gw, profileA, e1.token, "session-ended");
  await assertForwards(gw, profileB, f1.token);
  await assertForwards(gw, profileA, server.token);
});

test("AC20: leases.revoke answers whether it revoked, and takes effect before its answer", async () => {
  const gw = await gateway();
  const connection = await ready(gw);
  const revoke = async (leaseId: string, reason: RevokeReason) =>
    decodeLeaseRevoked(
      await connection.request(
        CONTROL_METHODS.revoke,
        encodeControlRequest({ leaseId, reason }),
      ),
    );
  assert.equal(await revoke("never-granted", "session-ended"), false);
  const lease = await grant(connection, engine(profileA.id));
  assert.equal(await revoke(lease.leaseId, "account-switch"), true);
  await assertRevoked(gw, profileA, lease.token, "account-switch");
  // The first reason stands.
  assert.equal(await revoke(lease.leaseId, "session-ended"), false);
  await assertRevoked(gw, profileA, lease.token, "account-switch");
  assert.equal(upstreams.anthropic.length, 0);
});

test("AC21: leases.bindSession completes an engine lease's owner once", async () => {
  const stateDir = join(await mkdtemp(join(DATA_DIR, "gateway-state-")), "gw");
  const gw = await gateway(stateDir);
  const connection = await ready(gw);
  const lease = await grant(connection, {
    kind: "engine",
    workerId: "w",
    profileId: profileA.id,
  });
  const ownerOnDisk = async () => {
    const document = JSON.parse(
      await readFile(join(stateDir, "leases.json"), "utf8"),
    ) as { leases: { leaseId: string; owner: unknown }[] };
    return document.leases.find((r) => r.leaseId === lease.leaseId)?.owner;
  };
  assert.deepEqual(await ownerOnDisk(), { workerId: "w" });
  const bind = (leaseId: string, sessionId: string) =>
    connection.request(
      CONTROL_METHODS.bindSession,
      encodeControlRequest({ leaseId, sessionId }),
    );

  const answered = await bind(lease.leaseId, "s9");
  assert.deepEqual(answered.json, {});
  assert.deepEqual(await ownerOnDisk(), { workerId: "w", sessionId: "s9" });
  await bind(lease.leaseId, "s9");
  await rejectsWith(bind(lease.leaseId, "s8"), "owner_conflict");
  assert.deepEqual(await ownerOnDisk(), { workerId: "w", sessionId: "s9" });

  const server = await grant(connection, {
    kind: "server",
    profileId: profileA.id,
  });
  await rejectsWith(bind(server.leaseId, "s9"), "invalid_params");
  await rejectsWith(bind("never-granted", "s9"), "unknown_lease");
  const revoked = await grant(connection, {
    kind: "engine",
    workerId: "w",
    profileId: profileA.id,
  });
  await connection.request(
    CONTROL_METHODS.revoke,
    encodeControlRequest({ leaseId: revoked.leaseId, reason: "session-ended" }),
  );
  await rejectsWith(bind(revoked.leaseId, "s9"), "unknown_lease");
});

test("malformed params are invalid_params", async () => {
  const gw = await gateway();
  const connection = await ready(gw);
  const cases: [string, unknown][] = [
    [CONTROL_METHODS.hello, { serverBootId: "", pid: 1, startTime: null }],
    [CONTROL_METHODS.hello, { serverBootId: "b", pid: 0, startTime: null }],
    [CONTROL_METHODS.syncProfiles, { profiles: [profileA, profileA] }],
    [
      CONTROL_METHODS.syncProfiles,
      { profiles: [{ ...profileA, tokenFile: "relative" }] },
    ],
    [CONTROL_METHODS.upsertProfile, { profile: { ...profileA, id: "a/b" } }],
    [
      CONTROL_METHODS.upsertProfile,
      { profile: { ...profileA, name: "n".repeat(201) } },
    ],
    [CONTROL_METHODS.grant, { kind: "other", profileId: profileA.id }],
    [CONTROL_METHODS.grant, { kind: "engine", profileId: profileA.id }],
    [CONTROL_METHODS.revoke, { leaseId: "x", reason: "disabled" }],
    [CONTROL_METHODS.reconcileWorker, { workerId: "w", live: ["bad id"] }],
  ];
  for (const [method, json] of cases)
    await rejectsWith(connection.request(method, { json }), "invalid_params");
  assert.deepEqual(gw.leases.records(), []);
});

/** A connection after hello and a sync of A and B whose `profiles.status` requests land in `statuses`. */
async function heard(
  gw: RunningGateway,
  bootId: string,
): Promise<{ connection: WorkerConnection; statuses: HoldStatus[] }> {
  const statuses: HoldStatus[] = [];
  const connection = dialControl(
    createInProcessTransport(),
    gw.attachControl,
    GATEWAY_CONTROL_PROTOCOL,
    {
      [CONTROL_METHODS.status]: (payload: Payload) => {
        statuses.push(payload.json as HoldStatus);
        return Promise.resolve({ json: {} });
      },
    },
  );
  await hello(connection, bootId);
  await sync(connection, [profileA, profileB]);
  return { connection, statuses };
}

async function loginHold(
  connection: WorkerConnection,
  profileId: string,
  holdId: string,
) {
  return decodeLoginHeld(
    await connection.request(
      CONTROL_METHODS.loginHold,
      encodeControlRequest({ profileId, holdId }),
    ),
  );
}

function loginWriter(
  connection: WorkerConnection,
  holdId: string,
  pid: number,
  startTime: string | null = "77",
): Promise<Payload> {
  return connection.request(
    CONTROL_METHODS.loginWriter,
    encodeControlRequest({ holdId, pid, startTime }),
  );
}

async function release(
  connection: WorkerConnection,
  holdId: string,
  method: string = CONTROL_METHODS.loginRelease,
): Promise<boolean> {
  return decodeHoldReleased(
    await connection.request(method, encodeControlRequest({ holdId })),
  );
}

interface StoredHolds {
  v: number;
  holds: Record<string, unknown>[];
}

async function storedHolds(stateDir: string): Promise<StoredHolds> {
  return JSON.parse(
    await readFile(join(stateDir, "holds.json"), "utf8"),
  ) as StoredHolds;
}

/** Lets the gateway's status requests, sent after their answers, arrive. */
const settled = () =>
  new Promise<void>((resolve) => setImmediate(() => setImmediate(resolve)));

test("AC1: gateway control 1.4 welcomes 1.0 to 1.3 dialers too, and refuses 2.0", async () => {
  assert.equal(GATEWAY_CONTROL_VERSION, "gateway-control/1.4");
  const gw = await gateway();
  for (const version of [
    "gateway-control/1.4",
    "gateway-control/1.3",
    "gateway-control/1.2",
    "gateway-control/1.1",
    "gateway-control/1.0",
  ])
    assert.deepEqual(await rawHandshake(gw, version), [
      { type: "welcome", version: "gateway-control/1.4" },
    ]);
  const refused = await rawHandshake(gw, "gateway-control/2.0");
  assert.equal(refused.length, 1);
  assert.equal(refused[0]!.type, "refused");
});

test("AC2: a login hold is saved before it is held; before hello, for an unknown profile or on a failed save it is not", async () => {
  const stateDir = join(await mkdtemp(join(DATA_DIR, "gateway-state-")), "gw");
  const gw = await gateway(stateDir);
  const early = control(gw);
  await rejectsWith(
    early.request(
      CONTROL_METHODS.loginHold,
      encodeControlRequest({ profileId: profileA.id, holdId: "h0" }),
    ),
    "hello_required",
  );
  const connection = await ready(gw);
  await rejectsWith(loginHold(connection, "nobody", "h0"), "unknown_profile");

  // The writer's temp file cannot be opened while a directory holds its name.
  await mkdir(join(stateDir, "holds.json.tmp"), { recursive: true });
  await rejectsWith(
    loginHold(connection, profileA.id, "h1"),
    "state_write_failed",
  );
  assert.deepEqual(gw.holds(), []);
  assert.ok(
    lines.includes(
      `control profiles.loginHold (profile ${profileA.id}, hold h1): state_write_failed`,
    ),
  );
  await rmdir(join(stateDir, "holds.json.tmp"));

  assert.deepEqual(await loginHold(connection, profileA.id, "h2"), {
    held: true,
  });
  const saved = await storedHolds(stateDir);
  assert.equal(saved.v, 1);
  assert.equal(saved.holds.length, 1);
  const record = saved.holds[0]!;
  assert.equal(record.holdId, "h2");
  assert.equal(record.profileId, profileA.id);
  assert.equal(record.provider, "claude");
  assert.deepEqual(record.owner, {
    serverBootId: "boot-x",
    pid: 4242,
    startTime: "1234",
  });
  assert.equal(
    (record.deadline as number) - (record.acquiredAt as number),
    1_800_000,
  );
  assert.equal((await stat(join(stateDir, "holds.json"))).mode & 0o777, 0o600);
  assert.equal((await stat(stateDir)).mode & 0o777, 0o700);
  assert.deepEqual(
    (await readdir(stateDir)).filter((name) => name.endsWith(".tmp")),
    [],
  );
});

test("AC4: one hold per profile: a second is refused with the standing hold's id; a retried one is the same hold", async () => {
  let now = 1_800_000_000_000;
  const gw = await gateway(undefined, { now: () => now });
  const x = await ready(gw, "boot-x");
  assert.deepEqual(await loginHold(x, profileA.id, "h1"), { held: true });
  assert.deepEqual(await loginHold(x, profileA.id, "h9"), {
    held: false,
    refusal: "hold_exists",
    holdId: "h1",
  });
  assert.deepEqual(await loginHold(x, profileA.id, "h1"), { held: true });
  assert.equal(gw.holds().length, 1);
  // Another profile is its own lane.
  assert.deepEqual(await loginHold(x, profileB.id, "h2"), { held: true });

  const y = await ready(gw, "boot-y");
  assert.deepEqual(await loginHold(y, profileA.id, "h9"), {
    held: false,
    refusal: "login_stuck",
    holdId: "h1",
  });
  assert.deepEqual(await loginHold(y, profileA.id, "h1"), {
    held: false,
    refusal: "login_stuck",
    holdId: "h1",
  });

  const x2 = await ready(gw, "boot-x");
  now += 30 * 60 * 1000;
  gw.checkHolds();
  assert.deepEqual(await loginHold(x2, profileA.id, "h9"), {
    held: false,
    refusal: "login_stuck",
    holdId: "h1",
  });
  assert.equal(gw.holds().length, 2);
});

test("AC5: only the owning boot names a Claude hold's writer, once, and it is saved before the answer", async () => {
  const stateDir = join(await mkdtemp(join(DATA_DIR, "gateway-state-")), "gw");
  const gw = await gateway(stateDir);
  const x = await ready(gw, "boot-x");
  await loginHold(x, profileA.id, "h1");
  await loginHold(x, profileB.id, "h2");
  assert.deepEqual((await loginWriter(x, "h1", 5151)).json, {});
  assert.deepEqual((await storedHolds(stateDir)).holds[0]?.writer, {
    pid: 5151,
    startTime: "77",
  });
  assert.deepEqual((await loginWriter(x, "h1", 5151)).json, {});
  await rejectsWith(loginWriter(x, "h1", 5152), "writer_conflict");
  await rejectsWith(loginWriter(x, "h1", 5151, "78"), "writer_conflict");
  await rejectsWith(loginWriter(x, "h2", 5151), "invalid_params");
  await rejectsWith(loginWriter(x, "nope", 5151), "unknown_hold");
  await rejectsWith(loginWriter(x, "h1", 0), "invalid_params");

  const y = await ready(gw, "boot-y");
  await rejectsWith(loginWriter(y, "h1", 5151), "not_hold_owner");
  assert.deepEqual(gw.holds()[0]?.writer, { pid: 5151, startTime: "77" });

  // A failed save leaves no writer.
  const x2 = await ready(gw, "boot-x");
  await loginHold(x2, profileA.id, "h1");
  await release(x2, "h1");
  await loginHold(x2, profileA.id, "h3");
  await mkdir(join(stateDir, "holds.json.tmp"));
  await rejectsWith(loginWriter(x2, "h3", 6161), "state_write_failed");
  await rmdir(join(stateDir, "holds.json.tmp"));
  assert.equal(
    gw.holds().find((hold) => hold.holdId === "h3")?.writer,
    undefined,
  );
});

test("AC6: release (a) comes from the owning boot only", async () => {
  const stateDir = join(await mkdtemp(join(DATA_DIR, "gateway-state-")), "gw");
  const gw = await gateway(stateDir);
  const x = await ready(gw, "boot-x");
  await loginHold(x, profileA.id, "h1");

  const y = await ready(gw, "boot-y");
  assert.equal(x.isEnded, true, "the newer hello superseded it");
  await rejectsWith(release(y, "h1"), "not_hold_owner");
  assert.deepEqual(
    gw.holds().map((hold) => hold.holdId),
    ["h1"],
  );
  assert.ok(
    lines.includes(
      `control profiles.loginRelease (profile ${profileA.id}, hold h1): not_hold_owner`,
    ),
  );

  const x2 = await ready(gw, "boot-x");
  assert.equal(await release(x2, "h1"), true);
  assert.deepEqual((await storedHolds(stateDir)).holds, []);
  assert.deepEqual(await loginHold(x2, profileA.id, "h2"), { held: true });
  assert.equal(await release(x2, "never-held"), false);
});

test("AC11: force release clears a stuck hold from any boot and reports it", async () => {
  let now = 1_800_000_000_000;
  const gw = await gateway(undefined, { now: () => now });
  const x = await ready(gw, "boot-x");
  await loginHold(x, profileA.id, "h1");
  now += 30 * 60 * 1000;
  gw.checkHolds();

  const y = await heard(gw, "boot-y");
  await settled();
  assert.deepEqual(y.statuses, [
    { profileId: profileA.id, loginStuck: true, holdId: "h1" },
  ]);
  assert.equal(
    await release(y.connection, "h1", CONTROL_METHODS.loginForceRelease),
    true,
  );
  await settled();
  assert.deepEqual(y.statuses.at(-1), {
    profileId: profileA.id,
    loginStuck: false,
    holdId: "h1",
  });
  assert.deepEqual(gw.holds(), []);
  assert.deepEqual(await loginHold(y.connection, profileA.id, "h2"), {
    held: true,
  });
  await rejectsWith(
    release(y.connection, "never-held", CONTROL_METHODS.loginForceRelease),
    "unknown_hold",
  );
  // A hold that is not stuck is cleared without a status.
  const count = y.statuses.length;
  assert.equal(
    await release(y.connection, "h2", CONTROL_METHODS.loginForceRelease),
    true,
  );
  await settled();
  assert.equal(y.statuses.length, count);
});

test("the hold methods' malformed params are invalid_params", async () => {
  const gw = await gateway();
  const connection = await ready(gw);
  const cases: [string, unknown][] = [
    [CONTROL_METHODS.loginHold, { profileId: profileA.id, holdId: "a b" }],
    [CONTROL_METHODS.loginHold, { profileId: "a/b", holdId: "h1" }],
    [
      CONTROL_METHODS.loginHold,
      { profileId: profileA.id, holdId: "h".repeat(65) },
    ],
    [CONTROL_METHODS.loginWriter, { holdId: "h1", pid: 1, startTime: "x" }],
    [CONTROL_METHODS.loginRelease, { holdId: "" }],
    [CONTROL_METHODS.loginForceRelease, {}],
  ];
  for (const [method, json] of cases)
    await rejectsWith(connection.request(method, { json }), "invalid_params");
  assert.deepEqual(gw.holds(), []);
});

test("AC1: the registry takes a tokenless OpenAI-compatible profile; a compatible one with a token file, or a login without one, is invalid_params", async () => {
  const gw = await gateway();
  const connection = control(gw);
  await hello(connection, "boot-x");
  assert.deepEqual(await sync(connection, [profileA, profileB, compatA]), []);

  // A grant binds no token file for it, even one the request names.
  const smuggled = decodeLeaseGranted(
    await connection.request(CONTROL_METHODS.grant, {
      json: { ...engine(compatA.id), tokenFile: profileA.tokenFile },
    }),
  );
  capabilities.push(smuggled.token, smuggled.token.split(".")[2]!);
  const record = gw.leases
    .records()
    .find((r) => r.leaseId === smuggled.leaseId)!;
  assert.equal(record.provider, "openai-compatible");
  assert.equal("tokenFile" in record, false);

  const malformed = [
    { ...compatA, tokenFile: profileA.tokenFile },
    {
      id: profileA.id,
      provider: profileA.provider,
      name: profileA.name,
      enabled: true,
    },
  ];
  for (const profile of malformed) {
    await rejectsWith(
      connection.request(CONTROL_METHODS.syncProfiles, {
        json: { profiles: [profileA, profile] },
      }),
      "invalid_params",
    );
    await rejectsWith(
      connection.request(CONTROL_METHODS.upsertProfile, {
        json: { profile },
      }),
      "invalid_params",
    );
  }
  // Nothing changed: the compatible lease is still live.
  assert.equal(
    gw.leases.records().find((r) => r.leaseId === smuggled.leaseId)?.revoked,
    undefined,
  );
});

test("AC3, AC16: compat.set and compat.clear name a registered compatible profile; a refused URL or key clears that profile's pair only", async () => {
  const a = await startFakeCompatEndpoint(["m"], "reply a");
  const b = await startFakeCompatEndpoint(["m"], "reply b");
  // A real path, padded with slashes the gateway strips: exactly 2048 bytes.
  const long = await startFakeCompatEndpoint(["m"], "reply long", {
    basePath: `/${"p".repeat(2000)}`,
  });
  const LONG_KEY = COMPAT_KEY_A.padEnd(8192, "k");
  // No log line may name a pushed key or an endpoint.
  for (const endpoint of [a, b, long])
    capabilities.push(endpoint.baseUrl, new URL(endpoint.baseUrl).host);
  capabilities.push(COMPAT_KEY_A, COMPAT_KEY_B, LONG_KEY);
  try {
    const gw = await gateway();
    const validA = {
      profileId: compatA.id,
      baseUrl: a.baseUrl,
      apiKey: COMPAT_KEY_A,
    };
    const validB = {
      profileId: compatB.id,
      baseUrl: b.baseUrl,
      apiKey: COMPAT_KEY_B,
    };
    const early = control(gw);
    await rejectsWith(
      early.request(CONTROL_METHODS.compatSet, { json: validA }),
      "hello_required",
    );
    await rejectsWith(
      early.request(CONTROL_METHODS.compatClear, {
        json: { profileId: compatA.id },
      }),
      "hello_required",
    );

    const connection = control(gw);
    await hello(connection, "boot-x");
    await sync(connection, [profileA, profileB, compatA, compatB]);
    const tokenA = (await grant(connection, engine(compatA.id))).token;
    const tokenB = (
      await grant(connection, { kind: "server", profileId: compatB.id })
    ).token;
    const set = (json: unknown) =>
      connection.request(CONTROL_METHODS.compatSet, { json });
    const clear = (json: unknown) =>
      connection.request(CONTROL_METHODS.compatClear, { json });
    const compatRequest = (token: string, basePath = "/v1") =>
      modelRequest(gw.port, `/compat${basePath}/chat/completions`, token);
    const assertUnset = async (token: string) => {
      const reply = await compatRequest(token);
      assert.equal(reply.status, 503, reply.text);
      assert.equal(
        JSON.parse(reply.text).error.message,
        refusalText({ case: "compat-unset" }),
      );
    };
    const posts = (endpoint: typeof a) =>
      endpoint.seen.filter((seen) => seen.method === "POST").length;

    assert.deepEqual((await set(validA)).json, {});
    assert.deepEqual((await set(validB)).json, {});
    assert.equal((await compatRequest(tokenA)).status, 200);
    assert.equal((await compatRequest(tokenB)).status, 200);

    // A profile the push cannot be for: refused, and no pair is cleared.
    await rejectsWith(
      set({ ...validA, profileId: "openai-compatible-cccccccccccc" }),
      "unknown_profile",
    );
    await rejectsWith(
      set({ ...validA, profileId: profileB.id }),
      "invalid_params",
    );
    await rejectsWith(set({ ...validA, profileId: "a/b" }), "invalid_params");
    await rejectsWith(
      set({ baseUrl: a.baseUrl, apiKey: COMPAT_KEY_A }),
      "invalid_params",
    );
    await rejectsWith(clear({}), "invalid_params");
    await rejectsWith(clear({ profileId: "a/b" }), "invalid_params");
    assert.equal((await compatRequest(tokenA)).status, 200);
    assert.equal(posts(a), 2);

    // AC16's bounds: an 8192-character key and a 2048-byte URL are held.
    const longUrl = long.baseUrl.padEnd(2048, "/");
    assert.equal(Buffer.byteLength(longUrl), 2048);
    assert.deepEqual(
      (await set({ ...validA, baseUrl: longUrl, apiKey: LONG_KEY })).json,
      {},
    );
    const longPath = new URL(long.baseUrl).pathname;
    assert.equal((await compatRequest(tokenA, longPath)).status, 200);
    assert.equal(long.seen.at(-1)?.authorization, `Bearer ${LONG_KEY}`);

    const malformed: Record<string, unknown>[] = [
      { baseUrl: 7 },
      { baseUrl: undefined },
      { baseUrl: `${longUrl}/` },
      { baseUrl: "not a url" },
      { baseUrl: "ftp://127.0.0.1/v1" },
      { baseUrl: "http://fixture:fixture@127.0.0.1/v1" },
      { baseUrl: `${a.baseUrl}?q=1` },
      { baseUrl: `${a.baseUrl}#f` },
      { apiKey: 5 },
      { apiKey: undefined },
      { apiKey: "" },
      { apiKey: `${LONG_KEY}k` },
      { apiKey: HEADER_INJECTING_KEY },
      { apiKey: "key\nx" },
      { apiKey: "key\u0000x" },
      { apiKey: "key x" },
      { apiKey: "key\u007fx" },
      { apiKey: "kéy" },
    ];
    for (const change of malformed) {
      assert.deepEqual((await set(validA)).json, {});
      await rejectsWith(set({ ...validA, ...change }), "invalid_params");
      await assertUnset(tokenA);
      assert.equal(
        (await compatRequest(tokenB)).status,
        200,
        "B keeps its pair",
      );
    }
    assert.equal(posts(a), 2, "no refused request reached the endpoint");
    assert.ok(
      lines.includes(
        `control compat.set (profile ${compatA.id}): invalid_params`,
      ),
    );

    assert.deepEqual((await set(validA)).json, {});
    assert.deepEqual((await clear({ profileId: compatA.id })).json, {});
    await assertUnset(tokenA);
    assert.equal((await compatRequest(tokenB)).status, 200);
    assert.equal(posts(a), 2);
  } finally {
    for (const endpoint of [a, b, long]) await endpoint.close();
  }
});

test("AC7: a compatible profile is never fenced or held: loginHold answers unknown_profile, a fence pending or not", async () => {
  const gw = await gateway();
  const connection = control(gw);
  await hello(connection, "boot-x");
  await sync(connection, [profileA, compatA]);
  await rejectsWith(loginHold(connection, compatA.id, "h1"), "unknown_profile");
  assert.deepEqual(gw.holds(), []);
  running.splice(running.indexOf(gw), 1);
  await gw.close();

  // An unreadable holds.json fences only the login profiles it registers.
  const stateDir = join(await mkdtemp(join(DATA_DIR, "gateway-state-")), "gw");
  const first = await gateway(stateDir);
  const x = control(first);
  await hello(x, "boot-x");
  await sync(x, [profileA, compatA]);
  running.splice(running.indexOf(first), 1);
  await first.close();
  await writeFile(join(stateDir, "holds.json"), "{");
  const fenced = await gateway(stateDir);
  assert.deepEqual(
    fenced.holds().map((hold) => hold.profileId),
    [profileA.id],
  );
  const y = control(fenced);
  await hello(y, "boot-y");
  await rejectsWith(loginHold(y, compatA.id, "h1"), "unknown_profile");
  assert.equal((await loginHold(y, profileA.id, "h2")).held, false);

  // With no registry the fence waits for a login profile: a sync of only
  // compatible ones leaves it pending, and they are still refused.
  const emptyDir = join(await mkdtemp(join(DATA_DIR, "gateway-state-")), "gw");
  await mkdir(emptyDir, { recursive: true, mode: 0o700 });
  await writeFile(join(emptyDir, "holds.json"), "{", { mode: 0o600 });
  const pending = await gateway(emptyDir);
  const z = control(pending);
  await hello(z, "boot-z");
  await sync(z, [compatA, compatB]);
  assert.deepEqual(pending.holds(), []);
  for (const profile of [compatA, compatB])
    await rejectsWith(loginHold(z, profile.id, "h3"), "unknown_profile");
  for (const profileId of [profileA.id, "nobody"])
    assert.deepEqual(await loginHold(z, profileId, "h4"), {
      held: false,
      refusal: "login_stuck",
    });
  assert.deepEqual(pending.holds(), []);
});

test("AC15: profiles.credential decodes only a profile id and a boolean", () => {
  assert.deepEqual(
    decodeCredentialStatus(
      encodeCredentialStatus({ profileId: profileA.id, needsLogin: true }),
    ),
    { profileId: profileA.id, needsLogin: true },
  );
  for (const json of [
    { profileId: "a/b", needsLogin: true },
    { profileId: "", needsLogin: false },
    { profileId: profileA.id, needsLogin: "true" },
    { profileId: profileA.id, needsLogin: 1 },
    { profileId: profileA.id },
    {},
  ])
    assert.throws(
      () => decodeCredentialStatus({ json }),
      (err) =>
        err instanceof WorkerMethodError && err.code === "invalid_params",
    );
});

test("AC15: gateway control 1.4 still welcomes a 1.2 dialer", async () => {
  assert.equal(GATEWAY_CONTROL_VERSION, "gateway-control/1.4");
  const gw = await gateway();
  assert.deepEqual(await rawHandshake(gw, "gateway-control/1.2"), [
    { type: "welcome", version: "gateway-control/1.4" },
  ]);
});

test("AC15: a needs-login is resent to the connection of a new hello", async () => {
  const gw = await gateway();
  const missing: GatewayProfile = {
    ...profileA,
    id: "claude-gone",
    name: "Gone Claude",
    tokenFile: join(
      await mkdtemp(join(DATA_DIR, "gateway-gone-")),
      ".credentials.json",
    ),
  };
  const listen = async (bootId: string) => {
    const credential: CredentialStatus[] = [];
    const connection = dialControl(
      createInProcessTransport(),
      gw.attachControl,
      GATEWAY_CONTROL_PROTOCOL,
      {
        [CONTROL_METHODS.credential]: (payload: Payload) => {
          credential.push(decodeCredentialStatus(payload));
          return Promise.resolve({ json: {} });
        },
      },
    );
    await hello(connection, bootId);
    await sync(connection, [profileA, profileB, missing]);
    return { connection, credential };
  };
  const first = await listen("boot-x");
  const { token } = await grant(first.connection, engine(missing.id));
  const reply = await forward(gw, missing, token);
  assert.equal(reply.status, 401);
  assert.equal(
    JSON.parse(reply.text).error.message,
    refusalText({ case: "needs-login", name: missing.name }),
  );
  await settled();
  assert.deepEqual(first.credential, [
    { profileId: missing.id, needsLogin: true },
  ]);

  const second = await listen("boot-y");
  await settled();
  assert.deepEqual(second.credential, [
    { profileId: missing.id, needsLogin: true },
  ]);
});
