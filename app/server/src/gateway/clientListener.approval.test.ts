/**
 * Approval enrollment on the enrollment port (Task-1410): `/enroll/start`,
 * `/enroll/poll`, the typed `/enroll`'s optional MCP token hash, and their
 * limits, through a started gateway. The page's decision is the registry's
 * `decide` until the page routes exist. Every key, token, request id and code
 * is synthetic and stays inside this process. Zero-click (Task-1410 PR2): a
 * start's devbox proof, through an injected verifier or the real one against
 * the loopback Google fake.
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
import net from "node:net";
import { join } from "node:path";
import tls from "node:tls";
import { afterAll, afterEach, beforeAll, test, vi } from "vitest";
import { DATA_DIR } from "../config.ts";
import { admittedEmail, type AllowRule } from "../gatewayWeb/config.ts";
import {
  startFakeUpstreams,
  type FakeUpstreams,
} from "../test/gatewayFixtures.ts";
import {
  FAKE_CODER_CLIENT_ID,
  FAKE_HD,
  FAKE_OWNER_EMAIL,
  FAKE_OWNER_SUB,
  FAKE_OWNER_TOKEN,
  startGoogleFake,
  type GoogleFake,
} from "../test/googleFake.ts";
import {
  ENROLLMENT_REQUEST_RETAIN_MS,
  ENROLLMENT_REQUEST_TTL_MS,
  MAX_OPEN_REQUESTS,
} from "./clientRegistry.ts";
import {
  devboxApproval,
  type DevboxApproval,
  type DevboxProofResult,
} from "./devboxProof.ts";
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
  vi.restoreAllMocks();
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
    slack: { describe: () => undefined },
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

test("without an approval origin start is unavailable, but poll remains available; /enroll still works", async () => {
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
  assert.deepEqual(polled.json, { error: "unknown request" });
  const code = gateway.clients!.registry.createCode("u1", "typed");
  assert.equal(
    (await post(gateway, "/enroll", { code, publicKeyPem: who.publicKeyPem }))
      .status,
    200,
  );
});

test("an approved request can be collected and recovered after restart without an approval origin", async () => {
  const first = await edge({ approvalOrigin: ORIGIN });
  const started = await startRequest(first.gateway);
  assert.equal(
    first.gateway.clients!.registry.decide(started.userCode, "u1", true),
    "approved",
  );
  const file = join(first.stateDir, "clients.json");
  await open.pop()!.close();

  const { gateway } = await edge({ stateDir: first.stateDir });
  const collected = await poll(gateway, started.requestId);
  assert.equal(collected.status, 200);
  const before = await readFile(file, "utf8");
  const duplicate = await poll(gateway, started.requestId);
  assert.deepEqual(duplicate.json, collected.json);
  assert.equal(await readFile(file, "utf8"), before);
});

test("a start answers the request id, the user code and a link with the code in its fragment only", async () => {
  const { gateway } = await edge({ approvalOrigin: `${ORIGIN}/` });
  const { answer, requestId, userCode } = await startRequest(gateway);
  assert.deepEqual(Object.keys(answer.json).sort(), [
    "approval",
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
  assert.equal(answer.json.approval, "browser");
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
  const sourceRequests = [];
  for (let i = 0; i < 4; i++)
    sourceRequests.push(await startRequest(gateway, machine(), "127.0.0.2"));
  const who = machine();
  const body = {
    publicKeyPem: who.publicKeyPem,
    mcpTokenHash: sha256(who.token),
    name: "fifth",
  };
  const fifth = await post(gateway, "/enroll/start", body, "127.0.0.2");
  assert.equal(fifth.status, 429);
  assert.deepEqual(fifth.json, { error: "too many open enrollment requests" });
  assert.equal(
    gateway.clients!.registry.decide(sourceRequests[0]!.userCode, "u1", false),
    "denied",
  );
  assert.equal(
    (await post(gateway, "/enroll/start", body, "127.0.0.2")).status,
    200,
  );
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

// --- Zero-click enrollment (Task-1410 PR2) ----------------------------------

const GOOGLE_ISSUER = "https://accounts.google.com";
const ALLOW: AllowRule = {
  emailDomains: ["example.test"],
  emails: [],
  claims: { hd: FAKE_HD },
};
const PR1_KEYS = [
  "expiresInSeconds",
  "intervalSeconds",
  "requestId",
  "userCode",
  "verificationUri",
];

async function devboxEdge(
  options: {
    devboxApproval?: DevboxApproval;
    logs?: string[];
    enrollIdle?: { baseMs: number; proofMs: number };
  } = {},
): Promise<{ gateway: RunningGateway; stateDir: string }> {
  const stateDir = await mkdtemp(join(DATA_DIR, "client-devbox-"));
  const gateway = await startGateway({
    stateDir,
    upstreams: upstreams.overrides,
    now: () => clock,
    log: (line) => options.logs?.push(line),
    clients: {
      approvalOrigin: ORIGIN,
      ...(options.devboxApproval
        ? { devboxApproval: options.devboxApproval }
        : {}),
    },
    ...(options.enrollIdle ? { enrollIdle: options.enrollIdle } : {}),
    tools,
  });
  open.push(gateway);
  gateway.clients!.registry.addUser("u1");
  return { gateway, stateDir };
}

/** A verifier answering `result`, recording each token, clock and signal. */
function scripted(
  result: (
    now: () => number,
    signal: AbortSignal,
  ) => DevboxProofResult | Promise<DevboxProofResult>,
) {
  const calls: { token: string; at: number; signal: AbortSignal }[] = [];
  const approval: DevboxApproval = {
    issuer: GOOGLE_ISSUER,
    verify: async (token, { now, signal }) => {
      calls.push({ token, at: now(), signal });
      return result(now, signal);
    },
  };
  return { approval, calls };
}

/** The proof of the fake owner, as the verifier answers it. */
const proven =
  (subject = FAKE_OWNER_SUB, email = FAKE_OWNER_EMAIL) =>
  (now: () => number): DevboxProofResult => ({
    ok: true,
    subject,
    email,
    notAfter: now() + 3_566_000,
  });

function startBody(who: ReturnType<typeof machine>, token?: string) {
  return {
    publicKeyPem: who.publicKeyPem,
    mcpTokenHash: sha256(who.token),
    name: "devbox-7",
    kind: "devbox",
    ...(token === undefined ? {} : { devbox: { googleAccessToken: token } }),
  };
}

async function startWithProof(
  gateway: RunningGateway,
  token: string | undefined,
  from = "127.0.0.1",
) {
  const who = machine();
  const answer = await post(
    gateway,
    "/enroll/start",
    startBody(who, token),
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

async function until(done: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!done()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** Nothing the proof touched in a log line: token, hash, email, ids, codes. */
function assertQuiet(
  logs: string[],
  started: { requestId: string; userCode: string }[],
): void {
  const logged = logs.join("\n");
  for (const secret of [
    FAKE_OWNER_TOKEN,
    sha256(FAKE_OWNER_TOKEN),
    FAKE_OWNER_EMAIL,
    ...started.flatMap((one) => [
      one.requestId,
      one.userCode,
      one.userCode.replace("-", ""),
    ]),
  ])
    assert.ok(!logged.includes(secret), "a log line holds a secret");
}

test("a devbox proof that holds approves the request at once: the first poll collects, a user exists for the owner, and only the token's hash is kept", async () => {
  const logs: string[] = [];
  const verifier = scripted(proven());
  const { gateway, stateDir } = await devboxEdge({
    devboxApproval: verifier.approval,
    logs,
  });
  const registry = gateway.clients!.registry;
  const started = await startWithProof(gateway, FAKE_OWNER_TOKEN);
  assert.deepEqual(Object.keys(started.answer.json).sort(), [
    "approval",
    ...PR1_KEYS,
  ]);
  assert.equal(started.answer.json.approval, "automatic");
  // The verifier got the token and the registry's clock.
  assert.equal(verifier.calls.length, 1);
  assert.equal(verifier.calls[0]!.token, FAKE_OWNER_TOKEN);
  assert.equal(verifier.calls[0]!.at, clock);
  // The page never sees it; the owner is a new user of Google's issuer.
  assert.equal(registry.enrollmentRequest(started.userCode), undefined);
  const owner = registry
    .users()
    .find((user) => user.oidc?.subject === FAKE_OWNER_SUB)!;
  assert.deepEqual(owner.oidc, {
    issuer: GOOGLE_ISSUER,
    subject: FAKE_OWNER_SUB,
  });
  assert.equal(owner.email, FAKE_OWNER_EMAIL);

  const collected = await poll(gateway, started.requestId);
  assert.equal(collected.status, 200);
  const client = registry
    .clients()
    .find((c) => c.id === collected.json.clientId)!;
  assert.equal(client.userId, owner.id);
  assert.equal(
    (
      await mcp(
        gateway,
        started,
        collected.json.certificatePem as string,
        started.token,
      )
    ).text,
    `mcp ${client.id}`,
  );

  // A second devbox of that owner, with another token: the same user.
  const second = await startWithProof(gateway, "FAKE_second-owner-token");
  assert.equal(second.answer.json.approval, "automatic");
  assert.equal(
    registry.users().filter((user) => user.oidc?.subject === FAKE_OWNER_SUB)
      .length,
    1,
  );

  assert.deepEqual(
    logs.filter((line) => line.includes("automatically")),
    [
      `enrollment request approved automatically for user ${owner.id}, new user`,
      `enrollment request approved automatically for user ${owner.id}`,
    ],
  );
  assertQuiet(logs, [started, second]);
  const state = await readFile(join(stateDir, "clients.json"), "utf8");
  assert.ok(!state.includes(FAKE_OWNER_TOKEN));
  assert.ok(state.includes(sha256(FAKE_OWNER_TOKEN)));
  for (const answer of [started.answer, collected])
    assert.ok(!JSON.stringify(answer.json).includes(FAKE_OWNER_TOKEN));
});

test("every refused proof answers browser with its fixed reason, logs it without upstream text, and leaves the request to the page", async () => {
  const logs: string[] = [];
  let next: (now: () => number) => DevboxProofResult = proven();
  const verifier = scripted((now) => next(now));
  const { gateway, stateDir } = await devboxEdge({
    devboxApproval: verifier.approval,
    logs,
  });
  const registry = gateway.clients!.registry;
  const file = join(stateDir, "clients.json");
  let source = 1;
  /** A start with `token` from a new address: browser for `reason`. */
  const refused = async (
    token: string,
    reason: string,
    line: string,
  ): Promise<{ requestId: string; userCode: string }> => {
    source += 1;
    const before = logs.length;
    const started = await startWithProof(gateway, token, `127.0.0.${source}`);
    assert.deepEqual(Object.keys(started.answer.json).sort(), [
      "approval",
      "automaticRefused",
      ...PR1_KEYS,
    ]);
    assert.equal(started.answer.json.approval, "browser");
    assert.equal(started.answer.json.automaticRefused, reason);
    assert.deepEqual(
      logs.slice(before).filter((l) => l.startsWith("automatic")),
      [line],
    );
    return started;
  };
  /** The page approves it and the machine collects it. */
  const pageApproves = async (started: {
    requestId: string;
    userCode: string;
  }): Promise<void> => {
    assert.equal(registry.decide(started.userCode, "u1", true), "approved");
    assert.equal((await poll(gateway, started.requestId)).status, 200);
  };
  const fileBefore = await readFile(file, "utf8").catch(() => "");
  const seen: { requestId: string; userCode: string }[] = [];

  // The verifier's own refusals, with an HTTP status or errno code at most.
  next = () => ({ ok: false, reason: "token_rejected", code: "400" });
  seen.push(
    await refused(
      FAKE_OWNER_TOKEN,
      "token_rejected",
      "automatic enrollment declined: token_rejected (400)",
    ),
  );
  next = () => ({ ok: false, reason: "not_admitted" });
  seen.push(
    await refused(
      FAKE_OWNER_TOKEN,
      "not_admitted",
      "automatic enrollment declined: not_admitted",
    ),
  );
  next = () => ({ ok: false, reason: "unavailable", code: "ECONNREFUSED" });
  seen.push(
    await refused(
      FAKE_OWNER_TOKEN,
      "unavailable",
      "automatic enrollment declined: unavailable (ECONNREFUSED)",
    ),
  );
  // An expired proof is a rejected token.
  next = (now) => ({ ...proven()(now), notAfter: now() }) as DevboxProofResult;
  seen.push(
    await refused(
      FAKE_OWNER_TOKEN,
      "token_rejected",
      "automatic enrollment declined: token_rejected",
    ),
  );
  for (const started of seen) await pageApproves(started);
  // No user, no ledger entry from any of them.
  assert.equal(
    registry.users().some((user) => user.oidc !== undefined),
    false,
  );
  assert.ok(!(await readFile(file, "utf8")).includes(sha256(FAKE_OWNER_TOKEN)));
  assert.notEqual(fileBefore, undefined);

  // An operator's claim waiting on the owner's email: the page binds it.
  registry.addUser("u2");
  registry.claimUser("u2", FAKE_OWNER_EMAIL, 60_000);
  next = proven();
  const claimed = await refused(
    FAKE_OWNER_TOKEN,
    "claim_pending",
    "automatic enrollment declined: claim_pending",
  );
  assert.equal(registry.users().length, 2);
  await pageApproves(claimed);
  seen.push(claimed);
  // The owner signs in on the page, which binds the claim: later proofs
  // reach that user.
  assert.deepEqual(
    registry.signIn({
      issuer: GOOGLE_ISSUER,
      subject: FAKE_OWNER_SUB,
      email: FAKE_OWNER_EMAIL,
    }),
    { userId: "u2", outcome: "bound" },
  );

  // Once per token; and the owner's limits are the page's.
  const owner = await startWithProof(
    gateway,
    "FAKE_owner-token-2",
    "127.0.0.20",
  );
  assert.equal(owner.answer.json.approval, "automatic");
  const reused = await refused(
    "FAKE_owner-token-2",
    "already_used",
    "automatic enrollment declined: already_used",
  );
  await pageApproves(reused);
  const ownerId = registry
    .users()
    .find((user) => user.oidc?.subject === FAKE_OWNER_SUB)!.id;
  for (let i = 0; i < 3; i += 1) registry.createCode(ownerId, `code ${i}`);
  const limited = await refused(
    "FAKE_owner-token-3",
    "limit",
    "automatic enrollment declined: limit",
  );
  await pageApproves(limited);
  assertQuiet(logs, [...seen, owner, reused, limited]);
});

test("a request the page decides or that expires while the proof runs answers browser with unavailable; the poll answers what happened", async () => {
  const logs: string[] = [];
  let during: (userCode: string) => void = () => {};
  const codes: string[] = [];
  const verifier = scripted((now) => {
    during(codes.at(-1)!);
    return proven()(now);
  });
  const { gateway, stateDir } = await devboxEdge({
    devboxApproval: verifier.approval,
    logs,
  });
  const registry = gateway.clients!.registry;
  // The user code exists only inside the start until it answers.
  const startRequest = registry.startRequest.bind(registry);
  vi.spyOn(registry, "startRequest").mockImplementation((start) => {
    const outcome = startRequest(start);
    if (outcome.ok) codes.push(outcome.userCode);
    return outcome;
  });
  const inWindow = async (from: string) => {
    const before = logs.length;
    const started = await startWithProof(gateway, FAKE_OWNER_TOKEN, from);
    assert.equal(started.answer.json.approval, "browser");
    assert.equal(started.answer.json.automaticRefused, "unavailable");
    assert.deepEqual(
      logs.slice(before).filter((line) => line.startsWith("automatic")),
      ["automatic enrollment declined: unavailable"],
    );
    return started;
  };

  // The page decides first: the poll collects the page's decision.
  during = (userCode) =>
    assert.equal(registry.decide(userCode, "u1", true), "approved");
  const decided = await inWindow("127.0.0.2");
  const collected = await poll(gateway, decided.requestId);
  assert.equal(collected.status, 200);
  assert.equal(
    registry.clients().find((c) => c.id === collected.json.clientId)!.userId,
    "u1",
  );

  // The request expires first: the poll answers expired.
  during = () => {
    clock += ENROLLMENT_REQUEST_TTL_MS;
  };
  const expired = await inWindow("127.0.0.3");
  const late = await poll(gateway, expired.requestId);
  assert.equal(late.status, 410);
  assert.deepEqual(late.json, { error: "expired" });

  // Neither proof created a user or spent its token.
  assert.equal(verifier.calls.length, 2);
  assert.equal(
    registry.users().some((user) => user.oidc),
    false,
  );
  assert.ok(
    !(await readFile(join(stateDir, "clients.json"), "utf8")).includes(
      sha256(FAKE_OWNER_TOKEN),
    ),
  );
  assertQuiet(logs, [decided, expired]);
});

test("without devbox approval a proof is not_configured and nothing is called; a start without a proof answers browser alone", async () => {
  const logs: string[] = [];
  const { gateway } = await devboxEdge({ logs });
  const proofless = await startWithProof(gateway, undefined);
  assert.deepEqual(Object.keys(proofless.answer.json).sort(), [
    "approval",
    ...PR1_KEYS,
  ]);
  assert.equal(proofless.answer.json.approval, "browser");
  const ignored = await startWithProof(gateway, FAKE_OWNER_TOKEN);
  assert.equal(ignored.answer.json.approval, "browser");
  assert.equal(ignored.answer.json.automaticRefused, "not_configured");
  assert.deepEqual(
    logs.filter((line) => line.startsWith("automatic")),
    ["automatic enrollment declined: not_configured"],
  );
  assert.equal(
    gateway.clients!.registry.decide(ignored.userCode, "u1", true),
    "approved",
  );
  assert.equal((await poll(gateway, ignored.requestId)).status, 200);
  assertQuiet(logs, [proofless, ignored]);

  // With a verifier configured, a start without a proof calls nothing.
  const verifier = scripted(proven());
  const configured = await devboxEdge({ devboxApproval: verifier.approval });
  const plain = await startWithProof(configured.gateway, undefined);
  assert.equal(plain.answer.json.approval, "browser");
  assert.equal(plain.answer.json.automaticRefused, undefined);
  assert.equal(verifier.calls.length, 0);
});

/** The real verifier against the Google fake, with a short proof deadline. */
function realVerifier(fake: GoogleFake, proofMs: number): DevboxApproval {
  return devboxApproval({
    issuer: GOOGLE_ISSUER,
    googleClientId: FAKE_CODER_CLIENT_ID,
    admit: (claims) => admittedEmail(ALLOW, claims),
    endpoints: fake.endpoints,
    timeouts: { proofMs },
  });
}

test("at most four proofs run at once: a fifth start answers unavailable at once, the four end at their deadline, every request stays open", async () => {
  const fake = await startGoogleFake();
  open.push(fake);
  fake.tokenInfo = () => {};
  const logs: string[] = [];
  const { gateway } = await devboxEdge({
    devboxApproval: realVerifier(fake, 2_000),
    logs,
  });
  const four = [2, 3, 4, 5].map((n) =>
    startWithProof(gateway, FAKE_OWNER_TOKEN, `127.0.0.${n}`),
  );
  await until(() => fake.on("tokeninfo").length === 4, "four proofs");
  const sent = Date.now();
  const fifth = await startWithProof(gateway, FAKE_OWNER_TOKEN, "127.0.0.6");
  assert.ok(Date.now() - sent < 1_000, "the fifth waits for no proof");
  assert.equal(fifth.answer.json.approval, "browser");
  assert.equal(fifth.answer.json.automaticRefused, "unavailable");
  const ended = await Promise.all(four);
  assert.ok(Date.now() - sent >= 1_500, "the four ran to their deadline");
  for (const started of ended) {
    assert.equal(started.answer.json.approval, "browser");
    assert.equal(started.answer.json.automaticRefused, "unavailable");
  }
  // No fifth call; each held call's socket closed.
  assert.equal(fake.seen.length, 4);
  await Promise.all(fake.seen.map((request) => request.closed));
  assert.deepEqual(
    logs.filter((line) => line.startsWith("automatic")).sort(),
    [
      "automatic enrollment declined: unavailable (busy)",
      ...Array<string>(4).fill(
        "automatic enrollment declined: unavailable (timeout)",
      ),
    ].sort(),
  );
  for (const started of [...ended, fifth])
    assert.equal(
      gateway.clients!.registry.decide(started.userCode, "u1", true),
      "approved",
    );
  assertQuiet(logs, [...ended, fifth]);
});

test("a proof outlives the idle bound, which is back before the answer: a hanging Google answers browser on a live connection, and the page still approves", async () => {
  const fake = await startGoogleFake();
  open.push(fake);
  fake.tokenInfo = () => {};
  const { gateway } = await devboxEdge({
    devboxApproval: realVerifier(fake, 600),
    enrollIdle: { baseMs: 300, proofMs: 900 },
  });
  // Every idle bound set on a socket, with when; the test's own client
  // sockets set none.
  const bounds: { socket: net.Socket; ms: number; at: number }[] = [];
  const setTimeout = net.Socket.prototype.setTimeout;
  vi.spyOn(net.Socket.prototype, "setTimeout").mockImplementation(function (
    this: net.Socket,
    ms: number,
    ...rest: unknown[]
  ) {
    bounds.push({ socket: this, ms, at: Date.now() });
    return setTimeout.call(this, ms, ...(rest as [])) as net.Socket;
  });
  const agent = new https.Agent({
    ca: gateway.clients!.caPem,
    keepAlive: true,
    maxSockets: 1,
  });
  open.push({ close: () => agent.destroy() });
  const keptAlive = (body: unknown) =>
    new Promise<{ status: number; json: Record<string, unknown> }>(
      (resolve, reject) => {
        const request = https.request(
          {
            host: "127.0.0.1",
            port: gateway.clients!.enrollPort,
            method: "POST",
            path: "/enroll/start",
            agent,
          },
          (response) => {
            const chunks: Buffer[] = [];
            response.on("data", (chunk: Buffer) => chunks.push(chunk));
            response.on("end", () =>
              resolve({
                status: response.statusCode ?? 0,
                json: JSON.parse(
                  Buffer.concat(chunks).toString("utf8"),
                ) as Record<string, unknown>,
              }),
            );
          },
        );
        request.on("error", reject);
        request.end(JSON.stringify(body));
      },
    );

  const sent = Date.now();
  const who = machine();
  const answer = await keptAlive(startBody(who, FAKE_OWNER_TOKEN));
  const answeredAt = Date.now();
  // 600 ms of proof against a 300 ms baseline: answered, not reset.
  assert.equal(answer.status, 200);
  assert.ok(answeredAt - sent >= 550, `answered after ${answeredAt - sent}`);
  assert.equal(answer.json.approval, "browser");
  assert.equal(answer.json.automaticRefused, "unavailable");
  const raised = bounds.filter((bound) => bound.ms === 900);
  assert.equal(raised.length, 1);
  const restored = bounds.filter(
    (bound) =>
      bound.socket === raised[0]!.socket &&
      bound.ms === 300 &&
      bound.at >= raised[0]!.at,
  );
  assert.ok(
    restored.some((bound) => bound.at >= raised[0]!.at + 500),
    "the baseline is restored after the proof",
  );
  assert.ok(restored.every((bound) => bound.at <= answeredAt));

  // The same kept-alive connection serves the next start, without a proof,
  // which raises nothing.
  bounds.length = 0;
  const plain = await keptAlive(startBody(machine()));
  assert.equal(plain.status, 200);
  assert.equal(plain.json.approval, "browser");
  assert.deepEqual(
    bounds.filter((bound) => bound.ms === 900),
    [],
  );

  // A fresh connection left without a request closes at the baseline.
  vi.restoreAllMocks();
  const raw = tls.connect({
    host: "127.0.0.1",
    port: gateway.clients!.enrollPort,
    ca: gateway.clients!.caPem,
  });
  await new Promise<void>((resolve, reject) => {
    raw.once("secureConnect", resolve);
    raw.once("error", reject);
  });
  const connectedAt = Date.now();
  await new Promise<void>((resolve) => raw.once("close", () => resolve()));
  const idle = Date.now() - connectedAt;
  assert.ok(idle >= 200 && idle < 1_500, `closed after ${idle} ms`);

  // The page approves the request the proof left open; the machine collects.
  const userCode = answer.json.userCode as string;
  assert.equal(
    gateway.clients!.registry.decide(userCode, "u1", true),
    "approved",
  );
  clock += 4_000;
  const collected = await post(gateway, "/enroll/poll", {
    requestId: answer.json.requestId,
  });
  assert.equal(collected.status, 200);
});

test("a connection that ends during the proof aborts it and approves nothing", async () => {
  const logs: string[] = [];
  let finished!: () => void;
  const done = new Promise<void>((resolve) => (finished = resolve));
  // A verifier that ignores the abort and proves the owner anyway.
  const verifier = scripted(async (now, signal) => {
    await new Promise<void>((resolve) =>
      signal.addEventListener("abort", () => resolve(), { once: true }),
    );
    finished();
    return proven()(now);
  });
  const { gateway, stateDir } = await devboxEdge({
    devboxApproval: verifier.approval,
    logs,
  });
  const request = https.request({
    host: "127.0.0.1",
    port: gateway.clients!.enrollPort,
    ca: gateway.clients!.caPem,
    method: "POST",
    path: "/enroll/start",
    agent: false,
  });
  request.on("error", () => {});
  request.end(JSON.stringify(startBody(machine(), FAKE_OWNER_TOKEN)));
  await until(() => verifier.calls.length === 1, "the proof");
  request.destroy();
  await done;
  await until(
    () => logs.some((line) => line.startsWith("automatic")),
    "the decline",
  );
  assert.ok(verifier.calls[0]!.signal.aborted);
  assert.deepEqual(
    logs.filter((line) => line.startsWith("automatic")),
    ["automatic enrollment declined: unavailable"],
  );
  assert.equal(
    gateway.clients!.registry.users().some((user) => user.oidc),
    false,
  );
  assert.ok(
    !(await readFile(join(stateDir, "clients.json"), "utf8")).includes(
      sha256(FAKE_OWNER_TOKEN),
    ),
  );
});

test("a registry failure after the proof answers 503 like a thrown one and leaves the gateway serving", async () => {
  const logs: string[] = [];
  let file = "";
  let saved = "";
  const verifier = scripted(async (now) => {
    saved = await readFile(file, "utf8");
    await writeFile(file, "corrupt json");
    return proven()(now);
  });
  const { gateway, stateDir } = await devboxEdge({
    devboxApproval: verifier.approval,
    logs,
  });
  file = join(stateDir, "clients.json");
  const answer = await post(
    gateway,
    "/enroll/start",
    startBody(machine(), FAKE_OWNER_TOKEN),
  );
  assert.equal(answer.status, 503);
  assert.deepEqual(answer.json, { error: "client registry unavailable" });
  assert.ok(logs.includes("enrollment failed: client registry unavailable"));
  await writeFile(file, saved);
  const after = await startWithProof(gateway, undefined, "127.0.0.9");
  assert.equal(after.answer.json.approval, "browser");
});
