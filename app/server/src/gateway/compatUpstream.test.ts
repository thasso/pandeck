/**
 * The gateway's `/compat` upstream (`compatUpstream.ts`, `forward.ts`): each
 * OpenAI-compatible profile's endpoint and key, pushed by the server over
 * control and held in memory only, forwarded over plain HTTP or TLS as the
 * push says, to exactly `POST <base path>/chat/completions`, for an engine or
 * server lease of that profile alone. Fake endpoints and fake upstreams on
 * loopback; every key and token is fake.
 */
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rmdir } from "node:fs/promises";
import http from "node:http";
import https from "node:https";
import type net from "node:net";
import { join } from "node:path";
import type tls from "node:tls";
import { afterAll, afterEach, beforeAll, test } from "vitest";
import { DATA_DIR } from "../config.ts";
import {
  issueLeafCertificate,
  loadOrCreateCa,
  type CertificatePair,
} from "../packageProxy/certificateAuthority.ts";
import { isLoginDeath } from "../providerErrors.ts";
import {
  COMPAT_KEY_A,
  COMPAT_KEY_B,
  dialControl,
  fakeProcesses,
  startFakeUpstreams,
  writeTokenFiles,
  type FakeUpstreams,
} from "../test/gatewayFixtures.ts";
import {
  WorkerRequestError,
  type WorkerConnection,
} from "../workerProtocol/connection.ts";
import { createInProcessTransport } from "../workerProtocol/inProcessTransport.ts";
import { createCompatUpstream } from "./compatUpstream.ts";
import {
  CONTROL_METHODS,
  GATEWAY_CONTROL_PROTOCOL,
  decodeLeaseGranted,
  decodeLeasesRevoked,
  encodeControlRequest,
  type LeaseGrant,
} from "./controlMethods.ts";
import { startGateway, type RunningGateway } from "./gateway.ts";
import type { GatewayProfile } from "./profiles.ts";
import { refusalText, type Refusal } from "./refusals.ts";

const BODY_SENTINEL = "compat-body-sentinel";
const SSE_REPLY =
  'data: {"choices":[{"delta":{"content":"compatible"}}]}\n\ndata: [DONE]\n\n';
const COMPAT_PATH = "/compat/v1/chat/completions";
const CHAT_BODY = JSON.stringify({ model: "m", note: BODY_SENTINEL });

interface Seen {
  method: string;
  url: string;
  headers: http.IncomingHttpHeaders;
  servername: string | undefined;
  body: Buffer;
}

interface FakeEndpoint {
  /** `http(s)://<host>:<port>`, without a base path. */
  origin: string;
  seen: Seen[];
  /** Answers each request once its body was read. */
  respond: (seen: Seen, res: http.ServerResponse) => void;
  close(): Promise<void>;
}

const answerSse = (_seen: Seen, res: http.ServerResponse): void => {
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "set-cookie": "endpoint=1",
  });
  res.end(SSE_REPLY);
};

let ca: CertificatePair;
let upstreams: FakeUpstreams;
let profiles: {
  claude: GatewayProfile;
  codex: GatewayProfile;
  compatA: GatewayProfile;
  compatB: GatewayProfile;
};
const endpoints: FakeEndpoint[] = [];
const running: RunningGateway[] = [];
/** Every gateway log line of the current test. */
let lines: string[] = [];

beforeAll(async () => {
  ca = await loadOrCreateCa();
  upstreams = await startFakeUpstreams();
  const files = await writeTokenFiles();
  await mkdir(DATA_DIR, { recursive: true });
  const login = (
    id: string,
    provider: "claude" | "openai-codex",
    tokenFile: string,
  ): GatewayProfile => ({ id, provider, name: id, enabled: true, tokenFile });
  const endpoint = (id: string): GatewayProfile => ({
    id,
    provider: "openai-compatible",
    name: id,
    enabled: true,
  });
  profiles = {
    claude: login("claude-a", "claude", files.claudeFile),
    codex: login("codex-b", "openai-codex", files.codexFile),
    compatA: endpoint("openai-compatible-aaaaaaaaaaaa"),
    compatB: endpoint("openai-compatible-bbbbbbbbbbbb"),
  };
});

afterAll(async () => {
  await upstreams.close();
});

afterEach(async () => {
  // No log line names a pushed key or an endpoint.
  const forbidden = [
    COMPAT_KEY_A,
    COMPAT_KEY_B,
    ...endpoints.map((endpoint) => new URL(endpoint.origin).host),
  ];
  for (const line of lines)
    for (const value of forbidden)
      assert.ok(!line.includes(value), `a log line leaks: ${line}`);
  while (running.length) await running.pop()!.close();
  while (endpoints.length) await endpoints.pop()!.close();
  upstreams.reset();
  lines = [];
});

/** A fake compatible endpoint: plain HTTP on 127.0.0.1, or TLS as `localhost`. */
async function fakeEndpoint(secure = false): Promise<FakeEndpoint> {
  const fake = { seen: [], respond: answerSse } as unknown as FakeEndpoint;
  const handler: http.RequestListener = (req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const seen = {
        method: req.method ?? "",
        url: req.url ?? "",
        headers: req.headers,
        servername: secure
          ? (req.socket as tls.TLSSocket).servername || undefined
          : undefined,
        body: Buffer.concat(chunks),
      };
      fake.seen.push(seen);
      fake.respond(seen, res);
    });
  };
  let server: http.Server;
  if (secure) {
    const leaf = issueLeafCertificate(ca, "localhost");
    server = https.createServer(
      { key: leaf.keyPem, cert: leaf.certPem },
      handler,
    );
  } else server = http.createServer(handler);
  const host = secure ? "localhost" : "127.0.0.1";
  await new Promise<void>((resolve) => server.listen(0, host, resolve));
  const { port } = server.address() as net.AddressInfo;
  fake.origin = `${secure ? "https" : "http"}://${host}:${port}`;
  fake.close = async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  };
  endpoints.push(fake);
  return fake;
}

async function gateway(stateDir?: string): Promise<RunningGateway> {
  const gw = await startGateway({
    log: (line) => lines.push(line),
    compatCa: ca.certPem,
    processProbe: fakeProcesses().probe,
    upstreams: upstreams.overrides,
    ...(stateDir ? { stateDir } : {}),
  });
  running.push(gw);
  return gw;
}

interface Control {
  connection: WorkerConnection;
  send(method: string, request: object): Promise<{ json?: unknown }>;
  set(profileId: string, baseUrl: string, apiKey: string): Promise<void>;
  clear(profileId: string): Promise<void>;
  grant(request: LeaseGrant): Promise<string>;
}

/** A control connection after hello and a sync of every profile. */
async function control(
  gw: RunningGateway,
  bootId = "boot-x",
): Promise<Control> {
  const connection = dialControl(
    createInProcessTransport(),
    gw.attachControl,
    GATEWAY_CONTROL_PROTOCOL,
  );
  const send = (method: string, request: object) =>
    connection.request(
      method,
      encodeControlRequest(
        request as Parameters<typeof encodeControlRequest>[0],
      ),
    );
  await send(CONTROL_METHODS.hello, {
    serverBootId: bootId,
    pid: 4242,
    startTime: "1234",
  });
  await send(CONTROL_METHODS.syncProfiles, {
    profiles: Object.values(profiles),
  });
  return {
    connection,
    send,
    async set(profileId, baseUrl, apiKey) {
      await send(CONTROL_METHODS.compatSet, { profileId, baseUrl, apiKey });
    },
    async clear(profileId) {
      await send(CONTROL_METHODS.compatClear, { profileId });
    },
    async grant(request) {
      return decodeLeaseGranted(await send(CONTROL_METHODS.grant, request))
        .token;
    },
  };
}

const engineLease = (profileId: string): LeaseGrant => ({
  kind: "engine",
  workerId: "w",
  sessionId: "s1",
  profileId,
});

interface Reply {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
}

interface SendOptions {
  method?: string;
  path?: string;
  token?: string;
  headers?: http.OutgoingHttpHeaders;
  /** A chat request's JSON unless named; `null` sends none. */
  body?: string | null;
}

/** A request to the gateway; resolves at the response's end. */
function send(
  gw: RunningGateway,
  {
    method = "POST",
    path = COMPAT_PATH,
    token,
    headers = {},
    body = CHAT_BODY,
  }: SendOptions,
): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const request = http.request({
      host: "127.0.0.1",
      port: gw.port,
      method,
      path,
      agent: false,
      headers: {
        "content-type": "application/json",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...headers,
      },
    });
    let answered = false;
    request.on("response", (response) => {
      answered = true;
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () =>
        resolve({
          status: response.statusCode ?? 0,
          headers: response.headers,
          body: Buffer.concat(chunks),
        }),
      );
      response.on("error", reject);
    });
    // A refused upgrade ends its socket after the answer, which the client
    // reports late; the answer is what counts.
    request.on("error", (err) => {
      if (!answered) reject(err);
    });
    request.end(body ?? undefined);
  });
}

/** The refusal's message, checking the OpenAI shape, status and marker. */
function assertRefused(reply: Reply, status: number, refusal: Refusal): void {
  assert.equal(reply.status, status, reply.body.toString());
  assert.equal(reply.headers["content-type"], "application/json");
  const body = JSON.parse(reply.body.toString("utf8"));
  assert.deepEqual(Object.keys(body), ["error"]);
  assert.deepEqual(Object.keys(body.error).sort(), ["code", "message", "type"]);
  assert.equal(body.error.code, body.error.type);
  assert.equal(body.error.message, refusalText(refusal));
  assert.ok(body.error.message.startsWith("Pandeck gateway: "));
}

/** As {@link assertRefused}, for a route of either provider's error shape. */
function assertRefusedAnyShape(
  reply: Reply,
  status: number,
  refusal: Refusal,
): void {
  assert.equal(reply.status, status, reply.body.toString());
  const body = JSON.parse(reply.body.toString("utf8"));
  assert.equal(body.error.message, refusalText(refusal));
}

const sha256 = (bytes: Buffer | string) =>
  createHash("sha256").update(bytes).digest("hex");

test("2a: a push becomes one frozen target per profile: ports, TLS name, IPv6 and base path", () => {
  const holder = createCompatUpstream();
  const A = profiles.compatA.id;
  const B = profiles.compatB.id;
  assert.equal(holder.current(A), undefined);
  const cases: [string, Record<string, unknown>][] = [
    [
      "http://compat.test/v1/",
      {
        protocol: "http",
        hostname: "compat.test",
        port: 80,
        host: "compat.test",
        servername: "compat.test",
        basePath: "/v1",
      },
    ],
    [
      "https://compat.test/api/openai/v1",
      {
        protocol: "https",
        hostname: "compat.test",
        port: 443,
        host: "compat.test",
        servername: "compat.test",
        basePath: "/api/openai/v1",
      },
    ],
    [
      "https://127.0.0.1:8443",
      {
        protocol: "https",
        hostname: "127.0.0.1",
        port: 8443,
        host: "127.0.0.1:8443",
        servername: undefined,
        basePath: "",
      },
    ],
    [
      "http://[::1]:9/v1",
      {
        protocol: "http",
        hostname: "::1",
        port: 9,
        host: "[::1]:9",
        servername: undefined,
        basePath: "/v1",
      },
    ],
  ];
  for (const [baseUrl, expected] of cases) {
    assert.equal(holder.set(A, baseUrl, COMPAT_KEY_A), true, baseUrl);
    const target = holder.current(A)!;
    assert.deepEqual({ ...target }, { ...expected, apiKey: COMPAT_KEY_A });
    assert.ok(Object.isFrozen(target));
  }
  assert.equal(holder.current(B), undefined, "A's push is A's alone");
  holder.set(B, "http://compat-b.test/v1", COMPAT_KEY_B);
  const held = holder.current(A);
  assert.equal(holder.set(A, "ftp://compat.test/v1", COMPAT_KEY_B), false);
  assert.equal(holder.current(A), undefined);
  assert.equal(held?.apiKey, COMPAT_KEY_A, "a taken target never changes");
  assert.equal(holder.current(B)?.apiKey, COMPAT_KEY_B, "B keeps its pair");

  holder.set(A, "http://compat.test/v1", COMPAT_KEY_A);
  holder.clear(A);
  assert.equal(holder.current(A), undefined);
  assert.equal(holder.current(B)?.apiKey, COMPAT_KEY_B);

  holder.set(A, "http://compat.test/v1", COMPAT_KEY_A);
  holder.retain((id) => id !== B);
  assert.equal(holder.current(B), undefined);
  assert.equal(holder.current(A)?.apiKey, COMPAT_KEY_A);
  holder.set(B, "http://compat-b.test/v1", COMPAT_KEY_B);
  holder.clearAll();
  assert.equal(holder.current(A), undefined);
  assert.equal(holder.current(B), undefined);
});

test("/compat answers 503 in the OpenAI shape until its profile's push and after its clear, contacting nothing", async () => {
  const endpoint = await fakeEndpoint();
  const gw = await gateway();
  const ctl = await control(gw);
  const token = await ctl.grant(engineLease(profiles.compatA.id));
  assertRefused(await send(gw, { token }), 503, { case: "compat-unset" });
  assert.equal(endpoint.seen.length, 0);

  await ctl.set(profiles.compatA.id, `${endpoint.origin}/v1`, COMPAT_KEY_A);
  assert.equal((await send(gw, { token })).status, 200);
  assert.equal(endpoint.seen.length, 1);

  await ctl.clear(profiles.compatA.id);
  assertRefused(await send(gw, { token }), 503, { case: "compat-unset" });
  assert.equal(endpoint.seen.length, 1);
});

test("the pushed key replaces the lease, Host names the endpoint, and body and stream pass unchanged", async () => {
  const endpoint = await fakeEndpoint();
  const gw = await gateway();
  const ctl = await control(gw);
  const A = profiles.compatA.id;
  const token = await ctl.grant(engineLease(A));
  await ctl.set(A, `${endpoint.origin}/v1`, COMPAT_KEY_A);

  const reply = await send(gw, {
    token,
    headers: { "x-api-key": token, "x-client-header": "kept" },
  });
  assert.equal(reply.status, 200);
  assert.equal(reply.body.toString("utf8"), SSE_REPLY);
  assert.equal(reply.headers["set-cookie"], undefined);
  assert.equal(endpoint.seen.length, 1);
  const seen = endpoint.seen[0]!;
  assert.equal(seen.method, "POST");
  assert.equal(seen.url, "/v1/chat/completions");
  assert.equal(seen.headers.authorization, `Bearer ${COMPAT_KEY_A}`);
  assert.equal(seen.headers.host, new URL(endpoint.origin).host);
  assert.equal(seen.headers["x-api-key"], undefined);
  assert.equal(seen.headers["x-client-header"], "kept");
  for (const value of Object.values(seen.headers))
    assert.ok(!String(value).includes(token), "the lease never leaves");
  assert.equal(sha256(seen.body), sha256(CHAT_BODY));

  // A deeper base path, and none (MC2).
  await ctl.set(A, `${endpoint.origin}/api/openai/v1`, COMPAT_KEY_A);
  const deep = await send(gw, {
    token,
    path: "/compat/api/openai/v1/chat/completions",
  });
  assert.equal(deep.status, 200);
  await ctl.set(A, endpoint.origin, COMPAT_KEY_A);
  const bare = await send(gw, { token, path: "/compat/chat/completions" });
  assert.equal(bare.status, 200);
  assert.deepEqual(
    endpoint.seen.slice(1).map((s) => s.url),
    ["/api/openai/v1/chat/completions", "/chat/completions"],
  );
  assert.ok(
    lines.some((line) =>
      /^openai-compatible POST "\/v1\/chat\/completions" lease=\S+ 200 /.test(
        line,
      ),
    ),
    lines.join("\n"),
  );
});

test("only POST <base path>/chat/completions is forwarded; a WebSocket upgrade is refused", async () => {
  const endpoint = await fakeEndpoint();
  const gw = await gateway();
  const ctl = await control(gw);
  const token = await ctl.grant(engineLease(profiles.compatA.id));
  await ctl.set(profiles.compatA.id, `${endpoint.origin}/v1`, COMPAT_KEY_A);
  const refused: SendOptions[] = [
    { method: "GET", path: "/compat/v1/models" },
    { path: "/compat/v1/completions" },
    { path: "/compat/v1/chat/completionsX" },
    { path: "/compat/v1/chat/completions/../x" },
    { path: "/compat/v2/chat/completions" },
    { path: "/compat/chat/completions" },
    { method: "PUT", path: COMPAT_PATH },
  ];
  for (const options of refused)
    assertRefused(await send(gw, { ...options, token }), 403, {
      case: "forbidden",
    });
  const upgrade = await send(gw, {
    method: "GET",
    token,
    body: null,
    headers: {
      connection: "Upgrade",
      upgrade: "websocket",
      "sec-websocket-version": "13",
      "sec-websocket-key": randomBytes(16).toString("base64"),
    },
  });
  assertRefused(upgrade, 403, { case: "websocket" });
  assert.equal(endpoint.seen.length, 0);
});

test("AC5: a lease reaches only its own profile's endpoint and key, engine or server, and never another's", async () => {
  const a = await fakeEndpoint();
  const b = await fakeEndpoint();
  const gw = await gateway();
  const ctl = await control(gw);
  const A = profiles.compatA.id;
  const B = profiles.compatB.id;
  const engineA = await ctl.grant(engineLease(A));
  const serverA = await ctl.grant({ kind: "server", profileId: A });
  const engineB = await ctl.grant(engineLease(B));
  const serverB = await ctl.grant({ kind: "server", profileId: B });

  // Only B's pair is held: A's leases get the 503, and B's endpoint nothing.
  await ctl.set(B, `${b.origin}/v1`, COMPAT_KEY_B);
  for (const token of [engineA, serverA])
    assertRefused(await send(gw, { token }), 503, { case: "compat-unset" });
  assert.equal(b.seen.length, 0);
  assert.equal(a.seen.length, 0);

  await ctl.set(A, `${a.origin}/v1`, COMPAT_KEY_A);
  for (const token of [engineA, serverA, engineB, serverB])
    assert.equal((await send(gw, { token })).status, 200);
  assert.deepEqual(
    a.seen.map((s) => s.headers.authorization),
    [`Bearer ${COMPAT_KEY_A}`, `Bearer ${COMPAT_KEY_A}`],
  );
  assert.deepEqual(
    b.seen.map((s) => s.headers.authorization),
    [`Bearer ${COMPAT_KEY_B}`, `Bearer ${COMPAT_KEY_B}`],
  );
  for (const seen of [...a.seen, ...b.seen])
    for (const token of [engineA, serverA, engineB, serverB])
      assert.ok(!JSON.stringify(seen.headers).includes(token));
});

test("AC6: compatible leases never reach /chatgpt or /anthropic, and login leases never reach /compat", async () => {
  const endpoint = await fakeEndpoint();
  const gw = await gateway();
  const ctl = await control(gw);
  const A = profiles.compatA.id;
  await ctl.set(A, `${endpoint.origin}/v1`, COMPAT_KEY_A);

  // A compatible lease of either kind, on every provider route, the server
  // leases' usage routes included: refused before any credential or upstream.
  const providerRoutes: SendOptions[] = [
    { path: "/anthropic/v1/messages" },
    { method: "GET", path: "/anthropic/api/oauth/usage", body: null },
    { path: "/chatgpt/backend-api/codex/responses" },
    { method: "GET", path: "/chatgpt/backend-api/wham/usage", body: null },
    {
      method: "GET",
      path: "/chatgpt/backend-api/wham/rate-limit-reset-credits",
      body: null,
    },
    {
      path: "/chatgpt/backend-api/wham/rate-limit-reset-credits/consume",
    },
  ];
  for (const token of [
    await ctl.grant(engineLease(A)),
    await ctl.grant({ kind: "server", profileId: A }),
  ])
    for (const options of providerRoutes)
      assertRefusedAnyShape(await send(gw, { ...options, token }), 403, {
        case: "forbidden",
      });
  assert.equal(upstreams.anthropic.length, 0);
  assert.equal(upstreams.chatgpt.length, 0);

  // A Codex or Claude lease of either kind, on `/compat`, never.
  for (const profileId of [profiles.codex.id, profiles.claude.id])
    for (const token of [
      await ctl.grant(engineLease(profileId)),
      await ctl.grant({ kind: "server", profileId }),
    ])
      assertRefused(await send(gw, { token }), 403, { case: "forbidden" });
  assert.equal(endpoint.seen.length, 0, "no refusal reached the endpoint");

  // Unknown and revoked leases keep their 401s.
  assertRefused(await send(gw, {}), 401, { case: "unknown-lease" });
  const revoked = await ctl.grant(engineLease(A));
  const revokedId = gw.leases.records().at(-1)!.leaseId;
  await ctl.connection.request(
    CONTROL_METHODS.revoke,
    encodeControlRequest({ leaseId: revokedId, reason: "session-ended" }),
  );
  assertRefused(await send(gw, { token: revoked }), 401, {
    case: "revoked-lease",
    reason: "session-ended",
  });
  assert.equal(endpoint.seen.length, 0);
  assert.equal(upstreams.anthropic.length + upstreams.chatgpt.length, 0);
});

test("an https push uses TLS with the endpoint's name; an http push never does", async () => {
  const endpoint = await fakeEndpoint(true);
  const gw = await gateway();
  const ctl = await control(gw);
  const A = profiles.compatA.id;
  const token = await ctl.grant(engineLease(A));
  await ctl.set(A, `${endpoint.origin}/v1`, COMPAT_KEY_A);
  const reply = await send(gw, { token });
  assert.equal(reply.status, 200, reply.body.toString());
  const seen = endpoint.seen[0]!;
  assert.equal(seen.servername, "localhost");
  assert.equal(seen.headers.host, new URL(endpoint.origin).host);
  assert.equal(seen.headers.authorization, `Bearer ${COMPAT_KEY_A}`);

  // The same TLS endpoint pushed as http: plain bytes, which it refuses.
  await ctl.set(
    A,
    `${endpoint.origin.replace("https:", "http:")}/v1`,
    COMPAT_KEY_A,
  );
  const plain = await send(gw, { token });
  assert.notEqual(plain.status, 200);
  assert.equal(endpoint.seen.length, 1);
});

test("AC5: a request keeps its endpoint and key across a push; the next goes to the new pair", async () => {
  const a = await fakeEndpoint();
  const b = await fakeEndpoint();
  let release!: () => void;
  const released = new Promise<void>((resolve) => (release = resolve));
  let arrived!: () => void;
  const atA = new Promise<void>((resolve) => (arrived = resolve));
  a.respond = (seen, res) => {
    arrived();
    void released.then(() => answerSse(seen, res));
  };
  const gw = await gateway();
  const ctl = await control(gw);
  const A = profiles.compatA.id;
  const token = await ctl.grant(engineLease(A));
  await ctl.set(A, `${a.origin}/v1`, COMPAT_KEY_A);
  const first = send(gw, { token });
  await atA;
  await ctl.set(A, `${b.origin}/v1`, COMPAT_KEY_B);
  release();
  assert.equal((await first).status, 200);
  assert.deepEqual(
    a.seen.map((s) => s.headers.authorization),
    [`Bearer ${COMPAT_KEY_A}`],
  );
  assert.equal(b.seen.length, 0);

  a.respond = answerSse;
  assert.equal((await send(gw, { token })).status, 200);
  assert.equal(a.seen.length, 1, "A records nothing more");
  assert.deepEqual(
    b.seen.map((s) => s.headers.authorization),
    [`Bearer ${COMPAT_KEY_B}`],
  );
});

test("AC4: a new connection's hello clears every pair; a connection that ends without one keeps them", async () => {
  const a = await fakeEndpoint();
  const b = await fakeEndpoint();
  const gw = await gateway();
  const first = await control(gw);
  const A = profiles.compatA.id;
  const B = profiles.compatB.id;
  const tokenA = await first.grant(engineLease(A));
  const tokenB = await first.grant(engineLease(B));
  await first.set(A, `${a.origin}/v1`, COMPAT_KEY_A);
  await first.set(B, `${b.origin}/v1`, COMPAT_KEY_B);
  first.connection.end("the server went away");
  await first.connection.ended;
  assert.equal((await send(gw, { token: tokenA })).status, 200);
  assert.equal((await send(gw, { token: tokenB })).status, 200);

  const second = await control(gw, "boot-y");
  for (const token of [tokenA, tokenB])
    assertRefused(await send(gw, { token }), 503, { case: "compat-unset" });
  await second.set(A, `${a.origin}/v1`, COMPAT_KEY_A);
  assert.equal((await send(gw, { token: tokenA })).status, 200);
  assertRefused(await send(gw, { token: tokenB }), 503, {
    case: "compat-unset",
  });
  assert.equal(a.seen.length, 2);
  assert.equal(b.seen.length, 1);
});

/** Rejects unless `answer` fails with `state_write_failed`. */
const failsToWrite = (answer: Promise<unknown>) =>
  assert.rejects(
    answer,
    (err) =>
      err instanceof WorkerRequestError && err.code === "state_write_failed",
  );

const REMOVALS = [
  {
    name: "profiles.remove",
    method: CONTROL_METHODS.removeProfile,
    params: () => ({ profileId: profiles.compatA.id }),
  },
  {
    name: "a sync that omits it",
    method: CONTROL_METHODS.syncProfiles,
    params: () => ({
      profiles: Object.values(profiles).filter(
        (profile) => profile.id !== profiles.compatA.id,
      ),
    }),
  },
];

const SAVES = [
  { name: "saves", blocked: undefined },
  { name: "profiles.json cannot be saved", blocked: "profiles.json.tmp" },
  { name: "leases.json cannot be saved", blocked: "leases.json.tmp" },
];

for (const removal of REMOVALS)
  for (const save of SAVES)
    test(`AC4: removing A by ${removal.name} drops its pair and revokes its leases while B forwards (${save.name})`, async () => {
      const a = await fakeEndpoint();
      const b = await fakeEndpoint();
      const stateDir = join(
        await mkdtemp(join(DATA_DIR, "compat-removal-")),
        "gw",
      );
      const gw = await gateway(stateDir);
      const ctl = await control(gw);
      const A = profiles.compatA.id;
      const B = profiles.compatB.id;
      const tokenA = await ctl.grant(engineLease(A));
      const tokenB = await ctl.grant({ kind: "server", profileId: B });
      await ctl.set(A, `${a.origin}/v1`, COMPAT_KEY_A);
      await ctl.set(B, `${b.origin}/v1`, COMPAT_KEY_B);
      assert.equal((await send(gw, { token: tokenA })).status, 200);

      const blocker = save.blocked && join(stateDir, save.blocked);
      if (blocker) await mkdir(blocker);
      const answer = ctl.send(removal.method, removal.params());
      if (blocker) await failsToWrite(answer);
      else await answer;
      if (blocker) await rmdir(blocker);

      assertRefused(await send(gw, { token: tokenA }), 401, {
        case: "revoked-lease",
        reason: "profile-removed",
      });
      assert.equal((await send(gw, { token: tokenB })).status, 200);

      // Back by upsert, with a fresh lease and no push: nothing to spend.
      decodeLeasesRevoked(
        await ctl.send(CONTROL_METHODS.upsertProfile, {
          profile: profiles.compatA,
        }),
      );
      const fresh = await ctl.grant(engineLease(A));
      assertRefused(await send(gw, { token: fresh }), 503, {
        case: "compat-unset",
      });
      assert.equal(a.seen.length, 1, "endpoint A saw only the first request");
      assert.equal(b.seen.length, 1);

      for (const file of await filesUnder(stateDir)) {
        const text = await readFile(file, "latin1");
        for (const secret of [
          COMPAT_KEY_A,
          COMPAT_KEY_B,
          new URL(a.origin).host,
          new URL(b.origin).host,
        ])
          assert.ok(!text.includes(secret), `${file} holds ${secret}`);
      }
    });

/** Every file under `root`, recursively. */
async function filesUnder(root: string): Promise<string[]> {
  const entries = await readdir(root, { recursive: true, withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name));
}

test("a restarted gateway on the same state answers 503 until a push; no file or log line holds a key or endpoint", async () => {
  const a = await fakeEndpoint();
  const b = await fakeEndpoint();
  const stateDir = join(await mkdtemp(join(DATA_DIR, "compat-state-")), "gw");
  const gw = await gateway(stateDir);
  const ctl = await control(gw);
  const A = profiles.compatA.id;
  const B = profiles.compatB.id;
  const token = await ctl.grant(engineLease(A));
  await ctl.set(A, `${a.origin}/v1`, COMPAT_KEY_A);
  assert.equal((await send(gw, { token })).status, 200);
  await ctl.set(B, `${b.origin}/api/openai/v1`, COMPAT_KEY_B);
  const files = (await readdir(stateDir)).sort();
  assert.ok(
    files.every((name) =>
      ["holds.json", "leases.json", "profiles.json"].includes(name),
    ),
    files.join(", "),
  );

  await running.pop()!.close();
  const restarted = await gateway(stateDir);
  // The lease and the tokenless profile survived the restart; the push did not.
  assertRefused(await send(restarted, { token }), 503, {
    case: "compat-unset",
  });
  const again = await control(restarted, "boot-y");
  await again.set(A, `${a.origin}/v1`, COMPAT_KEY_A);
  assert.equal((await send(restarted, { token })).status, 200);
  assert.deepEqual((await readdir(stateDir)).sort(), files);

  const secrets = [
    COMPAT_KEY_A,
    COMPAT_KEY_B,
    new URL(a.origin).host,
    new URL(b.origin).host,
  ];
  for (const file of await filesUnder(DATA_DIR)) {
    const text = await readFile(file, "latin1");
    for (const secret of secrets)
      assert.ok(!text.includes(secret), `${file} holds ${secret}`);
  }
});

test("AC12: no refusal text reads as a dead login or carries a retryable status number", () => {
  const refusals: Refusal[] = [
    { case: "unknown-lease" },
    { case: "revoked-lease", reason: "profile-removed" },
    { case: "revoked-lease", reason: "account-switch" },
    { case: "revoked-lease", reason: "session-ended" },
    { case: "forbidden" },
    { case: "unknown-prefix" },
    { case: "websocket" },
    { case: "credential", problem: "missing" },
    { case: "needs-login", name: "Work ChatGPT" },
    { case: "compat-unset" },
    {
      case: "unreachable",
      upstream: "the OpenAI-compatible endpoint",
      reason: "ECONNREFUSED",
    },
    { case: "unreachable", upstream: "ChatGPT", reason: "connection failed" },
  ];
  for (const refusal of refusals) {
    const text = refusalText(refusal);
    assert.doesNotMatch(text, /\b(?:429|500|502|503|504|520|524)\b/, text);
  }
  assert.equal(
    refusalText({ case: "compat-unset" }),
    "Pandeck gateway: the OpenAI-compatible endpoint's settings have not reached the gateway yet. Try again shortly.",
  );
  const unreachable = refusalText({
    case: "unreachable",
    upstream: "the OpenAI-compatible endpoint",
    reason: "ECONNREFUSED",
  });
  assert.equal(
    unreachable,
    "Pandeck gateway: the OpenAI-compatible endpoint could not be reached: ECONNREFUSED.",
  );
  const unset = refusalText({ case: "compat-unset" });
  for (const message of [
    unset,
    unreachable,
    `503: ${JSON.stringify({ error: { type: "api_error", code: "api_error", message: unset } })}`,
    `502: ${JSON.stringify({ error: { type: "api_error", code: "api_error", message: unreachable } })}`,
  ])
    assert.equal(
      isLoginDeath(message, { provider: "openai-compatible" }),
      false,
      message,
    );
});

test("an unreachable compatible endpoint is a marked 502", async () => {
  const endpoint = await fakeEndpoint();
  const origin = endpoint.origin;
  await endpoints.pop()!.close();
  const gw = await gateway();
  const ctl = await control(gw);
  const A = profiles.compatA.id;
  const token = await ctl.grant(engineLease(A));
  await ctl.set(A, `${origin}/v1`, COMPAT_KEY_A);
  assertRefused(await send(gw, { token }), 502, {
    case: "unreachable",
    upstream: "the OpenAI-compatible endpoint",
    reason: "ECONNREFUSED",
  });
});
