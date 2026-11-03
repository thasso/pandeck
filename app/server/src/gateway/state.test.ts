/**
 * The gateway's state directory: private files holding hashes and paths only,
 * a gateway-only restart that forwards with control down, pruning of revoked
 * leases, unreadable state, owner completion across a restart, and write
 * failures. Every credential is fake; every state directory is under the
 * test's temp `DATA_DIR`.
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
  dialControl,
  modelRequest,
  startFakeUpstreams,
  writeTokenFiles,
  type FakeUpstreams,
} from "../test/gatewayFixtures.ts";
import {
  WorkerRequestError,
  type WorkerConnection,
} from "../workerProtocol/connection.ts";
import { createInProcessTransport } from "../workerProtocol/inProcessTransport.ts";
import {
  CONTROL_METHODS,
  GATEWAY_CONTROL_PROTOCOL,
  decodeLeaseGranted,
  decodeLeasesRevoked,
  encodeControlRequest,
} from "./controlMethods.ts";
import { startGateway, type RunningGateway } from "./gateway.ts";
import { LeaseTable } from "./leases.ts";
import type { GatewayProfile } from "./profiles.ts";
import { refusalText, type Refusal, type RevokeReason } from "./refusals.ts";

const HOUR = 60 * 60 * 1000;
const T0 = 1_800_000_000_000;

let upstreams: FakeUpstreams;
let profileA: GatewayProfile;
let profileB: GatewayProfile;
const running: RunningGateway[] = [];
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
  for (const line of lines)
    for (const value of [
      ...capabilities,
      CLAUDE_ACCESS,
      CODEX_ACCESS,
      CODEX_ACCOUNT,
    ])
      assert.ok(!line.includes(value), `a log line leaks: ${line}`);
  while (running.length) await running.pop()!.close();
  upstreams.reset();
  lines = [];
  capabilities = [];
});

afterAll(async () => {
  await upstreams.close();
});

async function freshStateDir(): Promise<string> {
  await mkdir(DATA_DIR, { recursive: true });
  return join(await mkdtemp(join(DATA_DIR, "gateway-state-")), "gateway");
}

async function gateway(
  stateDir: string,
  now?: () => number,
): Promise<RunningGateway> {
  const gw = await startGateway({
    log: (line) => lines.push(line),
    upstreams: upstreams.overrides,
    stateDir,
    ...(now ? { now } : {}),
  });
  running.push(gw);
  return gw;
}

async function close(gw: RunningGateway): Promise<void> {
  running.splice(running.indexOf(gw), 1);
  for (const record of gw.leases.records())
    capabilities.push(record.secretHash);
  await gw.close();
}

async function ready(gw: RunningGateway): Promise<WorkerConnection> {
  const connection = dialControl(
    createInProcessTransport(),
    gw.attachControl,
    GATEWAY_CONTROL_PROTOCOL,
  );
  await connection.request(
    CONTROL_METHODS.hello,
    encodeControlRequest({
      serverBootId: "boot-x",
      pid: 4242,
      startTime: null,
    }),
  );
  await connection.request(
    CONTROL_METHODS.syncProfiles,
    encodeControlRequest({ profiles: [profileA, profileB] }),
  );
  return connection;
}

async function grant(
  connection: WorkerConnection,
  profileId: string,
  sessionId?: string,
): Promise<{ leaseId: string; token: string }> {
  const granted = decodeLeaseGranted(
    await connection.request(
      CONTROL_METHODS.grant,
      encodeControlRequest({
        kind: "engine",
        workerId: "w",
        ...(sessionId ? { sessionId } : {}),
        profileId,
      }),
    ),
  );
  capabilities.push(granted.token, granted.token.split(".")[2]!);
  return granted;
}

async function revoke(
  connection: WorkerConnection,
  leaseId: string,
): Promise<unknown> {
  return (
    await connection.request(
      CONTROL_METHODS.revoke,
      encodeControlRequest({ leaseId, reason: "session-ended" }),
    )
  ).json;
}

/** The refusal text a Claude request with `token` gets, or "forwarded". */
async function claudeOutcome(
  gw: RunningGateway,
  token: string,
): Promise<string> {
  const reply = await modelRequest(gw.port, CLAUDE_PATH, token);
  if (reply.status === 200) return "forwarded";
  assert.equal(reply.status, 401, reply.text);
  return JSON.parse(reply.text).error.message as string;
}

const text = (refusal: Refusal) => refusalText(refusal);
const SESSION_ENDED = text({ case: "revoked-lease", reason: "session-ended" });
const UNKNOWN = text({ case: "unknown-lease" });

interface StoredLeases {
  v: number;
  leases: Record<string, unknown>[];
}

async function storedLeases(stateDir: string): Promise<StoredLeases> {
  return JSON.parse(
    await readFile(join(stateDir, "leases.json"), "utf8"),
  ) as StoredLeases;
}

test("AC6: the state directory is private and holds hashes and paths only", async () => {
  const stateDir = await freshStateDir();
  const gw = await gateway(stateDir);
  const connection = await ready(gw);
  // On disk by the time the grant answers.
  let onDisk: StoredLeases | undefined;
  const lease = await connection
    .request(
      CONTROL_METHODS.grant,
      encodeControlRequest({
        kind: "engine",
        workerId: "w",
        profileId: profileA.id,
      }),
    )
    .then(async (answer) => {
      const granted = decodeLeaseGranted(answer);
      onDisk = await storedLeases(stateDir);
      return granted;
    });
  capabilities.push(lease.token, lease.token.split(".")[2]!);
  assert.ok(onDisk?.leases.some((r) => r.leaseId === lease.leaseId));
  const other = await grant(connection, profileB.id, "s2");

  assert.equal((await stat(stateDir)).mode & 0o777, 0o700);
  for (const name of ["leases.json", "profiles.json"])
    assert.equal((await stat(join(stateDir, name))).mode & 0o777, 0o600);
  assert.deepEqual((await readdir(stateDir)).sort(), [
    "leases.json",
    "profiles.json",
  ]);

  const stored = await storedLeases(stateDir);
  assert.equal(stored.v, 1);
  for (const record of stored.leases)
    assert.deepEqual(Object.keys(record).sort(), [
      "grantedAt",
      "kind",
      "leaseId",
      "owner",
      "profileId",
      "provider",
      "secretHash",
      "tokenFile",
    ]);
  const profiles = JSON.parse(
    await readFile(join(stateDir, "profiles.json"), "utf8"),
  ) as { v: number; profiles: unknown[] };
  assert.deepEqual(profiles, { v: 1, profiles: [profileA, profileB] });
  for (const name of ["leases.json", "profiles.json"]) {
    const content = await readFile(join(stateDir, name), "utf8");
    for (const secret of [
      lease.token,
      lease.token.split(".")[2]!,
      other.token,
      other.token.split(".")[2]!,
      CLAUDE_ACCESS,
      CODEX_ACCESS,
      CODEX_ACCOUNT,
    ])
      assert.ok(!content.includes(secret), `${name} holds a secret`);
  }
});

test("AC7: a gateway-only restart with control down still forwards, and revocations hold", async () => {
  const stateDir = await freshStateDir();
  const first = await gateway(stateDir);
  const connection = await ready(first);
  const l1 = await grant(connection, profileA.id, "s1");
  const l2 = await grant(connection, profileA.id, "s2");
  assert.deepEqual(await revoke(connection, l2.leaseId), { revoked: true });
  await close(first);

  const second = await gateway(stateDir);
  assert.equal(await claudeOutcome(second, l1.token), "forwarded");
  assert.equal(
    upstreams.anthropic[0]!.headers.authorization,
    `Bearer ${CLAUDE_ACCESS}`,
  );
  assert.equal(await claudeOutcome(second, l2.token), SESSION_ENDED);
  const stranger = new LeaseTable().grant(
    {
      profileId: profileA.id,
      provider: "claude",
      tokenFile: profileA.tokenFile,
    },
    { kind: "engine", owner: { workerId: "w" } },
  );
  assert.equal(await claudeOutcome(second, stranger.token), UNKNOWN);
  assert.equal(upstreams.anthropic.length, 1);
});

test("AC10: a revoked lease is pruned 24 h after its revocation, a live one never", async () => {
  const stateDir = await freshStateDir();
  let now = T0;
  const gw = await gateway(stateDir, () => now);
  const connection = await ready(gw);
  const live = await grant(connection, profileA.id, "live");
  const revoked = await grant(connection, profileA.id, "gone");
  await revoke(connection, revoked.leaseId);
  const ids = async () =>
    (await storedLeases(stateDir)).leases.map((r) => r.leaseId);

  now = T0 + 23 * HOUR;
  await grant(connection, profileB.id, "write-23h");
  assert.ok((await ids()).includes(revoked.leaseId));
  assert.equal(await claudeOutcome(gw, revoked.token), SESSION_ENDED);

  now = T0 + 25 * HOUR;
  await grant(connection, profileB.id, "write-25h");
  assert.ok(!(await ids()).includes(revoked.leaseId));
  assert.ok((await ids()).includes(live.leaseId));
  assert.equal(await claudeOutcome(gw, revoked.token), UNKNOWN);
  assert.equal(await claudeOutcome(gw, live.token), "forwarded");
});

test("AC10: a restart 25 h after a revocation forgets it", async () => {
  const stateDir = await freshStateDir();
  let now = T0;
  const first = await gateway(stateDir, () => now);
  const connection = await ready(first);
  const live = await grant(connection, profileA.id, "live");
  const revoked = await grant(connection, profileA.id, "gone");
  await revoke(connection, revoked.leaseId);
  await close(first);

  now = T0 + 25 * HOUR;
  const second = await gateway(stateDir, () => now);
  assert.deepEqual(
    second.leases.records().map((r) => r.leaseId),
    [live.leaseId],
  );
  assert.equal(await claudeOutcome(second, revoked.token), UNKNOWN);
  assert.equal(await claudeOutcome(second, live.token), "forwarded");
});

test("AC11: an unreadable leases.json is logged by name and refuses every old token", async () => {
  const stateDir = await freshStateDir();
  const first = await gateway(stateDir);
  const lease = await grant(await ready(first), profileA.id, "s1");
  await close(first);
  await writeFile(join(stateDir, "leases.json"), "{");
  lines = [];

  const second = await gateway(stateDir);
  assert.deepEqual(
    lines.filter((line) => line.includes("leases.json")),
    ["leases.json unreadable; starting without it"],
  );
  assert.equal(await claudeOutcome(second, lease.token), UNKNOWN);
  assert.equal(upstreams.anthropic.length, 0);
});

test("AC11: an unreadable profiles.json empties the registry; restored leases forward until a sync omits their profile", async () => {
  const stateDir = await freshStateDir();
  const first = await gateway(stateDir);
  const lease = await grant(await ready(first), profileA.id, "s1");
  await close(first);
  await writeFile(
    join(stateDir, "profiles.json"),
    JSON.stringify({ v: 2, profiles: [profileA, profileB] }),
  );
  lines = [];

  const second = await gateway(stateDir);
  assert.deepEqual(
    lines.filter((line) => line.includes("profiles.json")),
    ["profiles.json unreadable; starting without it"],
  );
  const connection = dialControl(
    createInProcessTransport(),
    second.attachControl,
    GATEWAY_CONTROL_PROTOCOL,
  );
  await connection.request(
    CONTROL_METHODS.hello,
    encodeControlRequest({
      serverBootId: "boot-y",
      pid: 4242,
      startTime: null,
    }),
  );
  await assert.rejects(
    connection.request(
      CONTROL_METHODS.grant,
      encodeControlRequest({
        kind: "engine",
        workerId: "w",
        profileId: profileA.id,
      }),
    ),
    (err) =>
      err instanceof WorkerRequestError && err.code === "unknown_profile",
  );
  assert.equal(await claudeOutcome(second, lease.token), "forwarded");

  const revoked = decodeLeasesRevoked(
    await connection.request(
      CONTROL_METHODS.syncProfiles,
      encodeControlRequest({ profiles: [profileB] }),
    ),
  );
  assert.deepEqual(revoked.revoked, [lease.leaseId]);
  assert.equal(
    await claudeOutcome(second, lease.token),
    text({ case: "revoked-lease", reason: "profile-removed" }),
  );
});

test("AC11: a lease record that does not validate is skipped and the rest load", async () => {
  const stateDir = await freshStateDir();
  const first = await gateway(stateDir);
  const connection = await ready(first);
  const kept = await grant(connection, profileA.id, "s1");
  const broken = await grant(connection, profileA.id, "s2");
  await close(first);
  const stored = await storedLeases(stateDir);
  for (const record of stored.leases)
    if (record.leaseId === broken.leaseId) record.leaseId = "not a lease id";
  await writeFile(join(stateDir, "leases.json"), JSON.stringify(stored));
  lines = [];

  const second = await gateway(stateDir);
  assert.deepEqual(
    lines.filter((line) => line.includes("leases.json")),
    ["leases.json: skipped 1 unreadable record(s); loading the rest"],
  );
  assert.equal(await claudeOutcome(second, kept.token), "forwarded");
  assert.equal(await claudeOutcome(second, broken.token), UNKNOWN);
});

test("AC21: a completed owner survives a restart", async () => {
  const stateDir = await freshStateDir();
  const first = await gateway(stateDir);
  const connection = await ready(first);
  const lease = await grant(connection, profileA.id);
  await connection.request(
    CONTROL_METHODS.bindSession,
    encodeControlRequest({ leaseId: lease.leaseId, sessionId: "s9" }),
  );
  await close(first);

  const second = await gateway(stateDir);
  const record = second.leases
    .records()
    .find((r) => r.leaseId === lease.leaseId);
  assert.equal(record?.kind, "engine");
  assert.deepEqual(record?.owner, { workerId: "w", sessionId: "s9" });
});

test("a failed write answers state_write_failed: a grant or bind is undone, a revocation stays in force", async () => {
  const stateDir = await freshStateDir();
  const gw = await gateway(stateDir);
  const connection = await ready(gw);
  const bound = await grant(connection, profileA.id);
  const live = await grant(connection, profileA.id, "s1");
  const before = gw.leases.records();
  // The writer's temp file cannot be opened while a directory holds its name.
  await mkdir(join(stateDir, "leases.json.tmp"));

  await failsToWrite(
    connection.request(
      CONTROL_METHODS.grant,
      encodeControlRequest({
        kind: "engine",
        workerId: "w",
        profileId: profileA.id,
      }),
    ),
  );
  await failsToWrite(
    connection.request(
      CONTROL_METHODS.bindSession,
      encodeControlRequest({ leaseId: bound.leaseId, sessionId: "s9" }),
    ),
  );
  assert.deepEqual(gw.leases.records(), before);

  await failsToWrite(
    connection.request(
      CONTROL_METHODS.revoke,
      encodeControlRequest({ leaseId: live.leaseId, reason: "session-ended" }),
    ),
  );
  assert.equal(await claudeOutcome(gw, live.token), SESSION_ENDED);
  assert.ok(
    lines.includes(
      `control leases.revoke (lease ${live.leaseId}): state_write_failed`,
    ),
  );
});

/** Rejects unless `answer` fails with `state_write_failed`. */
const failsToWrite = (answer: Promise<unknown>) =>
  assert.rejects(
    answer,
    (err) =>
      err instanceof WorkerRequestError && err.code === "state_write_failed",
  );

interface RetryCase {
  method: string;
  /** Grants the lease the method then revokes. */
  setup(
    connection: WorkerConnection,
  ): Promise<{ leaseId: string; token: string }>;
  /** The request; profiles exist only once `beforeAll` ran. */
  params(leaseId: string): Parameters<typeof encodeControlRequest>[0];
  reason: RevokeReason;
  /** The answer once the retry saves. */
  retried: unknown;
}

const engineLease = (connection: WorkerConnection) =>
  grant(connection, profileA.id, "s1");

const RETRY_CASES: RetryCase[] = [
  {
    method: CONTROL_METHODS.revoke,
    setup: engineLease,
    params: (leaseId) => ({ leaseId, reason: "session-ended" }),
    reason: "session-ended",
    // RD-G2a1-1: a lease already revoked answers false.
    retried: { revoked: false },
  },
  {
    method: CONTROL_METHODS.reconcileWorker,
    setup: engineLease,
    params: () => ({ workerId: "w", live: [] }),
    reason: "session-ended",
    retried: { revoked: [] },
  },
  {
    method: CONTROL_METHODS.hello,
    setup: async (connection) => {
      const granted = decodeLeaseGranted(
        await connection.request(
          CONTROL_METHODS.grant,
          encodeControlRequest({ kind: "server", profileId: profileA.id }),
        ),
      );
      capabilities.push(granted.token, granted.token.split(".")[2]!);
      return granted;
    },
    params: () => ({ serverBootId: "boot-y", pid: 4242, startTime: null }),
    reason: "session-ended",
    retried: { revoked: [] },
  },
  {
    method: CONTROL_METHODS.syncProfiles,
    setup: engineLease,
    params: () => ({ profiles: [profileB] }),
    reason: "profile-removed",
    retried: { revoked: [] },
  },
  {
    method: CONTROL_METHODS.removeProfile,
    setup: engineLease,
    params: () => ({ profileId: profileA.id }),
    reason: "profile-removed",
    retried: { revoked: [] },
  },
];

for (const retry of RETRY_CASES)
  test(`a retried ${retry.method} after a failed write saves the revocation, keeping its first reason and time`, async () => {
    const stateDir = await freshStateDir();
    let now = T0;
    const first = await gateway(stateDir, () => now);
    const connection = await ready(first);
    const lease = await retry.setup(connection);
    const request = () =>
      connection.request(
        retry.method,
        encodeControlRequest(retry.params(lease.leaseId)),
      );
    const refusal = text({ case: "revoked-lease", reason: retry.reason });
    const blocker = join(stateDir, "leases.json.tmp");
    await mkdir(blocker);

    await failsToWrite(request());
    assert.equal(await claudeOutcome(first, lease.token), refusal);
    now = T0 + HOUR;
    // Still failing: the unsaved revocation must not answer as saved.
    await failsToWrite(request());

    await rmdir(blocker);
    now = T0 + 2 * HOUR;
    assert.deepEqual((await request()).json, retry.retried);
    const stored = (await storedLeases(stateDir)).leases.find(
      (record) => record.leaseId === lease.leaseId,
    );
    assert.equal(stored?.revoked, retry.reason);
    assert.equal(stored?.revokedAt, T0);
    await close(first);

    const second = await gateway(stateDir, () => now);
    assert.equal(await claudeOutcome(second, lease.token), refusal);
    assert.equal(upstreams.anthropic.length, 0);
  });

test("a retried profiles.remove after a failed write saves the removal", async () => {
  const stateDir = await freshStateDir();
  const first = await gateway(stateDir);
  const connection = await ready(first);
  const remove = () =>
    connection.request(
      CONTROL_METHODS.removeProfile,
      encodeControlRequest({ profileId: profileA.id }),
    );
  const blocker = join(stateDir, "profiles.json.tmp");
  await mkdir(blocker);

  await failsToWrite(remove());
  await failsToWrite(remove());

  await rmdir(blocker);
  assert.deepEqual((await remove()).json, { revoked: [] });
  const stored = JSON.parse(
    await readFile(join(stateDir, "profiles.json"), "utf8"),
  ) as { v: number; profiles: unknown[] };
  assert.deepEqual(stored, { v: 1, profiles: [profileB] });
  await close(first);

  const second = await gateway(stateDir);
  const control = dialControl(
    createInProcessTransport(),
    second.attachControl,
    GATEWAY_CONTROL_PROTOCOL,
  );
  await control.request(
    CONTROL_METHODS.hello,
    encodeControlRequest({
      serverBootId: "boot-y",
      pid: 4242,
      startTime: null,
    }),
  );
  await assert.rejects(
    control.request(
      CONTROL_METHODS.grant,
      encodeControlRequest({
        kind: "engine",
        workerId: "w",
        profileId: profileA.id,
      }),
    ),
    (err) =>
      err instanceof WorkerRequestError && err.code === "unknown_profile",
  );
});
