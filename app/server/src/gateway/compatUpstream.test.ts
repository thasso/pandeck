/**
 * The gateway's `/compat` upstream (`compatUpstream.ts`, `forward.ts`): the
 * OpenAI-compatible endpoint and key the server pushes over control, held in
 * memory only, forwarded over plain HTTP or TLS as the push says, to exactly
 * `POST <base path>/chat/completions`, for an engine lease of a pi profile
 * alone. Fake endpoints on loopback; every key and token is fake.
 */
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile } from "node:fs/promises";
import http from "node:http";
import https from "node:https";
import type net from "node:net";
import { join } from "node:path";
import type tls from "node:tls";
import { afterEach, beforeAll, test } from "vitest";
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
  writeTokenFiles,
} from "../test/gatewayFixtures.ts";
import type { WorkerConnection } from "../workerProtocol/connection.ts";
import { createInProcessTransport } from "../workerProtocol/inProcessTransport.ts";
import { createCompatUpstream } from "./compatUpstream.ts";
import {
  CONTROL_METHODS,
  GATEWAY_CONTROL_PROTOCOL,
  decodeLeaseGranted,
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
let profiles: {
  claude: GatewayProfile;
  codex: GatewayProfile;
  codexNoLogin: GatewayProfile;
};
const endpoints: FakeEndpoint[] = [];
const running: RunningGateway[] = [];
/** Every gateway log line of the current test. */
let lines: string[] = [];

beforeAll(async () => {
  ca = await loadOrCreateCa();
  const files = await writeTokenFiles();
  await mkdir(DATA_DIR, { recursive: true });
  const missing = join(
    await mkdtemp(join(DATA_DIR, "compat-no-login-")),
    "auth.json",
  );
  const profile = (
    id: string,
    provider: GatewayProfile["provider"],
    tokenFile: string,
  ): GatewayProfile => ({ id, provider, name: id, enabled: true, tokenFile });
  profiles = {
    claude: profile("claude-a", "claude", files.claudeFile),
    codex: profile("codex-b", "openai-codex", files.codexFile),
    codexNoLogin: profile("codex-none", "openai-codex", missing),
  };
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
    ...(stateDir ? { stateDir } : {}),
  });
  running.push(gw);
  return gw;
}

interface Control {
  connection: WorkerConnection;
  set(baseUrl: string, apiKey: string): Promise<void>;
  clear(): Promise<void>;
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
    async set(baseUrl, apiKey) {
      await send(CONTROL_METHODS.compatSet, { baseUrl, apiKey });
    },
    async clear() {
      await send(CONTROL_METHODS.compatClear, {});
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

const sha256 = (bytes: Buffer | string) =>
  createHash("sha256").update(bytes).digest("hex");

test("2a: a push becomes one frozen target: ports, TLS name, IPv6 and base path", () => {
  const holder = createCompatUpstream();
  assert.equal(holder.current(), undefined);
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
    assert.equal(holder.set(baseUrl, COMPAT_KEY_A), true, baseUrl);
    const target = holder.current()!;
    assert.deepEqual({ ...target }, { ...expected, apiKey: COMPAT_KEY_A });
    assert.ok(Object.isFrozen(target));
  }
  const held = holder.current();
  assert.equal(holder.set("ftp://compat.test/v1", COMPAT_KEY_B), false);
  assert.equal(holder.current(), undefined);
  assert.equal(held?.apiKey, COMPAT_KEY_A, "a taken target never changes");
  holder.set("http://compat.test/v1", COMPAT_KEY_A);
  holder.clear();
  assert.equal(holder.current(), undefined);
});

test("AC4: /compat answers 503 in the OpenAI shape until a push and after a clear, contacting nothing", async () => {
  const endpoint = await fakeEndpoint();
  const gw = await gateway();
  const ctl = await control(gw);
  const token = await ctl.grant(engineLease(profiles.codex.id));
  assertRefused(await send(gw, { token }), 503, { case: "compat-unset" });
  assert.equal(endpoint.seen.length, 0);

  await ctl.set(`${endpoint.origin}/v1`, COMPAT_KEY_A);
  assert.equal((await send(gw, { token })).status, 200);
  assert.equal(endpoint.seen.length, 1);

  await ctl.clear();
  assertRefused(await send(gw, { token }), 503, { case: "compat-unset" });
  assert.equal(endpoint.seen.length, 1);
});

test("AC5: the pushed key replaces the lease, Host names the endpoint, and body and stream pass unchanged", async () => {
  const endpoint = await fakeEndpoint();
  const gw = await gateway();
  const ctl = await control(gw);
  const token = await ctl.grant(engineLease(profiles.codex.id));
  await ctl.set(`${endpoint.origin}/v1`, COMPAT_KEY_A);

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
  await ctl.set(`${endpoint.origin}/api/openai/v1`, COMPAT_KEY_A);
  const deep = await send(gw, {
    token,
    path: "/compat/api/openai/v1/chat/completions",
  });
  assert.equal(deep.status, 200);
  await ctl.set(endpoint.origin, COMPAT_KEY_A);
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

test("AC6: only POST <base path>/chat/completions is forwarded; a WebSocket upgrade is refused", async () => {
  const endpoint = await fakeEndpoint();
  const gw = await gateway();
  const ctl = await control(gw);
  const token = await ctl.grant(engineLease(profiles.codex.id));
  await ctl.set(`${endpoint.origin}/v1`, COMPAT_KEY_A);
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

test("AC7: only an engine or server lease of an openai-codex profile spends the key, a Codex login or not", async () => {
  const endpoint = await fakeEndpoint();
  const gw = await gateway();
  const ctl = await control(gw);
  await ctl.set(`${endpoint.origin}/v1`, COMPAT_KEY_A);

  assertRefused(await send(gw, {}), 401, { case: "unknown-lease" });
  const revoked = await ctl.grant(engineLease(profiles.codex.id));
  const revokedId = gw.leases.records().at(-1)!.leaseId;
  await ctl.connection.request(
    CONTROL_METHODS.revoke,
    encodeControlRequest({ leaseId: revokedId, reason: "session-ended" }),
  );
  assertRefused(await send(gw, { token: revoked }), 401, {
    case: "revoked-lease",
    reason: "session-ended",
  });
  // A Claude lease of either kind, never (RD-G3b2-1).
  const claude = await ctl.grant(engineLease(profiles.claude.id));
  assertRefused(await send(gw, { token: claude }), 403, { case: "forbidden" });
  const claudeServer = await ctl.grant({
    kind: "server",
    profileId: profiles.claude.id,
  });
  assertRefused(await send(gw, { token: claudeServer }), 403, {
    case: "forbidden",
  });
  assert.equal(endpoint.seen.length, 0, "no refusal reached the endpoint");

  // The server's one-shots spend the key as an engine does (G4).
  const server = await ctl.grant({
    kind: "server",
    profileId: profiles.codex.id,
  });
  assert.equal((await send(gw, { token: server })).status, 200);
  // No readCredential: a pi profile without a Codex login still works.
  const noLogin = await ctl.grant(engineLease(profiles.codexNoLogin.id));
  assert.equal((await send(gw, { token: noLogin })).status, 200);
  const noLoginServer = await ctl.grant({
    kind: "server",
    profileId: profiles.codexNoLogin.id,
  });
  assert.equal((await send(gw, { token: noLoginServer })).status, 200);
  assert.deepEqual(
    endpoint.seen.map((s) => s.headers.authorization),
    [
      `Bearer ${COMPAT_KEY_A}`,
      `Bearer ${COMPAT_KEY_A}`,
      `Bearer ${COMPAT_KEY_A}`,
    ],
  );
});

test("AC8: an https push uses TLS with the endpoint's name; an http push never does", async () => {
  const endpoint = await fakeEndpoint(true);
  const gw = await gateway();
  const ctl = await control(gw);
  const token = await ctl.grant(engineLease(profiles.codex.id));
  await ctl.set(`${endpoint.origin}/v1`, COMPAT_KEY_A);
  const reply = await send(gw, { token });
  assert.equal(reply.status, 200, reply.body.toString());
  const seen = endpoint.seen[0]!;
  assert.equal(seen.servername, "localhost");
  assert.equal(seen.headers.host, new URL(endpoint.origin).host);
  assert.equal(seen.headers.authorization, `Bearer ${COMPAT_KEY_A}`);

  // The same TLS endpoint pushed as http: plain bytes, which it refuses.
  await ctl.set(
    `${endpoint.origin.replace("https:", "http:")}/v1`,
    COMPAT_KEY_A,
  );
  const plain = await send(gw, { token });
  assert.notEqual(plain.status, 200);
  assert.equal(endpoint.seen.length, 1);
});

test("AC9: a request keeps its endpoint and key across a push; the next goes to the new pair", async () => {
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
  const token = await ctl.grant(engineLease(profiles.codex.id));
  await ctl.set(`${a.origin}/v1`, COMPAT_KEY_A);
  const first = send(gw, { token });
  await atA;
  await ctl.set(`${b.origin}/v1`, COMPAT_KEY_B);
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

test("AC10: a new connection's hello clears the push; a connection that ends without one keeps it", async () => {
  const endpoint = await fakeEndpoint();
  const gw = await gateway();
  const first = await control(gw);
  const token = await first.grant(engineLease(profiles.codex.id));
  await first.set(`${endpoint.origin}/v1`, COMPAT_KEY_A);
  first.connection.end("the server went away");
  await first.connection.ended;
  assert.equal((await send(gw, { token })).status, 200);

  const second = await control(gw, "boot-y");
  assertRefused(await send(gw, { token }), 503, { case: "compat-unset" });
  await second.set(`${endpoint.origin}/v1`, COMPAT_KEY_B);
  assert.equal((await send(gw, { token })).status, 200);
  assert.deepEqual(
    endpoint.seen.map((s) => s.headers.authorization),
    [`Bearer ${COMPAT_KEY_A}`, `Bearer ${COMPAT_KEY_B}`],
  );
});

/** Every file under `root`, recursively. */
async function filesUnder(root: string): Promise<string[]> {
  const entries = await readdir(root, { recursive: true, withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name));
}

test("AC11: a restarted gateway on the same state answers 503 until a push; no file or log line holds a key or endpoint", async () => {
  const a = await fakeEndpoint();
  const b = await fakeEndpoint();
  const stateDir = join(await mkdtemp(join(DATA_DIR, "compat-state-")), "gw");
  const gw = await gateway(stateDir);
  const ctl = await control(gw);
  const token = await ctl.grant(engineLease(profiles.codex.id));
  await ctl.set(`${a.origin}/v1`, COMPAT_KEY_A);
  assert.equal((await send(gw, { token })).status, 200);
  await ctl.set(`${b.origin}/api/openai/v1`, COMPAT_KEY_B);
  const files = (await readdir(stateDir)).sort();
  assert.ok(
    files.every((name) =>
      ["holds.json", "leases.json", "profiles.json"].includes(name),
    ),
    files.join(", "),
  );

  await running.pop()!.close();
  const restarted = await gateway(stateDir);
  // The lease survived the restart; the push did not.
  assertRefused(await send(restarted, { token }), 503, {
    case: "compat-unset",
  });
  const again = await control(restarted, "boot-y");
  await again.set(`${a.origin}/v1`, COMPAT_KEY_A);
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
  const token = await ctl.grant(engineLease(profiles.codex.id));
  await ctl.set(`${origin}/v1`, COMPAT_KEY_A);
  assertRefused(await send(gw, { token }), 502, {
    case: "unreachable",
    upstream: "the OpenAI-compatible endpoint",
    reason: "ECONNREFUSED",
  });
});
