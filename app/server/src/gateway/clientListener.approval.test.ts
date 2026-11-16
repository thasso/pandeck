/**
 * Approval enrollment on the enrollment port (Task-1410): `/enroll/start`,
 * `/enroll/poll`, the typed `/enroll`'s optional MCP token hash, and their
 * limits, through a started gateway. The page's decision is the registry's
 * `decide` until the page routes exist. Every key, token, request id and code
 * is synthetic and stays inside this process.
 */
import assert from "node:assert/strict";
import {
  createHash,
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
  X509Certificate,
} from "node:crypto";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import type http from "node:http";
import https from "node:https";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, test } from "vitest";
import { DATA_DIR } from "../config.ts";
import {
  startFakeUpstreams,
  type FakeUpstreams,
} from "../test/gatewayFixtures.ts";
import {
  ENROLLMENT_REQUEST_RETAIN_MS,
  ENROLLMENT_REQUEST_TTL_MS,
  MAX_OPEN_REQUESTS,
} from "./clientRegistry.ts";
import type { EdgeTools } from "./edgeTools.ts";
import { startGateway, type RunningGateway } from "./gateway.ts";

const ORIGIN = "https://gateway.example.test";
let upstreams: FakeUpstreams;
let clock = Date.now();
const open: { close(): unknown }[] = [];

beforeAll(async () => {
  upstreams = await startFakeUpstreams();
});
afterEach(async () => {
  while (open.length) await open.pop()!.close();
  clock = Date.now();
});
afterAll(() => upstreams.close());

/** `/mcp` answers which client reached it. */
const tools: EdgeTools = {
  handleMcp: (_req, res, caller) => {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end(`mcp ${caller.clientId}`);
  },
  host: {
    list: () => [],
    call: () =>
      Promise.resolve({
        ok: false,
        code: "unknown_tool",
        message: "No such tool.",
      }),
  },
  integrations: {
    atlassian: {
      parse: () => ({ ok: false }),
      check: () => Promise.resolve({ ok: true }),
      describe: () => undefined,
    },
  },
};

async function edge(
  options: { approvalOrigin?: string; stateDir?: string; logs?: string[] } = {
    approvalOrigin: ORIGIN,
  },
): Promise<{ gateway: RunningGateway; stateDir: string }> {
  const stateDir =
    options.stateDir ?? (await mkdtemp(join(DATA_DIR, "client-approval-")));
  const gateway = await startGateway({
    stateDir,
    upstreams: upstreams.overrides,
    now: () => clock,
    log: (line) => options.logs?.push(line),
    clients: options.approvalOrigin
      ? { approvalOrigin: options.approvalOrigin }
      : {},
    tools,
  });
  open.push(gateway);
  gateway.clients!.registry.addUser("u1");
  return { gateway, stateDir };
}

interface Answer {
  status: number;
  headers: http.IncomingHttpHeaders;
  json: Record<string, unknown>;
}

function post(
  gateway: RunningGateway,
  path: string,
  body: unknown,
  from = "127.0.0.1",
): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const request = https.request(
      {
        host: "127.0.0.1",
        localAddress: from,
        port: gateway.clients!.enrollPort,
        ca: gateway.clients!.caPem,
        method: "POST",
        path,
        agent: false,
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () =>
          resolve({
            status: response.statusCode ?? 0,
            headers: response.headers,
            json: JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<
              string,
              unknown
            >,
          }),
        );
      },
    );
    request.on("error", reject);
    request.end(typeof body === "string" ? body : JSON.stringify(body));
  });
}

const sha256 = (text: string) =>
  createHash("sha256").update(text, "utf8").digest("hex");

/** A machine: its key pair and the MCP token it generated. */
function machine() {
  const pair = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const token = `pgmcp_${randomBytes(32).toString("base64url")}`;
  return {
    key: pair.privateKey.export({ type: "pkcs8", format: "pem" }) as string,
    publicKeyPem: pair.publicKey.export({
      type: "spki",
      format: "pem",
    }) as string,
    token,
  };
}

async function startRequest(
  gateway: RunningGateway,
  who = machine(),
  from = "127.0.0.1",
) {
  const answer = await post(
    gateway,
    "/enroll/start",
    {
      publicKeyPem: who.publicKeyPem,
      mcpTokenHash: sha256(who.token),
      name: "devbox-7",
      kind: "devbox",
    },
    from,
  );
  assert.equal(answer.status, 200);
  return {
    ...who,
    requestId: answer.json.requestId as string,
    userCode: answer.json.userCode as string,
    answer,
  };
}

/** Polls past the per-request interval. */
async function poll(
  gateway: RunningGateway,
  requestId: string,
  from = "127.0.0.1",
): Promise<Answer> {
  clock += 4_000;
  return post(gateway, "/enroll/poll", { requestId }, from);
}

function mcp(
  gateway: RunningGateway,
  who: { key: string },
  cert: string,
  token: string,
) {
  return new Promise<{ status: number; text: string }>((resolve, reject) => {
    const request = https.request(
      {
        host: "127.0.0.1",
        port: gateway.clients!.modelPort,
        ca: gateway.clients!.caPem,
        key: who.key,
        cert,
        agent: false,
        method: "POST",
        path: "/mcp",
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
    request.end("{}");
  });
}

test("without an approval origin the approval routes are unknown paths; /enroll still works", async () => {
  const { gateway } = await edge({});
  const who = machine();
  const start = await post(gateway, "/enroll/start", {
    publicKeyPem: who.publicKeyPem,
    mcpTokenHash: sha256(who.token),
    name: "n",
  });
  assert.equal(start.status, 404);
  assert.deepEqual(start.json, { error: "not found" });
  const polled = await post(gateway, "/enroll/poll", {
    requestId: randomBytes(32).toString("base64url"),
  });
  assert.equal(polled.status, 404);
  assert.deepEqual(polled.json, { error: "not found" });
  const code = gateway.clients!.registry.createCode("u1", "typed");
  assert.equal(
    (await post(gateway, "/enroll", { code, publicKeyPem: who.publicKeyPem }))
      .status,
    200,
  );
});

test("a start answers the request id, the user code and a link with the code in its fragment only", async () => {
  const { gateway } = await edge({ approvalOrigin: `${ORIGIN}/` });
  const { answer, requestId, userCode } = await startRequest(gateway);
  assert.deepEqual(Object.keys(answer.json).sort(), [
    "expiresInSeconds",
    "intervalSeconds",
    "requestId",
    "userCode",
    "verificationUri",
  ]);
  assert.match(requestId, /^[A-Za-z0-9_-]{43}$/);
  assert.match(
    userCode,
    /^[BCDFGHJKLMNPQRSTVWXZ]{4}-[BCDFGHJKLMNPQRSTVWXZ]{4}$/,
  );
  assert.equal(answer.json.verificationUri, `${ORIGIN}/#enroll=${userCode}`);
  const uri = new URL(answer.json.verificationUri as string);
  assert.equal(uri.search, "");
  assert.ok(!uri.href.includes(requestId));
  assert.equal(answer.json.expiresInSeconds, 600);
  assert.equal(answer.json.intervalSeconds, 5);
  assert.deepEqual(gateway.clients!.registry.enrollmentRequest(userCode), {
    name: "devbox-7",
    kind: "devbox",
    from: "127.0.0.1",
    createdAt: clock,
    expiresAt: clock + 600_000,
  });
});

test("a start with a bad key, hash, name, kind or body answers 400 and opens nothing", async () => {
  const { gateway, stateDir } = await edge();
  const who = machine();
  const rsa = generateKeyPairSync("rsa", {
    modulusLength: 2048,
  }).publicKey.export({
    type: "spki",
    format: "pem",
  }) as string;
  const valid = {
    publicKeyPem: who.publicKeyPem,
    mcpTokenHash: sha256(who.token),
    name: "n",
  };
  for (const body of [
    "not json",
    { ...valid, publicKeyPem: rsa },
    { ...valid, mcpTokenHash: who.token },
    { ...valid, mcpTokenHash: sha256(who.token).toUpperCase() },
    { ...valid, name: "" },
    { ...valid, name: "a‮b" },
    { ...valid, kind: "router" },
  ]) {
    const answer = await post(gateway, "/enroll/start", body);
    assert.equal(answer.status, 400);
    assert.deepEqual(answer.json, {
      error: "an EC P-256 key, an MCP token hash and a name needed",
    });
  }
  const state = JSON.parse(
    await readFile(join(stateDir, "clients.json"), "utf8"),
  ) as { requests?: unknown[] };
  assert.equal(state.requests, undefined);
});

test("approve, then poll: pending, then the certificate for the start's key, whose token opens /mcp; no answer or state holds the token", async () => {
  const logs: string[] = [];
  const { gateway, stateDir } = await edge({ approvalOrigin: ORIGIN, logs });
  const started = await startRequest(gateway);
  const pending = await poll(gateway, started.requestId);
  assert.equal(pending.status, 202);
  assert.deepEqual(pending.json, { status: "pending" });
  assert.equal(
    gateway.clients!.registry.decide(started.userCode, "u1", true),
    "approved",
  );
  const collected = await poll(gateway, started.requestId);
  assert.equal(collected.status, 200);
  const { clientId, certificatePem } = collected.json as {
    clientId: string;
    certificatePem: string;
  };
  assert.deepEqual(collected.json, {
    clientId,
    certificatePem,
    caPem: gateway.clients!.caPem,
    modelPort: gateway.clients!.modelPort,
    clientPort: gateway.clients!.clientPort,
  });
  const cert = new X509Certificate(certificatePem);
  const ca = new X509Certificate(gateway.clients!.caPem);
  assert.ok(cert.checkIssued(ca) && cert.verify(ca.publicKey));
  assert.equal(cert.subject, `CN=${clientId}`);
  assert.ok(cert.publicKey.equals(createPublicKey(started.publicKeyPem)));
  const [client] = gateway.clients!.registry.clients();
  assert.equal(client!.id, clientId);
  assert.equal(client!.userId, "u1");
  assert.equal(client!.label, "devbox-7");
  assert.equal(client!.fingerprint, cert.fingerprint256);

  assert.deepEqual(await mcp(gateway, started, certificatePem, started.token), {
    status: 200,
    text: `mcp ${clientId}`,
  });
  assert.equal(
    (await mcp(gateway, started, certificatePem, machine().token)).status,
    401,
  );

  const state = await readFile(join(stateDir, "clients.json"), "utf8");
  for (const secret of [
    started.token,
    started.requestId,
    started.userCode,
    started.userCode.replace("-", ""),
  ])
    assert.ok(!state.includes(secret));
  for (const answer of [started.answer, pending, collected])
    assert.ok(!JSON.stringify(answer.json).includes(started.token));
  const logged = logs.join("\n");
  assert.ok(logs.some((line) => line.endsWith("enrollment request started")));
  assert.ok(
    logs.some((line) =>
      line.endsWith(`enrolled client ${clientId} by approval`),
    ),
  );
  const keyBody = started.publicKeyPem.split("\n")[1]!;
  for (const secret of [
    started.token,
    sha256(started.token),
    started.requestId,
    sha256(started.requestId),
    started.userCode,
    started.userCode.replace("-", ""),
    keyBody,
  ])
    assert.ok(!logged.includes(secret));
});

test("a repeat poll answers the same certificate and writes nothing, also after a restart, and mutual TLS works with it", async () => {
  const first = await edge();
  const started = await startRequest(first.gateway);
  first.gateway.clients!.registry.decide(started.userCode, "u1", true);
  const collected = await poll(first.gateway, started.requestId);
  assert.equal(collected.status, 200);
  const file = join(first.stateDir, "clients.json");
  const before = await readFile(file, "utf8");
  const again = await poll(first.gateway, started.requestId);
  assert.deepEqual(again.json, collected.json);
  assert.equal(await readFile(file, "utf8"), before);

  await open.pop()!.close();
  const { gateway } = await edge({
    approvalOrigin: ORIGIN,
    stateDir: first.stateDir,
  });
  const restarted = await poll(gateway, started.requestId);
  assert.equal(restarted.status, 200);
  assert.equal(restarted.json.clientId, collected.json.clientId);
  assert.equal(restarted.json.certificatePem, collected.json.certificatePem);
  assert.equal(await readFile(file, "utf8"), before);
  const cert = new X509Certificate(restarted.json.certificatePem as string);
  assert.equal(
    gateway.clients!.registry.clients()[0]!.fingerprint,
    cert.fingerprint256,
  );
  assert.equal(
    (
      await mcp(
        gateway,
        started,
        restarted.json.certificatePem as string,
        started.token,
      )
    ).text,
    `mcp ${restarted.json.clientId as string}`,
  );
});

test("deny answers 403 denied; expiry 410 expired; a revoked client 410 revoked; a swept record 404", async () => {
  const { gateway } = await edge();
  const registry = gateway.clients!.registry;
  const denied = await startRequest(gateway);
  registry.decide(denied.userCode, "u1", false);
  const refusal = await poll(gateway, denied.requestId);
  assert.equal(refusal.status, 403);
  assert.deepEqual(refusal.json, { error: "denied" });
  assert.equal(registry.decide(denied.userCode, "u1", true), "unknown");

  const revoked = await startRequest(gateway);
  registry.decide(revoked.userCode, "u1", true);
  const collected = await poll(gateway, revoked.requestId);
  registry.revoke(collected.json.clientId as string);
  const gone = await poll(gateway, revoked.requestId);
  assert.equal(gone.status, 410);
  assert.deepEqual(gone.json, { error: "revoked" });

  const late = await startRequest(gateway);
  registry.decide(late.userCode, "u1", true);
  clock += ENROLLMENT_REQUEST_TTL_MS;
  const expired = await poll(gateway, late.requestId);
  assert.equal(expired.status, 410);
  assert.deepEqual(expired.json, { error: "expired" });
  assert.equal(registry.clients().length, 1);

  clock += ENROLLMENT_REQUEST_RETAIN_MS;
  const swept = await poll(gateway, late.requestId);
  assert.equal(swept.status, 404);
  assert.deepEqual(swept.json, { error: "unknown request" });
});

test("polls of one request faster than every 4 s answer 429 slow_down; unknown ids cost only per-source attempts", async () => {
  const { gateway } = await edge();
  const started = await startRequest(gateway);
  const body = { requestId: started.requestId };
  assert.equal((await post(gateway, "/enroll/poll", body)).status, 202);
  clock += 3_999;
  const fast = await post(gateway, "/enroll/poll", body);
  assert.equal(fast.status, 429);
  assert.deepEqual(fast.json, { error: "slow_down" });
  assert.equal(fast.headers["retry-after"], "5");
  clock += 1;
  assert.equal((await post(gateway, "/enroll/poll", body)).status, 202);

  // The start took one of the source's 30 attempts a minute.
  for (let i = 0; i < 28; i++) {
    const unknown = await post(gateway, "/enroll/poll", {
      requestId: randomBytes(32).toString("base64url"),
    });
    assert.equal(unknown.status, 404);
    assert.deepEqual(unknown.json, { error: "unknown request" });
  }
  assert.equal(
    (await post(gateway, "/enroll/poll", { requestId: "short" })).status,
    400,
  );
  const limited = await post(gateway, "/enroll/poll", {
    requestId: randomBytes(32).toString("base64url"),
  });
  assert.equal(limited.status, 429);
  assert.deepEqual(limited.json, { error: "too many enrollment attempts" });
  // A known request is limited per request, not per source.
  assert.equal((await poll(gateway, started.requestId)).status, 202);
  assert.equal((await post(gateway, "/enroll/start", {})).status, 429);
});

test("start admission: the 5th open request from one address answers 429 while another address starts; 64 in all, then 503", async () => {
  const { gateway } = await edge();
  for (let i = 0; i < 4; i++)
    await startRequest(gateway, machine(), "127.0.0.2");
  const who = machine();
  const body = {
    publicKeyPem: who.publicKeyPem,
    mcpTokenHash: sha256(who.token),
    name: "fifth",
  };
  const fifth = await post(gateway, "/enroll/start", body, "127.0.0.2");
  assert.equal(fifth.status, 429);
  assert.deepEqual(fifth.json, { error: "too many open enrollment requests" });
  await startRequest(gateway, machine(), "127.0.0.3");
  for (let opened = 5; opened < MAX_OPEN_REQUESTS; opened++)
    await startRequest(gateway, machine(), `127.0.1.${Math.floor(opened / 4)}`);
  const full = await post(gateway, "/enroll/start", body, "127.0.2.1");
  assert.equal(full.status, 503);
  assert.deepEqual(full.json, { error: "enrollment requests full" });
  clock += ENROLLMENT_REQUEST_TTL_MS;
  assert.equal(
    (await post(gateway, "/enroll/start", body, "127.0.0.2")).status,
    200,
  );
});

test("every live record, retained ones included, can be polled at the same moment", async () => {
  const { gateway } = await edge();
  const started: string[] = [];
  for (const batch of [0, 1]) {
    for (let i = 0; i < MAX_OPEN_REQUESTS; i++)
      started.push(
        (
          await startRequest(
            gateway,
            machine(),
            `127.0.${10 + batch}.${Math.floor(i / 4) + 1}`,
          )
        ).requestId,
      );
    if (batch === 0) clock += ENROLLMENT_REQUEST_TTL_MS;
  }
  clock += 4_000;
  // One after the other at one clock reading: the port holds 64 connections.
  const answers: Answer[] = [];
  for (const requestId of started)
    answers.push(
      await post(gateway, "/enroll/poll", { requestId }, "127.0.20.1"),
    );
  assert.equal(answers.length, 2 * MAX_OPEN_REQUESTS);
  assert.deepEqual(
    new Set(answers.slice(0, MAX_OPEN_REQUESTS).map((a) => a.status)),
    new Set([410]),
  );
  assert.deepEqual(
    new Set(answers.slice(MAX_OPEN_REQUESTS).map((a) => a.status)),
    new Set([202]),
  );
  // Each is still remembered: an immediate second poll is too fast.
  for (const requestId of [started[0]!, started.at(-1)!])
    assert.equal(
      (await post(gateway, "/enroll/poll", { requestId }, "127.0.20.1")).status,
      429,
    );
}, 60_000);

test("/enroll stores an optional MCP token hash; the machine's token opens /mcp; without it, as before", async () => {
  const { gateway, stateDir } = await edge();
  const registry = gateway.clients!.registry;
  const who = machine();
  const malformed = await post(gateway, "/enroll", {
    code: registry.createCode("u1", "typed"),
    publicKeyPem: who.publicKeyPem,
    mcpTokenHash: "abc",
  });
  assert.equal(malformed.status, 400);
  assert.equal(registry.clients().length, 0);

  const answer = await post(gateway, "/enroll", {
    code: registry.createCode("u1", "typed"),
    publicKeyPem: who.publicKeyPem,
    mcpTokenHash: sha256(who.token),
  });
  assert.equal(answer.status, 200);
  assert.deepEqual(Object.keys(answer.json).sort(), [
    "caPem",
    "certificatePem",
    "clientId",
    "clientPort",
    "modelPort",
  ]);
  assert.equal(
    (await mcp(gateway, who, answer.json.certificatePem as string, who.token))
      .text,
    `mcp ${answer.json.clientId as string}`,
  );
  assert.ok(
    !(await readFile(join(stateDir, "clients.json"), "utf8")).includes(
      who.token,
    ),
  );

  const old = machine();
  const plain = await post(gateway, "/enroll", {
    code: registry.createCode("u1", "old relay"),
    publicKeyPem: old.publicKeyPem,
  });
  assert.equal(plain.status, 200);
  const client = registry.clients().find((c) => c.id === plain.json.clientId)!;
  assert.equal(client.mcpTokenHash, undefined);
});

test("a registry failure answers 503 on start and poll and leaves the gateway serving", async () => {
  const { gateway, stateDir } = await edge();
  const started = await startRequest(gateway);
  const file = join(stateDir, "clients.json");
  const saved = await readFile(file, "utf8");
  await writeFile(file, "corrupt json");
  const who = machine();
  const start = await post(gateway, "/enroll/start", {
    publicKeyPem: who.publicKeyPem,
    mcpTokenHash: sha256(who.token),
    name: "n",
  });
  assert.equal(start.status, 503);
  assert.equal((await poll(gateway, started.requestId)).status, 503);
  await writeFile(file, saved);
  assert.equal((await poll(gateway, started.requestId)).status, 202);
});
