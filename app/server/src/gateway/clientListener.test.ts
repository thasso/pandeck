/**
 * The edge's client listener (`clientListener.ts`, plan Task-1384): enrollment
 * with one-time codes, mutual TLS on the model and client ports with the
 * client checked per connection and per request, and leases scoped to their
 * client. Fake upstreams and fake token files under the test's `DATA_DIR`.
 */
import assert from "node:assert/strict";
import { generateKeyPairSync, X509Certificate } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import https from "node:https";
import { join } from "node:path";
import tls from "node:tls";
import { afterAll, afterEach, beforeAll, test } from "vitest";
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

interface Identity {
  clientId: string;
  key: string;
  cert: string;
}

let upstreams: FakeUpstreams;
let claudeFile: string;
let clock = Date.now();
const open: { close(): unknown }[] = [];

beforeAll(async () => {
  upstreams = await startFakeUpstreams();
  ({ claudeFile } = await writeTokenFiles());
});

afterEach(async () => {
  while (open.length) await open.pop()!.close();
  upstreams.reset();
  clock = Date.now();
});

afterAll(() => upstreams.close());

async function gatewayWithClients(): Promise<RunningGateway> {
  const gateway = await startGateway({
    stateDir: await mkdtemp(join(DATA_DIR, "client-listener-")),
    upstreams: upstreams.overrides,
    now: () => clock,
    log: () => {},
    clients: {},
  });
  open.push(gateway);
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
  await assert.rejects(modelRequest(gateway, a, token));
  await assert.rejects(
    connection.request(CLIENT_METHODS.listAccounts, encodeClientMessage({})),
    (err: unknown) =>
      err instanceof WorkerRequestError && err.code === "client_revoked",
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
