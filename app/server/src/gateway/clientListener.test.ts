/**
 * The edge's client listener (`clientListener.ts`, plan Task-1384): enrollment
 * with one-time codes, mutual TLS on the model and client ports with the
 * client checked per connection and per request, and leases scoped to their
 * client. Fake upstreams and fake token files under the test's `DATA_DIR`.
 */
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { generateKeyPairSync, X509Certificate } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, writeFile, unlink, rename } from "node:fs/promises";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import { join } from "node:path";
import tls from "node:tls";
import { afterAll, afterEach, beforeAll, test, vi } from "vitest";
import { DATA_DIR } from "../config.ts";
import {
  CLAUDE_PATH,
  modelRequest as loopbackRequest,
  startFakeUpstreams,
  writeTokenFiles,
  type FakeUpstreams,
} from "../test/gatewayFixtures.ts";
import {
  WorkerConnection,
  WorkerRequestError,
} from "../workerProtocol/connection.ts";
import {
  CLIENT_METHODS,
  GATEWAY_CLIENT_PROTOCOL,
  decodeAccounts,
  encodeClientMessage,
} from "./clientMethods.ts";
import { decodeLeaseGranted, decodeLeaseRevoked } from "./controlMethods.ts";
import { startGateway, type RunningGateway } from "./gateway.ts";
import { socketEndpoint } from "../workerProtocol/unixSocketTransport.ts";
import { edgeTlsFor, issueClientCertificate } from "./x509.ts";
import { ClientRegistry } from "./clientRegistry.ts";
import { modelConnection, type ModelDeadlines } from "./clientListener.ts";
import type { LoginDrivers } from "./vaultPort.ts";
import type { EdgeTools, IntegrationCheck, ToolAnswer } from "./edgeTools.ts";
type LoginDriverEvents = Parameters<NonNullable<LoginDrivers["claude"]>>[1];

interface Identity {
  clientId: string;
  key: string;
  cert: string;
}

let upstreams: FakeUpstreams;
let claudeFile: string;
let clock = Date.now();
const open: { close(): unknown }[] = [];
const stateDirs = new WeakMap<RunningGateway, string>();

beforeAll(async () => {
  upstreams = await startFakeUpstreams();
  ({ claudeFile } = await writeTokenFiles());
});

afterEach(async () => {
  while (open.length) await open.pop()!.close();
  upstreams.reset();
  clock = Date.now();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

afterAll(() => upstreams.close());

async function gatewayWithClients(
  loginDrivers?: LoginDrivers,
  logs?: string[],
  extra: { modelDeadlines?: ModelDeadlines; upstreams?: FakeUpstreams } = {},
): Promise<RunningGateway> {
  const stateDir = await mkdtemp(join(DATA_DIR, "client-listener-"));
  const gateway = await startGateway({
    stateDir,
    ...(loginDrivers ? { loginDrivers } : {}),
    ...(extra.modelDeadlines ? { modelDeadlines: extra.modelDeadlines } : {}),
    upstreams: (extra.upstreams ?? upstreams).overrides,
    now: () => clock,
    log: (line) => logs?.push(line),
    clients: {},
  });
  open.push(gateway);
  stateDirs.set(gateway, stateDir);
  const clients = gateway.clients!;
  clients.registry.addUser("u1");
  clients.registry.addUser("u2");
  clients.putAccount({
    id: "claude-a",
    provider: "claude",
    name: "Claude A",
    enabled: true,
    tokenFile: claudeFile,
    userId: "u1",
  });
  return gateway;
}

function postEnroll(
  gateway: RunningGateway,
  body: object,
): Promise<{ status: number; json: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const text = JSON.stringify(body);
    const request = https.request(
      {
        host: "127.0.0.1",
        port: gateway.clients!.enrollPort,
        ca: gateway.clients!.caPem,
        method: "POST",
        path: "/enroll",
        agent: false,
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () =>
          resolve({
            status: response.statusCode ?? 0,
            json: JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<
              string,
              unknown
            >,
          }),
        );
      },
    );
    request.on("error", reject);
    request.end(text);
  });
}

function newKey() {
  const pair = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  return {
    key: pair.privateKey.export({ type: "pkcs8", format: "pem" }) as string,
    publicKeyPem: pair.publicKey.export({ type: "spki", format: "pem" }),
  };
}

async function enroll(
  gateway: RunningGateway,
  userId = "u1",
): Promise<Identity> {
  const code = gateway.clients!.registry.createCode(userId, "test");
  const { key, publicKeyPem } = newKey();
  const { status, json } = await postEnroll(gateway, { code, publicKeyPem });
  assert.equal(status, 200);
  return {
    clientId: json.clientId as string,
    key,
    cert: json.certificatePem as string,
  };
}

function modelRequest(
  gateway: RunningGateway,
  identity: Partial<Identity> | undefined,
  token: string,
  agent: https.Agent | false = false,
): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const request = https.request(
      {
        host: "127.0.0.1",
        port: gateway.clients!.modelPort,
        ca: gateway.clients!.caPem,
        ...(identity?.key ? { key: identity.key, cert: identity.cert } : {}),
        agent,
        method: "POST",
        path: CLAUDE_PATH,
        headers: { authorization: `Bearer ${token}` },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () =>
          resolve({
            status: response.statusCode ?? 0,
            text: Buffer.concat(chunks).toString("utf8"),
          }),
        );
      },
    );
    request.on("error", reject);
    request.end('{"model":"fixture"}');
  });
}

async function dialClient(
  gateway: RunningGateway,
  identity: Identity,
  pushes?: string[],
  payloads?: { method: string; json: unknown }[],
): Promise<WorkerConnection> {
  const socket = tls.connect({
    host: "127.0.0.1",
    port: gateway.clients!.clientPort,
    ca: gateway.clients!.caPem,
    key: identity.key,
    cert: identity.cert,
  });
  await new Promise<void>((resolve, reject) => {
    socket.once("secureConnect", resolve);
    socket.once("error", reject);
  });
  const connection = new WorkerConnection(socketEndpoint(socket), {
    handshake: { role: "worker", workerId: "test-client" },
    protocol: GATEWAY_CLIENT_PROTOCOL,
    handlers: Object.fromEntries(
      [CLIENT_METHODS.accountsChanged, CLIENT_METHODS.loginEvent].map(
        (method) => [
          method,
          (payload: { json?: unknown }) => {
            pushes?.push(method);
            payloads?.push({ method, json: payload.json });
            return Promise.resolve(encodeClientMessage({}));
          },
        ],
      ),
    ),
  });
  open.push({ close: () => connection.end("test done") });
  return connection;
}

async function grant(
  connection: WorkerConnection,
  accountId = "claude-a",
): Promise<{ leaseId: string; token: string }> {
  return decodeLeaseGranted(
    await connection.request(
      CLIENT_METHODS.grant,
      encodeClientMessage({ accountId, workerId: "local" }),
    ),
  );
}

/**
 * Shortens one port's TLS handshake timeout to 1 s, so a real-socket
 * exercise needs no ten-second wait; the production value stays covered by
 * the bounds test. The listener creates the model port's TLS server first,
 * then the client port's.
 */
function shortenHandshake(port: "model" | "client"): void {
  const createServer = tls.createServer;
  const target = port === "model" ? 0 : 1;
  let calls = 0;
  vi.spyOn(tls, "createServer").mockImplementation((options, listener) =>
    createServer(
      calls++ === target ? { ...options, handshakeTimeout: 1_000 } : options,
      listener,
    ),
  );
}

test("an enrollment code is used once, expires, and yields a certificate of the CA", async () => {
  const gateway = await gatewayWithClients();
  const registry = gateway.clients!.registry;
  const code = registry.createCode("u1", "devbox");
  const first = await postEnroll(gateway, {
    code,
    publicKeyPem: newKey().publicKeyPem,
  });
  assert.equal(first.status, 200);
  const cert = new X509Certificate(first.json.certificatePem as string);
  const ca = new X509Certificate(gateway.clients!.caPem);
  assert.ok(cert.checkIssued(ca) && cert.verify(ca.publicKey));
  assert.equal(cert.subject, `CN=${first.json.clientId as string}`);
  assert.equal(first.json.modelPort, gateway.clients!.modelPort);

  const again = await postEnroll(gateway, {
    code,
    publicKeyPem: newKey().publicKeyPem,
  });
  assert.equal(again.status, 403);

  const late = registry.createCode("u1", "late");
  clock += 16 * 60_000;
  const expired = await postEnroll(gateway, {
    code: late,
    publicKeyPem: newKey().publicKeyPem,
  });
  assert.equal(expired.status, 403);
  assert.equal(registry.clients().length, 1);
});

test("the edge refuses no, foreign and revoked certificates, and a revoked client's open connection", async () => {
  const gateway = await gatewayWithClients();
  const a = await enroll(gateway);
  const connection = await dialClient(gateway, a);
  const { token } = await grant(connection);

  // No client certificate, and one from another CA: the handshake fails.
  await assert.rejects(modelRequest(gateway, undefined, token));
  const foreign = edgeTlsFor(["localhost"], undefined);
  const { key, publicKeyPem } = newKey();
  const { createPublicKey } = await import("node:crypto");
  const forged = issueClientCertificate(
    foreign,
    a.clientId,
    createPublicKey(publicKeyPem),
  );
  await assert.rejects(
    modelRequest(gateway, { key, cert: forged.certificatePem }, token),
  );

  // The enrolled client forwards on a kept-alive connection.
  const agent = new https.Agent({ keepAlive: true, maxSockets: 1 });
  open.push({ close: () => agent.destroy() });
  assert.equal((await modelRequest(gateway, a, token, agent)).status, 200);
  assert.equal(upstreams.anthropic.length, 1);

  gateway.clients!.registry.revoke(a.clientId);
  // The same open connection is refused on its next request ...
  assert.equal((await modelRequest(gateway, a, token, agent)).status, 403);
  // ... a new one at the handshake's end, and so is the client protocol.
  // The timer may already have closed the protocol connection.
  await assert.rejects(modelRequest(gateway, a, token));
  await assert.rejects(
    connection.request(CLIENT_METHODS.listAccounts, encodeClientMessage({})),
  );
  assert.equal(upstreams.anthropic.length, 1);
});

test("leases are scoped to their client", async () => {
  const gateway = await gatewayWithClients();
  const a = await dialClient(gateway, await enroll(gateway));
  const bIdentity = await enroll(gateway);
  const b = await dialClient(gateway, bIdentity);
  const other = await dialClient(gateway, await enroll(gateway, "u2"));

  assert.deepEqual(
    decodeAccounts(
      await a.request(CLIENT_METHODS.listAccounts, encodeClientMessage({})),
    ).map((account) => account.id),
    ["claude-a"],
  );
  // Another user's client sees none and cannot lease it.
  assert.deepEqual(
    decodeAccounts(
      await other.request(CLIENT_METHODS.listAccounts, encodeClientMessage({})),
    ),
    [],
  );
  await assert.rejects(grant(other), (err: unknown) => {
    return err instanceof WorkerRequestError && err.code === "unknown_account";
  });

  const lease = await grant(a);
  await assert.rejects(
    b.request(
      CLIENT_METHODS.bindSession,
      encodeClientMessage({ leaseId: lease.leaseId, sessionId: "s1" }),
    ),
    (err: unknown) =>
      err instanceof WorkerRequestError && err.code === "unknown_lease",
  );
  assert.equal(
    decodeLeaseRevoked(
      await b.request(
        CLIENT_METHODS.revoke,
        encodeClientMessage({
          leaseId: lease.leaseId,
          reason: "session-ended",
        }),
      ),
    ),
    false,
  );
  // B's certificate cannot spend A's lease; the gateway's loopback neither.
  assert.equal(
    (await modelRequest(gateway, bIdentity, lease.token)).status,
    403,
  );
  assert.equal(
    (await loopbackRequest(gateway.port, CLAUDE_PATH, lease.token)).status,
    403,
  );
  assert.equal(upstreams.anthropic.length, 0);
  // B's reconcile of the same Worker id leaves A's lease alone.
  await b.request(
    CLIENT_METHODS.reconcileWorker,
    encodeClientMessage({ workerId: "local", live: [] }),
  );
  assert.equal(gateway.leases.records()[0]!.revoked, undefined);
});

test("enrollment limits attempts per source and sets listener connection and timeout bounds", async () => {
  const httpsServers = vi.spyOn(https, "createServer");
  const tlsServers = vi.spyOn(tls, "createServer");
  const httpServers = vi.spyOn(http, "createServer");
  const gateway = await gatewayWithClients();
  // The model and client ports are TLS servers, the enrollment port HTTPS.
  assert.equal(tlsServers.mock.calls.length, 2);
  assert.equal(httpsServers.mock.calls.length, 1);
  for (const call of [...httpsServers.mock.calls, ...tlsServers.mock.calls]) {
    assert.equal((call[0] as tls.TlsOptions).handshakeTimeout, 10_000);
  }
  for (const result of [
    ...httpsServers.mock.results,
    ...tlsServers.mock.results,
  ]) {
    assert.equal((result.value as tls.Server).maxConnections, 64);
  }
  // The model port's deadlines are the former Node HTTPS defaults, and its
  // HTTP parser sets no socket timeout of its own.
  assert.deepEqual(gateway.clients!.modelDeadlines, {
    headersMs: 60_000,
    requestMs: 300_000,
    idleMs: 5_000,
  });
  // The parser is the one HTTP server that never listens.
  const unlistened = httpServers.mock.results
    .map((result) => result.value as http.Server)
    .filter((server) => !server.listening);
  assert.equal(unlistened.length, 1);
  const modelHttp = unlistened[0]!;
  assert.equal(modelHttp.keepAliveTimeout, 0);
  assert.equal(modelHttp.headersTimeout, 0);
  assert.equal(modelHttp.requestTimeout, 0);
  assert.equal(modelHttp.timeout, 0);
  const enrollment = httpsServers.mock.results.at(-1)!.value as https.Server;
  assert.equal(enrollment.headersTimeout, 5_000);
  assert.equal(enrollment.requestTimeout, 10_000);
  assert.equal(enrollment.timeout, 10_000);
  for (let i = 0; i < 30; i++)
    assert.equal((await postEnroll(gateway, {})).status, 400);
  assert.equal((await postEnroll(gateway, {})).status, 429);
  clock += 60_001;
  assert.equal((await postEnroll(gateway, {})).status, 400);
});

test("registry read and write failures refuse the request without ending the gateway", async () => {
  const logs: string[] = [];
  const gateway = await gatewayWithClients(undefined, logs);
  const identity = await enroll(gateway);
  const connection = await dialClient(gateway, identity);
  const { token } = await grant(connection);
  const agent = new https.Agent({ keepAlive: true, maxSockets: 1 });
  open.push({ close: () => agent.destroy() });
  assert.equal(
    (await modelRequest(gateway, identity, token, agent)).status,
    200,
  );
  const path = join(stateDirs.get(gateway)!, "clients.json");
  const saved = await readFile(path, "utf8");
  await writeFile(path, "corrupt json");
  assert.equal(
    (
      await postEnroll(gateway, {
        code: "unknown",
        publicKeyPem: newKey().publicKeyPem,
      })
    ).status,
    503,
  );
  assert.equal(
    (await modelRequest(gateway, identity, token, agent)).status,
    503,
  );
  await assert.rejects(
    connection.request(CLIENT_METHODS.listAccounts, encodeClientMessage({})),
  );
  await assert.rejects(modelRequest(gateway, identity, token));
  const newConnection = await dialClient(gateway, identity);
  await assert.rejects(
    newConnection.request(CLIENT_METHODS.listAccounts, encodeClientMessage({})),
  );
  await writeFile(path, saved);
  const code = gateway.clients!.registry.createCode("u1", "busy");
  await writeFile(`${path}.lock`, "a writer holds the lock");
  logs.length = 0;
  const body = { code, publicKeyPem: newKey().publicKeyPem };
  assert.equal((await postEnroll(gateway, body)).status, 503);
  assert.equal((await postEnroll(gateway, body)).status, 503);
  assert.equal(logs.filter((line) => line.includes(`${path}.lock`)).length, 1);
  assert.match(
    logs[0]!,
    /Check that the writer PID.*no longer running before removing the lock/,
  );
  assert.equal(
    logs.filter((line) => line.includes("enrollment failed")).length,
    0,
  );
  await unlink(`${path}.lock`);
  assert.equal((await postEnroll(gateway, body)).status, 200);
});

function fakeLogin() {
  let events!: LoginDriverEvents;
  let directory = "";
  let cancelCount = 0;
  let complete!: () => void;
  const done = new Promise<void>((resolve) => {
    complete = resolve;
  });
  const drivers: LoginDrivers = {
    claude: (dir, next) => {
      directory = dir;
      events = next;
      // Deliberately ignores cancellation. Even a late successful driver must
      // never ingest a credential for a revoked client.
      return {
        input() {},
        cancel() {
          cancelCount++;
        },
        done,
      };
    },
  };
  return {
    drivers,
    complete: () => complete(),
    events: () => events,
    directory: () => directory,
    cancels: () => cancelCount,
  };
}

async function startLogin(connection: WorkerConnection) {
  const payload = await connection.request(
    CLIENT_METHODS.loginStart,
    encodeClientMessage({ kind: "claude" }),
  );
  return payload.json as { loginId: string; accountId: string };
}

async function completeLogin(run: ReturnType<typeof fakeLogin>) {
  await writeFile(
    join(run.directory(), ".credentials.json"),
    JSON.stringify({
      claudeAiOauth: {
        accessToken: "fixture",
        expiresAt: Date.now() + 3_600_000,
      },
    }),
  );
  run.complete();
}

test("revocation blocks every push, closes all client connections, cancels logins and revokes leases", async () => {
  const run = fakeLogin();
  const gateway = await gatewayWithClients(run.drivers);
  const identity = await enroll(gateway);
  const pushes: string[] = [];
  const connection = await dialClient(gateway, identity, pushes);
  const second = await dialClient(gateway, identity, pushes);
  await second.request(CLIENT_METHODS.hello, encodeClientMessage({}));
  const other = await dialClient(gateway, await enroll(gateway, "u2"));
  const { leaseId } = await grant(connection);
  const login = await startLogin(connection);
  // A reply on each stream drains all pre-revocation pushes already queued
  // on it. The assertions below concern only events emitted after revoke.
  await Promise.all(
    [connection, second].map((client) =>
      client.request(CLIENT_METHODS.hello, encodeClientMessage({})),
    ),
  );
  assert.ok(pushes.includes(CLIENT_METHODS.loginEvent));
  pushes.length = 0;
  gateway.clients!.registry.revoke(identity.clientId);
  run.events().output("must not push");
  run.events().url("https://fake.invalid/login");
  run.events().code("fake-device-code");
  gateway.clients!.accountsChanged();
  await Promise.all([connection.ended, second.ended]);
  assert.deepEqual(pushes, []);
  assert.equal(run.cancels(), 1);
  assert.ok(
    gateway.leases.records().find((lease) => lease.leaseId === leaseId)!
      .revoked,
  );
  await completeLogin(run);
  await vi.waitFor(() =>
    assert.ok(
      !gateway.clients!.registry.accountsOf("u1").includes(login.accountId),
    ),
  );
  assert.equal(other.isEnded, false);
  await other.request(CLIENT_METHODS.listAccounts, encodeClientMessage({}));
});

test("the timer notices an admin process revocation without a call or push, including a disconnected login", async () => {
  const run = fakeLogin();
  const gateway = await gatewayWithClients(run.drivers);
  const identity = await enroll(gateway);
  const connection = await dialClient(gateway, identity);
  const passive = await dialClient(gateway, identity);
  await passive.request(CLIENT_METHODS.hello, encodeClientMessage({}));
  const { leaseId } = await grant(connection);
  const login = await startLogin(connection);
  connection.end("disconnected before revocation");
  const moduleUrl = new URL("./clientRegistry.ts", import.meta.url).href;
  await promisify(execFile)(process.execPath, [
    "--import",
    "tsx",
    "--input-type=module",
    "--eval",
    `import { ClientRegistry } from ${JSON.stringify(moduleUrl)}; new ClientRegistry(${JSON.stringify(stateDirs.get(gateway))}).revoke(${JSON.stringify(identity.clientId)});`,
  ]);
  await vi.waitFor(
    () => {
      assert.equal(passive.isEnded, true);
      assert.equal(run.cancels(), 1);
      assert.ok(
        gateway.leases.records().find((lease) => lease.leaseId === leaseId)!
          .revoked,
      );
    },
    { timeout: 2_000 },
  );
  await completeLogin(run);
  await vi.waitFor(() =>
    assert.ok(
      !gateway.clients!.registry.accountsOf("u1").includes(login.accountId),
    ),
  );
});

test("silent TLS peers release the client port's slots after handshake timeout", async () => {
  shortenHandshake("client");
  const gateway = await gatewayWithClients();
  const identity = await enroll(gateway);
  const peers = Array.from({ length: 64 }, () =>
    net.connect(gateway.clients!.clientPort, "127.0.0.1"),
  );
  const closed = peers.map(
    (peer) =>
      new Promise<void>((resolve) => peer.once("close", () => resolve())),
  );
  for (const peer of peers) {
    peer.on("error", () => {});
    open.push({ close: () => peer.destroy() });
  }
  await Promise.all(
    peers.map(
      (peer) =>
        new Promise<void>((resolve, reject) => {
          peer.once("connect", resolve);
          peer.once("error", reject);
        }),
    ),
  );
  assert.equal(peers.filter((peer) => !peer.destroyed).length, 64);
  await Promise.all(closed);
  const client = await dialClient(gateway, identity);
  await client.request(CLIENT_METHODS.hello, encodeClientMessage({}));
});

test("failed revocation checks preserve all clients and warn once per read-failure episode", async () => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  const run = fakeLogin();
  const logs: string[] = [];
  const gateway = await gatewayWithClients(run.drivers, logs);
  gateway.clients!.putAccount({
    id: "claude-b",
    provider: "claude",
    name: "B",
    enabled: true,
    tokenFile: claudeFile,
    userId: "u2",
  });
  const aIdentity = await enroll(gateway);
  const bIdentity = await enroll(gateway, "u2");
  const a = await dialClient(gateway, aIdentity);
  const b = await dialClient(gateway, bIdentity);
  const aLease = await grant(a);
  const bLease = await grant(b, "claude-b");
  const login = await startLogin(a);
  await Promise.all(
    [a, b].map((client) =>
      client.request(CLIENT_METHODS.hello, encodeClientMessage({})),
    ),
  );
  const before = gateway.leases.records();
  const path = join(stateDirs.get(gateway)!, "clients.json");
  const good = await readFile(path, "utf8");
  logs.length = 0;
  const warnings = () =>
    logs.filter(
      (line) =>
        line ===
        "client revocation check deferred: client registry unavailable",
    );
  const failures = [
    () => writeFile(path, "temporarily invalid JSON"),
    () => unlink(path),
    () => rename(path, `${path}.backup`),
  ];
  for (const [episode, failRead] of failures.entries()) {
    await failRead();
    await vi.advanceTimersByTimeAsync(1_000);
    assert.deepEqual(gateway.leases.records(), before);
    assert.equal(a.isEnded, false);
    assert.equal(b.isEnded, false);
    assert.equal(run.cancels(), 0);
    assert.equal(warnings().length, episode + 1);
    await writeFile(path, good);
    await vi.advanceTimersByTimeAsync(250);
  }
  await a.request(CLIENT_METHODS.listAccounts, encodeClientMessage({}));
  await b.request(CLIENT_METHODS.listAccounts, encodeClientMessage({}));
  assert.equal(
    (await modelRequest(gateway, aIdentity, aLease.token)).status,
    200,
  );
  assert.equal(
    (await modelRequest(gateway, bIdentity, bLease.token)).status,
    200,
  );
  // A successful read can still find a real revocation and limit its effects
  // to that client. Its running login is cancelled only at that point.
  gateway.clients!.registry.revoke(aIdentity.clientId);
  await vi.advanceTimersByTimeAsync(250);
  await a.ended;
  assert.equal(run.cancels(), 1);
  assert.ok(
    gateway.leases.records().find((lease) => lease.leaseId === aLease.leaseId)!
      .revoked,
  );
  assert.equal(
    gateway.leases.records().find((lease) => lease.leaseId === bLease.leaseId)!
      .revoked,
    undefined,
  );
  assert.equal(b.isEnded, false);
  await completeLogin(run);
  await vi.waitFor(() =>
    assert.ok(
      !gateway.clients!.registry.accountsOf("u1").includes(login.accountId),
    ),
  );
  // A successfully read empty list is authoritative, unlike a missing file.
  const state = JSON.parse(await readFile(path, "utf8")) as Record<
    string,
    unknown
  >;
  await writeFile(path, JSON.stringify({ ...state, clients: [] }));
  await vi.advanceTimersByTimeAsync(250);
  await b.ended;
  assert.ok(
    gateway.leases.records().find((lease) => lease.leaseId === bLease.leaseId)!
      .revoked,
  );
});

test("a login finishing before the revocation timer cannot ingest its credential", async () => {
  const run = fakeLogin();
  const gateway = await gatewayWithClients(run.drivers);
  const identity = await enroll(gateway);
  const connection = await dialClient(gateway, identity);
  const login = await startLogin(connection);
  new ClientRegistry(stateDirs.get(gateway)!).revoke(identity.clientId);
  await completeLogin(run);
  await vi.waitFor(() =>
    assert.ok(
      !gateway.clients!.registry.accountsOf("u1").includes(login.accountId),
    ),
  );
  const tokenFile = join(
    stateDirs.get(gateway)!,
    "accounts",
    login.accountId,
    ".credentials.json",
  );
  await assert.rejects(readFile(tokenFile), { code: "ENOENT" });
});

test("the page's operations reach clients: a take-over ends the client's login as superseded, a removal pushes accounts.changed", async () => {
  const run = fakeLogin();
  const gateway = await gatewayWithClients(run.drivers);
  const identity = await enroll(gateway);
  const payloads: { method: string; json: unknown }[] = [];
  const connection = await dialClient(gateway, identity, undefined, payloads);
  const started = (
    await connection.request(
      CLIENT_METHODS.loginStart,
      encodeClientMessage({ kind: "claude", accountId: "claude-a" }),
    )
  ).json as { loginId: string };
  const operations = gateway.clients!.userOperations;
  const session = {
    kind: "session" as const,
    id: "s1",
    userId: "u1",
    active: () => true,
  };
  const taken = operations.startLogin(session, {
    kind: "claude",
    accountId: "claude-a",
  });
  assert.notEqual(taken.loginId, started.loginId);
  await vi.waitFor(() =>
    assert.ok(
      payloads.some(
        (p) =>
          p.method === CLIENT_METHODS.loginEvent &&
          JSON.stringify(p.json) ===
            JSON.stringify({
              loginId: started.loginId,
              accountId: "claude-a",
              event: {
                type: "state",
                state: "cancelled",
                error: "This login was started again elsewhere.",
              },
            }),
      ),
    ),
  );
  // The session's events never go to the client.
  assert.ok(
    !payloads.some((p) => JSON.stringify(p.json).includes(taken.loginId)),
  );
  // Another user's session cannot remove it; its own user can.
  assert.throws(
    () => operations.removeAccount("u2", "claude-a"),
    (err: unknown) =>
      err instanceof Error && "code" in err && err.code === "unknown_account",
  );
  payloads.length = 0;
  operations.removeAccount("u1", "claude-a");
  await vi.waitFor(() =>
    assert.ok(
      payloads.some((p) => p.method === CLIENT_METHODS.accountsChanged),
    ),
  );
  assert.deepEqual(operations.accounts("u1"), []);
  run.complete();
});

// --- tools and integrations (Task-1397) -----------------------------------

const NO_HOST: EdgeTools["host"] = {
  list: () => [],
  call: () =>
    Promise.resolve({
      ok: false,
      code: "unknown_tool",
      message: "No such tool.",
    }),
};

/** Fake tools: `check` answers as told; the MCP handler answers 200 "mcp". */
function fakeTools(
  check: () => Promise<IntegrationCheck>,
  host: EdgeTools["host"] = NO_HOST,
): EdgeTools {
  return {
    handleMcp: (_req, res) => {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("mcp");
    },
    host,
    integrations: {
      atlassian: {
        parse: (input) => {
          const { site, email, token } = input as Record<string, string>;
          return site === "x.atlassian.net"
            ? {
                ok: true,
                credential: JSON.stringify({ site, email, token }),
                site,
                email: email ?? "",
              }
            : { ok: false };
        },
        check: () => check(),
        describe: (credential) => {
          const { site, email } = JSON.parse(credential) as Record<
            string,
            string
          >;
          return { site: site!, email: email! };
        },
      },
    },
  };
}

function mcpRequest(
  gateway: RunningGateway,
  identity: Identity,
  headers: Record<string, string>,
): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const request = https.request(
      {
        host: "127.0.0.1",
        port: gateway.clients!.modelPort,
        ca: gateway.clients!.caPem,
        key: identity.key,
        cert: identity.cert,
        agent: false,
        method: "POST",
        path: "/mcp",
        headers,
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () =>
          resolve({
            status: response.statusCode ?? 0,
            text: Buffer.concat(chunks).toString("utf8"),
          }),
        );
      },
    );
    request.on("error", reject);
    request.end("{}");
  });
}

test("without tools /mcp is an unknown path and the integration methods refuse", async () => {
  const gateway = await gatewayWithClients();
  const identity = await enroll(gateway);
  const token = gateway.clients!.registry.setMcpToken(identity.clientId);
  const answer = await mcpRequest(gateway, identity, {
    authorization: `Bearer ${token}`,
  });
  assert.equal(answer.status, 404);
  const connection = await dialClient(gateway, identity);
  await assert.rejects(
    connection.request(
      CLIENT_METHODS.integrationStatus,
      encodeClientMessage({ integration: "atlassian" }),
    ),
    (err: unknown) =>
      err instanceof WorkerRequestError && err.code === "tools_unavailable",
  );
  for (const method of [CLIENT_METHODS.toolsList, CLIENT_METHODS.toolsCall])
    await assert.rejects(
      connection.request(method, encodeClientMessage({ name: "a_tool" })),
      (err: unknown) =>
        err instanceof WorkerRequestError && err.code === "tools_unavailable",
    );
});

test("the /mcp gate: a malformed stored hash refuses 401 without a throw; a valid token reaches the tools", async () => {
  const stateDir = await mkdtemp(join(DATA_DIR, "client-listener-"));
  const lines: string[] = [];
  const gateway = await startGateway({
    stateDir,
    upstreams: upstreams.overrides,
    log: (line) => lines.push(line),
    clients: {},
    tools: fakeTools(() => Promise.resolve({ ok: true })),
  });
  open.push(gateway);
  gateway.clients!.registry.addUser("u1");
  const identity = await enroll(gateway);
  const token = gateway.clients!.registry.setMcpToken(identity.clientId);
  assert.equal(
    (await mcpRequest(gateway, identity, { authorization: `Bearer ${token}` }))
      .text,
    "mcp",
  );
  const file = join(stateDir, "clients.json");
  const state = JSON.parse(await readFile(file, "utf8")) as {
    clients: { mcpTokenHash?: string }[];
  };
  state.clients[0]!.mcpTokenHash = "not-a-hash";
  await writeFile(file, JSON.stringify(state));
  const refused = await mcpRequest(gateway, identity, {
    authorization: `Bearer ${token}`,
  });
  assert.equal(refused.status, 401);
  assert.deepEqual(JSON.parse(refused.text), { error: "mcp token required" });
  assert.ok(!lines.join("\n").includes(token));
});

test("async client methods: a coded rejection answers its code, a foreign one answers failed without its text", async () => {
  const stateDir = await mkdtemp(join(DATA_DIR, "client-listener-"));
  const lines: string[] = [];
  let check: () => Promise<IntegrationCheck> = () =>
    Promise.reject(new Error("SENTINEL-check"));
  const gateway = await startGateway({
    stateDir,
    upstreams: upstreams.overrides,
    log: (line) => lines.push(line),
    clients: {},
    tools: fakeTools(() => check()),
  });
  open.push(gateway);
  gateway.clients!.registry.addUser("u1");
  const identity = await enroll(gateway);
  const connection = await dialClient(gateway, identity);
  const set = () =>
    connection.request(
      CLIENT_METHODS.integrationSet,
      encodeClientMessage({
        integration: "atlassian",
        site: "x.atlassian.net",
        email: "a@x.test",
        token: "FAKE-SET-TOKEN",
      }),
    );
  const code = (err: unknown) =>
    err instanceof WorkerRequestError ? err.code : undefined;
  assert.equal(await set().catch(code), "failed");
  assert.ok(!lines.join("\n").includes("SENTINEL"));
  assert.ok(
    lines.includes(`client ${identity.clientId} integrations.set: failed`),
  );

  check = () => Promise.resolve({ ok: false, problem: "rejected" });
  assert.equal(await set().catch(code), "integration_rejected");
  assert.ok(
    lines.includes(
      `client ${identity.clientId} integrations.set: integration_rejected`,
    ),
  );

  // The vault cannot write: unavailable, with nothing kept.
  check = () => Promise.resolve({ ok: true });
  await writeFile(join(stateDir, "accounts"), "not a directory");
  assert.equal(await set().catch(code), "vault_unavailable");
  await unlink(join(stateDir, "accounts"));
  const answer = await set();
  assert.deepEqual(answer.json, {
    connected: true,
    site: "x.atlassian.net",
    email: "a@x.test",
  });
  for (const line of lines) assert.ok(!line.includes("FAKE-SET-TOKEN"), line);
});

// --- tools.list and tools.call (Task-1398) ---------------------------------

const STUB_LISTING = [
  {
    name: "stub_read",
    description: "A stub tool.",
    inputSchema: {
      type: "object" as const,
      properties: {},
      additionalProperties: false as const,
    },
    effect: "read" as const,
    actionKey: "jira:read",
  },
];

interface HostCall {
  name: string;
  args: unknown;
  clientId: string;
  signal: AbortSignal | undefined;
}

async function gatewayWithHost(
  call: (
    caller: Parameters<EdgeTools["host"]["call"]>[2],
  ) => Promise<ToolAnswer>,
  calls: HostCall[],
): Promise<RunningGateway> {
  const gateway = await startGateway({
    stateDir: await mkdtemp(join(DATA_DIR, "client-listener-")),
    upstreams: upstreams.overrides,
    clients: {},
    tools: fakeTools(() => Promise.resolve({ ok: true }), {
      list: () => STUB_LISTING,
      call: (name, args, caller) => {
        calls.push({
          name,
          args,
          clientId: caller.clientId,
          signal: caller.signal,
        });
        return call(caller);
      },
    }),
  });
  open.push(gateway);
  gateway.clients!.registry.addUser("u1");
  gateway.clients!.registry.addUser("u2");
  return gateway;
}

test("tools.list answers the host's listing; tools.call runs it with the registry's user", async () => {
  const calls: HostCall[] = [];
  let answer: ToolAnswer = { ok: false, code: "tool_error", message: "Nope." };
  const gateway = await gatewayWithHost(async (caller) => {
    // The credential the host reads names whose it is.
    const outcome = await caller.credential("atlassian", caller.signal!);
    return outcome.ok
      ? { ok: true, text: JSON.parse(outcome.credential).email as string }
      : answer;
  }, calls);
  const identity = await enroll(gateway, "u1");
  const connection = await dialClient(gateway, identity);
  assert.deepEqual(
    (
      await connection.request(
        CLIENT_METHODS.toolsList,
        encodeClientMessage({}),
      )
    ).json,
    { tools: STUB_LISTING },
  );

  // Nothing stored: the tool's own failure is the answer, not a failed call.
  const call = (json: object) =>
    connection.request(CLIENT_METHODS.toolsCall, encodeClientMessage(json));
  assert.deepEqual((await call({ name: "stub_read" })).json, answer);
  assert.deepEqual(calls[0]!.args, {});
  assert.equal(calls[0]!.clientId, identity.clientId);

  await connection.request(
    CLIENT_METHODS.integrationSet,
    encodeClientMessage({
      integration: "atlassian",
      site: "x.atlassian.net",
      email: "u1@x.test",
      token: "FAKE-TOOL-TOKEN",
    }),
  );
  // A `userId` in the payload is ignored: the credential is u1's.
  answer = { ok: false, code: "failed", message: "unused" };
  assert.deepEqual(
    (await call({ name: "stub_read", args: { a: 1 }, userId: "u2" })).json,
    { ok: true, text: "u1@x.test" },
  );
  assert.deepEqual(calls[1]!.args, { a: 1 });
});

test("tools.call refuses a malformed name or arguments before the host", async () => {
  const calls: HostCall[] = [];
  const gateway = await gatewayWithHost(
    () => Promise.resolve({ ok: true, text: "{}" }),
    calls,
  );
  const connection = await dialClient(gateway, await enroll(gateway));
  for (const json of [
    {},
    { name: "Bad-Name" },
    { name: "x".repeat(65) },
    { name: "stub_read", args: [1] },
    { name: "stub_read", args: "x" },
    { name: "stub_read", args: null },
  ])
    await assert.rejects(
      connection.request(CLIENT_METHODS.toolsCall, encodeClientMessage(json)),
      (err: unknown) =>
        err instanceof WorkerRequestError && err.code === "invalid_params",
    );
  assert.equal(calls.length, 0);
});

test("a client's cancel and its connection's end abort the host's call", async () => {
  const calls: HostCall[] = [];
  const gateway = await gatewayWithHost(
    (caller) =>
      new Promise<ToolAnswer>((resolve) =>
        caller.signal!.addEventListener("abort", () =>
          resolve({
            ok: false,
            code: "cancelled",
            message: "The call was cancelled.",
          }),
        ),
      ),
    calls,
  );
  const identity = await enroll(gateway);
  const connection = await dialClient(gateway, identity);
  const controller = new AbortController();
  const pending = connection.request(
    CLIENT_METHODS.toolsCall,
    encodeClientMessage({ name: "stub_read" }),
    controller.signal,
  );
  await vi.waitFor(() => assert.equal(calls.length, 1));
  controller.abort();
  // The cancel frame reaches the host, whose answer still settles the call.
  assert.deepEqual((await pending).json, {
    ok: false,
    code: "cancelled",
    message: "The call was cancelled.",
  });
  assert.ok(calls[0]!.signal!.aborted);

  const second = await dialClient(gateway, identity);
  void second
    .request(
      CLIENT_METHODS.toolsCall,
      encodeClientMessage({ name: "stub_read" }),
    )
    .catch(() => {});
  await vi.waitFor(() => assert.equal(calls.length, 2));
  second.end("test over");
  await vi.waitFor(() => assert.ok(calls[1]!.signal!.aborted));
});

// --- model-port deadlines (plan Task-1401 §0, §9 M1-M6, M3b) -------------

/** Test bounds: every expiry happens well inside a 5 s outer deadline. */
const SHORT: ModelDeadlines = { headersMs: 500, requestMs: 1_500, idleMs: 500 };

/** Rejects unless `promise` settles within `ms`. */
function within<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([
    promise,
    new Promise<never>((_resolve, reject) => {
      timer = setTimeout(
        () => reject(new Error(`${what}: not within ${ms} ms`)),
        ms,
      );
    }),
  ]).finally(() => clearTimeout(timer));
}

interface RawModel {
  socket: tls.TLSSocket;
  /** Everything the edge sent, as text. */
  received: () => string;
  /** Resolves on the client socket's `close`, with `Date.now()` then. */
  closed: Promise<number>;
  /** Resolves once `received()` satisfies `done`, within `ms`. */
  until: (done: (text: string) => boolean, ms: number) => Promise<void>;
}

/** An enrolled client's raw mutual-TLS connection to the model port. */
async function dialModel(
  gateway: RunningGateway,
  identity: Identity,
): Promise<RawModel> {
  const socket = tls.connect({
    host: "127.0.0.1",
    port: gateway.clients!.modelPort,
    ca: gateway.clients!.caPem,
    key: identity.key,
    cert: identity.cert,
  });
  open.push({ close: () => socket.destroy() });
  socket.on("error", () => {});
  let text = "";
  const waiters = new Set<() => void>();
  socket.on("data", (chunk: Buffer) => {
    text += chunk.toString("latin1");
    for (const waiter of waiters) waiter();
  });
  const closed = new Promise<number>((resolve) =>
    socket.once("close", () => resolve(Date.now())),
  );
  await within(
    new Promise<void>((resolve, reject) => {
      socket.once("secureConnect", resolve);
      socket.once("error", reject);
    }),
    5_000,
    "model-port handshake",
  );
  return {
    socket,
    received: () => text,
    closed,
    until: (done, ms) =>
      within(
        new Promise<void>((resolve) => {
          const check = (): void => {
            if (!done(text)) return;
            waiters.delete(check);
            resolve();
          };
          waiters.add(check);
          check();
        }),
        ms,
        "model-port response",
      ),
  };
}

/** A forwarded Claude request's head, for `body` or a declared length. */
function requestHead(token: string, length: number): string {
  return (
    `POST ${CLAUDE_PATH} HTTP/1.1\r\nhost: edge\r\n` +
    `authorization: Bearer ${token}\r\ncontent-type: application/json\r\n` +
    `content-length: ${length}\r\n\r\n`
  );
}

function fullRequest(token: string, body: string): string {
  return requestHead(token, Buffer.byteLength(body)) + body;
}

/** A Claude upstream that records request starts and aborts. */
async function observedUpstream(
  claude: (seen: { body: Buffer }, res: http.ServerResponse) => void,
): Promise<{
  upstream: FakeUpstreams;
  started: () => number;
  aborted: () => number;
}> {
  let started = 0;
  let aborted = 0;
  const upstream = await startFakeUpstreams({
    claude,
    claudeStarted: (req) => {
      started++;
      req.once("close", () => {
        if (!req.complete) aborted++;
      });
    },
  });
  open.push(upstream);
  return { upstream, started: () => started, aborted: () => aborted };
}

/** Writes `chunks` `gapMs` apart, then ends: a long, quiet model stream. */
function quietStream(chunks: string[], gapMs: number) {
  return (res: http.ServerResponse): void => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    let next = 0;
    const timer = setInterval(() => {
      if (res.destroyed) return clearInterval(timer);
      res.write(chunks[next]!);
      if (++next === chunks.length) {
        clearInterval(timer);
        res.end();
      }
    }, gapMs);
  };
}

/** A client, its lease token and the gateway, with test or production bounds. */
async function deadlineSetup(
  upstream: FakeUpstreams,
  bounds: ModelDeadlines | "production" = SHORT,
) {
  const gateway = await gatewayWithClients(undefined, undefined, {
    upstreams: upstream,
    ...(bounds === "production" ? {} : { modelDeadlines: bounds }),
  });
  if (bounds === "production")
    assert.equal(gateway.clients!.modelDeadlines.requestMs, 300_000);
  const identity = await enroll(gateway);
  const { token } = await grant(await dialClient(gateway, identity));
  return { gateway, identity, token };
}

/** The chunked body's end, after the last chunk. */
const CHUNKED_END = "\r\n0\r\n\r\n";
const STREAM = [
  "data: one\n\n",
  "data: two\n\n",
  "data: three\n\n",
  "data: four\n\n",
];

test("M1 stalled headers: a request line and a header, then nothing, is closed at the headers bound", async () => {
  const { upstream, started } = await observedUpstream(() => {});
  const { gateway, identity } = await deadlineSetup(upstream);
  const model = await dialModel(gateway, identity);
  const from = Date.now();
  model.socket.write(`POST ${CLAUDE_PATH} HTTP/1.1\r\nhost: edge\r\n`);
  const at = await within(model.closed, 5_000, "stalled headers close");
  assert.ok(
    at - from <= SHORT.headersMs + 1_000,
    `closed after ${at - from} ms`,
  );
  assert.equal(started(), 0);
  assert.equal(model.received(), "");
});

test("M1 stalled headers: one header byte every 100 ms is closed at the headers bound", async () => {
  const { upstream, started } = await observedUpstream(() => {});
  const { gateway, identity } = await deadlineSetup(upstream);
  const model = await dialModel(gateway, identity);
  const from = Date.now();
  model.socket.write(`POST ${CLAUDE_PATH} HTTP/1.1\r\n`);
  // Bytes keep arriving faster than the idle bound; only the headers timer
  // can end this.
  const header = "x-slow: " + "a".repeat(200);
  let sent = 0;
  const drip = setInterval(() => {
    if (model.socket.destroyed) return clearInterval(drip);
    model.socket.write(header[sent++ % header.length]!);
  }, 100);
  open.push({ close: () => clearInterval(drip) });
  const at = await within(model.closed, 5_000, "dripped headers close");
  clearInterval(drip);
  assert.ok(at - from >= SHORT.headersMs - 50, `closed after ${at - from} ms`);
  assert.ok(
    at - from <= SHORT.headersMs + 1_000,
    `closed after ${at - from} ms`,
  );
  assert.equal(started(), 0);
});

test("M2 stalled body: a dripped body is closed at the request bound and the upstream request is aborted", async () => {
  const { upstream, started, aborted } = await observedUpstream((_seen, res) =>
    res.end('{"ok":true}'),
  );
  const { gateway, identity, token } = await deadlineSetup(upstream);
  const model = await dialModel(gateway, identity);
  const from = Date.now();
  model.socket.write(requestHead(token, 1_000) + '{"model":"');
  const drip = setInterval(() => {
    if (model.socket.destroyed) return clearInterval(drip);
    model.socket.write("x");
  }, 100);
  open.push({ close: () => clearInterval(drip) });
  const at = await within(model.closed, 5_000, "stalled body close");
  clearInterval(drip);
  assert.ok(at - from >= SHORT.requestMs - 50, `closed after ${at - from} ms`);
  assert.ok(
    at - from <= SHORT.requestMs + 1_000,
    `closed after ${at - from} ms`,
  );
  await within(
    (async () => {
      while (aborted() === 0) await new Promise((r) => setTimeout(r, 20));
    })(),
    2_000,
    "upstream abort",
  );
  assert.equal(started(), 1);
  assert.equal(aborted(), 1);
  assert.equal(upstream.anthropic.length, 0);
  assert.doesNotMatch(model.received(), /HTTP\/1\.1 2\d\d/);
});

/** Asserts `text`, from `from` on, holds every `STREAM` chunk in order. */
function assertWholeStream(text: string, from: number): void {
  let at = from;
  for (const chunk of STREAM) {
    const found = text.indexOf(chunk, at);
    assert.ok(found > at, `missing ${JSON.stringify(chunk)}`);
    at = found;
  }
  assert.ok(text.endsWith(CHUNKED_END), "the stream ended");
}

test("M3 keep-alive: a short answer, then a long, quiet stream on the same connection, then another request; nothing is cut", async () => {
  const { upstream } = await observedUpstream((seen, res) =>
    seen.body.toString() === "long"
      ? quietStream(STREAM, 700)(res)
      : res.end('{"ok":true}'),
  );
  const { gateway, identity, token } = await deadlineSetup(upstream);
  const model = await dialModel(gateway, identity);
  model.socket.write(fullRequest(token, "short"));
  await model.until((text) => text.endsWith('{"ok":true}'), 5_000);
  // Each 700 ms gap outlasts the headers and idle bounds; the whole stream
  // (2.8 s) outlasts the request bound.
  const from = model.received().length;
  model.socket.write(fullRequest(token, "long"));
  await model.until((text) => text.endsWith(CHUNKED_END), 5_000);
  assertWholeStream(model.received(), from);
  // The same connection is still open and serves the next request.
  model.socket.write(fullRequest(token, "short"));
  await model.until(
    (text) => text.match(/HTTP\/1\.1 200 /g)?.length === 3,
    5_000,
  );
  await model.until((text) => text.endsWith('{"ok":true}'), 5_000);
  assert.equal(model.socket.destroyed, false);
  assert.equal(upstream.anthropic.length, 3);
});

/** Two complete requests in one write, before any response. */
async function pipelined() {
  const tlsServers = vi.spyOn(tls, "createServer");
  const { upstream } = await observedUpstream((seen, res) =>
    seen.body.toString() === "long"
      ? quietStream(STREAM, 700)(res)
      : res.end('{"ok":true}'),
  );
  return { tlsServers, upstream };
}

test.skipIf(Boolean(process.versions.bun))(
  "M3b pipelined (Node): a short first response does not let a long, quiet second stream be cut",
  async () => {
    const { upstream } = await pipelined();
    const { gateway, identity, token } = await deadlineSetup(upstream);
    const model = await dialModel(gateway, identity);
    model.socket.write(
      fullRequest(token, "short") + fullRequest(token, "long"),
    );
    await model.until((text) => text.endsWith(CHUNKED_END), 5_000);
    const text = model.received();
    const short = text.indexOf('{"ok":true}');
    const second = text.indexOf("HTTP/1.1 200 ", short);
    assert.ok(text.startsWith("HTTP/1.1 200 ") && short > 0 && second > short);
    assertWholeStream(text, second);
    assert.equal(model.socket.destroyed, false);
    assert.equal(upstream.anthropic.length, 2);
  },
);

test.runIf(Boolean(process.versions.bun))(
  "M3b pipelined (Bun 1.4.2 runtime-difference pin): the runtime's parser closes a pipelined connection at once; our deadlines play no part",
  async () => {
    // Bun 1.4.2's `http.Server`, handed a socket by `emit("connection")`,
    // destroys the connection when a request arrives before the previous
    // response finished (docs/deployment.md "Bun runtime differences"). The
    // relay never pipelines. If a later Bun serves both answers, this pin
    // fails: run the Node assertions of M3b under Bun instead.
    const { tlsServers, upstream } = await pipelined();
    // Long bounds: any close before them is the runtime's, not ours.
    const bounds = { headersMs: 3_000, requestMs: 3_000, idleMs: 3_000 };
    const { gateway, identity, token } = await deadlineSetup(upstream, bounds);
    const model = await dialModel(gateway, identity);
    const from = Date.now();
    model.socket.write(
      fullRequest(token, "short") + fullRequest(token, "long"),
    );
    const at = await within(model.closed, 2_000, "the runtime's close");
    assert.ok(at - from < bounds.headersMs, `closed after ${at - from} ms`);
    // The long stream was never served, so nothing of it was cut.
    assert.doesNotMatch(model.received(), /data: /);
    // The edge's side of the connection is gone too: nothing is left open.
    const modelServer = tlsServers.mock.results[0]!.value as tls.Server;
    await within(
      (async () => {
        for (;;) {
          const count = await new Promise<number>((resolve, reject) =>
            modelServer.getConnections((err, n) =>
              err ? reject(err) : resolve(n),
            ),
          );
          if (count === 0) return;
          await new Promise((r) => setTimeout(r, 20));
        }
      })(),
      2_000,
      "the edge's connection to close",
    );
  },
);

test("M4 keep-alive idle: after a response, a silent connection is closed at the idle bound, not before", async () => {
  const { upstream } = await observedUpstream((_seen, res) =>
    res.end('{"ok":true}'),
  );
  const { gateway, identity, token } = await deadlineSetup(upstream);
  const model = await dialModel(gateway, identity);
  model.socket.write(fullRequest(token, "short"));
  await model.until((text) => text.endsWith('{"ok":true}'), 5_000);
  const from = Date.now();
  const at = await within(model.closed, 5_000, "idle close");
  assert.ok(at - from >= SHORT.idleMs - 100, `closed after ${at - from} ms`);
  assert.ok(at - from <= SHORT.idleMs + 1_000, `closed after ${at - from} ms`);
});

test("M5 silent TLS peers release the model port's slots after handshake timeout", async () => {
  shortenHandshake("model");
  const gateway = await gatewayWithClients();
  const identity = await enroll(gateway);
  const connection = await dialClient(gateway, identity);
  const { token } = await grant(connection);
  const peers = Array.from({ length: 64 }, () =>
    net.connect(gateway.clients!.modelPort, "127.0.0.1"),
  );
  const closed = peers.map(
    (peer) =>
      new Promise<void>((resolve) => peer.once("close", () => resolve())),
  );
  for (const peer of peers) {
    peer.on("error", () => {});
    open.push({ close: () => peer.destroy() });
  }
  await within(
    Promise.all(
      peers.map(
        (peer) =>
          new Promise<void>((resolve, reject) => {
            peer.once("connect", resolve);
            peer.once("error", reject);
          }),
      ),
    ),
    5_000,
    "silent peers connect",
  );
  const from = Date.now();
  await within(Promise.all(closed), 1_000 + 1_000, "silent peers close");
  assert.ok(Date.now() - from <= 2_000);
  assert.equal((await modelRequest(gateway, identity, token)).status, 200);
});

test("M6 close after stalls: close() ends stalled, silent, idle and streaming connections promptly", async () => {
  let streaming: http.ServerResponse | undefined;
  const { upstream, started } = await observedUpstream((seen, res) => {
    if (seen.body.toString() !== "stream") {
      res.end('{"ok":true}');
      return;
    }
    // A stream that never ends by itself.
    streaming = res;
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(STREAM[0]);
  });
  // Production bounds: no deadline fires during this test.
  const { gateway, identity, token } = await deadlineSetup(
    upstream,
    "production",
  );
  const stalledHeaders = await dialModel(gateway, identity);
  stalledHeaders.socket.write(`POST ${CLAUDE_PATH} HTTP/1.1\r\nhost: edge\r\n`);
  const stalledBody = await dialModel(gateway, identity);
  stalledBody.socket.write(requestHead(token, 1_000) + '{"model":"');
  const idle = await dialModel(gateway, identity);
  idle.socket.write(fullRequest(token, "short"));
  await idle.until((text) => text.endsWith('{"ok":true}'), 5_000);
  const stream = await dialModel(gateway, identity);
  stream.socket.write(fullRequest(token, "stream"));
  await stream.until((text) => text.includes(STREAM[0]!), 5_000);
  const silent = net.connect(gateway.clients!.modelPort, "127.0.0.1");
  silent.on("error", () => {});
  open.push({ close: () => silent.destroy() });
  const silentClosed = new Promise<void>((resolve) =>
    silent.once("close", () => resolve()),
  );
  await new Promise<void>((resolve) => silent.once("connect", resolve));
  // The stalled body's upstream request is in flight.
  await within(
    (async () => {
      while (started() < 3) await new Promise((r) => setTimeout(r, 20));
    })(),
    2_000,
    "upstream requests start",
  );
  assert.ok(streaming && !streaming.writableEnded);

  const from = Date.now();
  await within(gateway.clients!.close(), 2_000, "close()");
  assert.ok(Date.now() - from <= 2_000);
  await within(
    Promise.all([
      stalledHeaders.closed,
      stalledBody.closed,
      idle.closed,
      stream.closed,
      silentClosed,
    ]),
    2_000,
    "client sockets close",
  );
});

// The same state machine on fake emitters and fake timers: what real sockets
// cannot order deterministically (pipelined requests whose bodies and
// responses end in any order), on any runtime.

class FakeSocket extends EventEmitter {
  destroyed = false;
  destroys = 0;
  /** Every `setTimeout` value, in order; the last one is in force. */
  idle: number[] = [];
  destroy(): this {
    this.destroys++;
    this.destroyed = true;
    return this;
  }
  setTimeout(ms: number): this {
    this.idle.push(ms);
    return this;
  }
}

function fakeConnection() {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const socket = new FakeSocket();
  const connection = modelConnection(socket as unknown as net.Socket, SHORT);
  const request = () => {
    const req = new EventEmitter();
    const res = new EventEmitter();
    connection.request(
      req as unknown as http.IncomingMessage,
      res as unknown as http.ServerResponse,
    );
    return { req, res };
  };
  return { socket, request };
}

test("model deadlines: awaiting a request arms the headers timer and the idle timeout, a request disarms both", () => {
  const { socket } = fakeConnection();
  assert.deepEqual(socket.idle, [SHORT.idleMs]);
  socket.emit("timeout");
  assert.equal(socket.destroys, 1);

  const fresh = fakeConnection();
  vi.advanceTimersByTime(SHORT.headersMs - 1);
  assert.equal(fresh.socket.destroys, 0);
  vi.advanceTimersByTime(1);
  assert.equal(fresh.socket.destroys, 1);

  const busy = fakeConnection();
  vi.advanceTimersByTime(SHORT.headersMs - 1);
  const { req } = busy.request();
  assert.deepEqual(busy.socket.idle, [SHORT.idleMs, 0]);
  req.emit("end");
  vi.advanceTimersByTime(SHORT.requestMs * 10);
  // The response never ends: nothing bounds it.
  assert.equal(busy.socket.destroys, 0);
});

test("model deadlines: each request's body timer is its own, cleared only by its own end or close", () => {
  // The second request's body stalls; the first's end must not clear it.
  const a = fakeConnection();
  const first = a.request();
  vi.advanceTimersByTime(100);
  a.request();
  first.req.emit("end");
  first.req.emit("close");
  vi.advanceTimersByTime(SHORT.requestMs - 1);
  assert.equal(a.socket.destroys, 0);
  vi.advanceTimersByTime(1);
  assert.equal(a.socket.destroys, 1);

  // The first stalls; the second's end must not clear it, and a response
  // finishing does not count as the body.
  const b = fakeConnection();
  const stalled = b.request();
  vi.advanceTimersByTime(100);
  const second = b.request();
  second.req.emit("end");
  stalled.res.emit("finish");
  vi.advanceTimersByTime(SHORT.requestMs - 101);
  assert.equal(b.socket.destroys, 0);
  vi.advanceTimersByTime(1);
  assert.equal(b.socket.destroys, 1);
});

test("model deadlines: the connection awaits a request again only when its last open response ends", () => {
  const { socket, request } = fakeConnection();
  const short = request();
  const long = request();
  short.req.emit("end");
  long.req.emit("end");
  // The short response ends (finish, then close: counted once) while the
  // long one still streams: no timer may run.
  short.res.emit("finish");
  short.res.emit("close");
  assert.deepEqual(socket.idle, [SHORT.idleMs, 0, 0]);
  vi.advanceTimersByTime(SHORT.requestMs * 10);
  assert.equal(socket.destroys, 0);
  // The last response ends: awaiting again, headers timer and idle timeout.
  long.res.emit("finish");
  assert.deepEqual(socket.idle, [SHORT.idleMs, 0, 0, SHORT.idleMs]);
  vi.advanceTimersByTime(SHORT.headersMs - 1);
  assert.equal(socket.destroys, 0);
  vi.advanceTimersByTime(1);
  assert.equal(socket.destroys, 1);
});

test("model deadlines: no response's end re-arms while another request is open, in any order", () => {
  const { socket, request } = fakeConnection();
  const one = request();
  one.req.emit("end");
  one.res.emit("finish");
  // Count zero: awaiting again, then a request ends that.
  assert.deepEqual(socket.idle, [SHORT.idleMs, 0, SHORT.idleMs]);
  const two = request();
  const three = request();
  two.req.emit("end");
  three.req.emit("end");
  // The later request's response ends first, then the earlier one's closes.
  three.res.emit("finish");
  vi.advanceTimersByTime(SHORT.requestMs * 10);
  assert.equal(socket.destroys, 0);
  two.res.emit("close");
  assert.deepEqual(socket.idle, [
    SHORT.idleMs,
    0,
    SHORT.idleMs,
    0,
    0,
    SHORT.idleMs,
  ]);
  // A late duplicate end changes nothing: one arm, as counted.
  three.res.emit("close");
  two.res.emit("finish");
  assert.equal(socket.idle.length, 6);
  vi.advanceTimersByTime(SHORT.headersMs);
  assert.equal(socket.destroys, 1);
});

test("model deadlines: the socket's close clears every timer", () => {
  const { socket, request } = fakeConnection();
  request();
  request();
  socket.emit("close");
  vi.advanceTimersByTime(SHORT.requestMs * 10);
  assert.equal(socket.destroys, 0);
  assert.equal(vi.getTimerCount(), 0);
});
