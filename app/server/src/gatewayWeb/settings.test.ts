/**
 * The gateway page's Atlassian credential, clients and MCP tokens (Task-1405):
 * the routes over fake `GatewayWebIntegrations` and `GatewayWebClients` (the
 * session gate, the mutation rule, the body limits, the refusals, the socket
 * idle bounds and secret leaks), then `startEdge` with fake tools over the
 * edge's real user-scoped operations with two users.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type http from "node:http";
import https from "node:https";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import tls from "node:tls";
import { afterAll, afterEach, beforeAll, test, vi } from "vitest";
import { DATA_DIR } from "../config.ts";
import { mcpTokenMatches } from "../gateway/clientRegistry.ts";
import type { EdgeTools, IntegrationCheck } from "../gateway/edgeTools.ts";
import { edgeTlsFor } from "../gateway/x509.ts";
import { startEdge, type RunningEdge } from "../gatewayEdge.ts";
import {
  CLIENT_ID,
  CLIENT_PW,
  EMAIL,
  PUBLIC_ORIGIN,
  startFakeIssuer,
  type FakeIssuer,
} from "../test/gatewayUiIssuer.ts";
import type { GatewayWebAccounts } from "./accounts.ts";
import { ClientsRefusal, type GatewayWebClients } from "./clients.ts";
import {
  IntegrationsRefusal,
  type GatewayWebIntegrations,
  type IntegrationsRefusalCode,
} from "./integrations.ts";
import { startGatewayWeb } from "./server.ts";

const EDGE_ISSUER = "https://issuer.test";
const MARKER = "MARKER-atlassian-api-token-fake";

const edgeTls = edgeTlsFor(["localhost", "127.0.0.1"], undefined);
const agent = new https.Agent({ ca: edgeTls.caCertPem, keepAlive: true });
let issuer: FakeIssuer;
let distDir: string;
const logs: string[] = [];
/** Every answer, for the leak checks. */
const answers: Answer[] = [];
const open: { close(): Promise<void> | void }[] = [];

interface Answer {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}

function request(
  port: number,
  path: string,
  options: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    agent?: https.Agent;
    onSocket?: (socket: net.Socket) => void;
  } = {},
): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        host: "127.0.0.1",
        port,
        path,
        method: options.method ?? "GET",
        headers: {
          ...options.headers,
          ...(options.body === undefined
            ? {}
            : { "content-length": String(Buffer.byteLength(options.body)) }),
        },
        agent: options.agent ?? agent,
      },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => (body += chunk));
        res.on("end", () => {
          const answer = {
            status: res.statusCode ?? 0,
            headers: res.headers,
            body,
          };
          answers.push(answer);
          resolve(answer);
        });
      },
    );
    if (options.onSocket) req.once("socket", options.onSocket);
    req.on("error", reject);
    req.end(options.body);
  });
}

function cookieValue(answer: Answer, name: string): string | undefined {
  for (const line of answer.headers["set-cookie"] ?? [])
    if (line.startsWith(`${name}=`))
      return line.slice(name.length + 1).split(";")[0];
  return undefined;
}

/** A full sign-in through the issuer; answers the session cookie header. */
async function signIn(
  port: number,
  by: FakeIssuer = issuer,
  sub = "subject-1",
): Promise<string> {
  const login = await request(port, "/auth/login");
  assert.equal(login.status, 302);
  const provider = new URL(login.headers.location!);
  const signin = cookieValue(login, "__Host-pgw_signin")!;
  const code = by.authorize(provider, {
    claims: (claims) => ({ ...claims, sub }),
  });
  const answer = await request(
    port,
    `/auth/callback?code=${encodeURIComponent(code)}&state=${encodeURIComponent(provider.searchParams.get("state")!)}`,
    { headers: { cookie: `__Host-pgw_signin=${signin}` } },
  );
  const session = cookieValue(answer, "__Host-pgw_session");
  assert.ok(session, "signed in");
  return `__Host-pgw_session=${session}`;
}

const MUTATION = { origin: PUBLIC_ORIGIN, "x-gateway-ui": "1" };

function api(
  port: number,
  cookie: string | undefined,
  method: "GET" | "POST",
  path: string,
  body?: unknown,
  extra: { agent?: https.Agent; onSocket?: (socket: net.Socket) => void } = {},
): Promise<Answer> {
  return request(port, path, {
    method,
    headers: {
      ...(cookie ? { cookie } : {}),
      ...(method === "POST"
        ? { ...MUTATION, "content-type": "application/json" }
        : {}),
    },
    ...(body === undefined
      ? {}
      : { body: typeof body === "string" ? body : JSON.stringify(body) }),
    ...extra,
  });
}

const json = (answer: Answer): Record<string, unknown> =>
  JSON.parse(answer.body) as Record<string, unknown>;

/** These tests touch no account. */
const NO_ACCOUNTS: GatewayWebAccounts = {
  list: () => [],
  remove: () => {},
  start: () => ({ loginId: "l", accountId: "a" }),
  input: () => {},
  cancel: () => {},
  read: () => ({ kind: "claude", state: "running", output: "", cursor: 0 }),
  endActor: () => {},
};

/** Fake adapters: record each call with the session's user. */
function fakeSettings() {
  const calls: { op: string; userId: string; args: unknown[] }[] = [];
  let failWith: Error | undefined;
  let setDelayMs = 0;
  const record = (op: string, userId: string, ...args: unknown[]) => {
    calls.push({ op, userId, args });
    if (failWith) throw failWith;
  };
  const integrations: GatewayWebIntegrations = {
    status: async (userId) => {
      record("status", userId);
      return { connected: true, site: "x.atlassian.net", email: EMAIL };
    },
    set: async (userId, input) => {
      if (setDelayMs)
        await new Promise((resolve) => setTimeout(resolve, setDelayMs));
      record("set", userId, input);
      return { connected: true, site: input.site, email: input.email };
    },
    clear: async (userId) => record("clear", userId),
  };
  const clients: GatewayWebClients = {
    list: (userId) => {
      record("list", userId);
      return [{ id: "c1", label: "laptop", createdAt: 1, mcpToken: false }];
    },
    createCode: (userId, label) => {
      record("createCode", userId, label);
      return { code: "FAKE-CODE", validForSeconds: 900 };
    },
    revoke: (userId, clientId) => record("revoke", userId, clientId),
    mintMcpToken: (userId, clientId) => {
      record("mintMcpToken", userId, clientId);
      return { token: "FAKE-MCP" };
    },
    revokeMcpToken: (userId, clientId) =>
      record("revokeMcpToken", userId, clientId),
  };
  return {
    integrations,
    clients,
    calls,
    fail: (err: Error | undefined) => (failWith = err),
    delaySet: (ms: number) => (setDelayMs = ms),
  };
}

async function startUi(
  fake = fakeSettings(),
  testIdleMs?: { idle: number; integration: number },
) {
  const web = await startGatewayWeb({
    config: {
      port: 0,
      publicOrigin: PUBLIC_ORIGIN,
      certPem: edgeTls.serverCertPem,
      keyPem: edgeTls.serverKeyPem,
      distDir,
      oidc: {
        issuer: issuer.url,
        clientId: CLIENT_ID,
        clientSecret: CLIENT_PW,
      },
      allow: { emailDomains: ["example.org"], emails: [], claims: {} },
    },
    users: {
      signIn: () => ({ userId: "u1", outcome: "existing" }),
      user: (id) => ({ id, label: EMAIL, email: EMAIL }),
    },
    accounts: NO_ACCOUNTS,
    integrations: fake.integrations,
    clients: fake.clients,
    log: (line) => logs.push(line),
    oidcTestOptions: { allowInsecureRequests: true },
    ...(testIdleMs ? { testIdleMs } : {}),
  });
  open.push(web);
  return { port: web.port, fake };
}

beforeAll(async () => {
  issuer = await startFakeIssuer({ now: () => Date.now() });
  distDir = mkdtempSync(join(tmpdir(), "gateway-dist-"));
  writeFileSync(
    join(distDir, "gateway.html"),
    "<!doctype html><title>g</title>",
  );
});

afterEach(async () => {
  vi.restoreAllMocks();
  while (open.length) await open.pop()!.close();
});

afterAll(async () => {
  agent.destroy();
  await issuer.close();
  rmSync(distDir, { recursive: true, force: true });
  for (const answer of answers)
    assert.ok(
      !answer.body.includes(MARKER) &&
        !JSON.stringify(answer.headers).includes(MARKER),
      `an answer leaked: ${answer.body}`,
    );
  for (const line of logs)
    assert.ok(!line.includes(MARKER), `a log line leaked: ${line}`);
});

// --- the routes -------------------------------------------------------------

const SET_BODY = { site: "x.atlassian.net", email: EMAIL, token: MARKER };

const ROUTES: ["GET" | "POST", string, unknown?][] = [
  ["GET", "/api/integrations/atlassian"],
  ["POST", "/api/integrations/atlassian/set", SET_BODY],
  ["POST", "/api/integrations/atlassian/clear", {}],
  ["GET", "/api/clients"],
  ["POST", "/api/clients/code", { label: "laptop" }],
  ["POST", "/api/clients/revoke", { clientId: "c1" }],
  ["POST", "/api/clients/mcp-token", { clientId: "c1" }],
  ["POST", "/api/clients/mcp-token/revoke", { clientId: "c1" }],
];

test("T4 every new route answers 401 signed_out without a session, and its POSTs need Origin and the header", async () => {
  const { port, fake } = await startUi();
  for (const [method, path, body] of ROUTES) {
    const answer = await api(port, undefined, method, path, body);
    assert.equal(answer.status, 401, path);
    assert.deepEqual(json(answer), { error: "signed_out" });
    assert.equal(answer.headers["cache-control"], "no-store");
  }
  const cookie = await signIn(port);
  for (const [method, path, body] of ROUTES) {
    if (method !== "POST") continue;
    for (const headers of [
      { cookie, "x-gateway-ui": "1" },
      { cookie, origin: PUBLIC_ORIGIN },
      { cookie, origin: "https://elsewhere.test", "x-gateway-ui": "1" },
    ]) {
      const answer = await request(port, path, {
        method,
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      assert.equal(answer.status, 403, path);
      assert.deepEqual(json(answer), { error: "forbidden" });
    }
  }
  assert.deepEqual(fake.calls, []);
});

/** A JSON body of exactly `bytes` bytes: `value` with a padding field. */
function padded(value: object, bytes: number): string {
  const base = JSON.stringify({ ...value, pad: "" });
  return JSON.stringify({ ...value, pad: "x".repeat(bytes - base.length) });
}

test("T4 body limits: 4 KiB on the set route, 1 KiB on every other new POST, chosen before reading", async () => {
  const { port, fake } = await startUi();
  const cookie = await signIn(port);
  const set = "/api/integrations/atlassian/set";
  const fits = await api(port, cookie, "POST", set, padded(SET_BODY, 4_096));
  assert.equal(fits.status, 200);
  assert.equal(fake.calls.at(-1)!.op, "set");
  assert.equal(
    (await api(port, cookie, "POST", set, padded(SET_BODY, 4_097))).status,
    413,
  );
  for (const [method, path, body] of ROUTES) {
    if (method !== "POST" || path === set) continue;
    const before = fake.calls.length;
    const fitting = await api(
      port,
      cookie,
      "POST",
      path,
      padded(body as object, 1_024),
    );
    assert.notEqual(fitting.status, 413, path);
    const over = await api(
      port,
      cookie,
      "POST",
      path,
      padded(body as object, 1_025),
    );
    assert.equal(over.status, 413, path);
    assert.equal(fake.calls.length, before + 1, path);
  }
});

test("T4 the user comes from the session: a body userId is ignored; answers are no-store", async () => {
  const { port, fake } = await startUi();
  const cookie = await signIn(port);
  for (const [method, path, body] of ROUTES) {
    const answer = await api(
      port,
      cookie,
      method,
      path,
      method === "POST" ? { ...(body as object), userId: "u2" } : undefined,
    );
    assert.ok(answer.status === 200 || answer.status === 204, path);
    assert.equal(answer.headers["cache-control"], "no-store", path);
    assert.equal(answer.headers["x-content-type-options"], "nosniff", path);
  }
  assert.equal(fake.calls.length, ROUTES.length);
  for (const call of fake.calls) assert.equal(call.userId, "u1", call.op);
  // The set reached the adapter with only the three fields.
  assert.deepEqual(fake.calls.find((call) => call.op === "set")!.args, [
    SET_BODY,
  ]);
  assert.deepEqual(fake.calls.find((call) => call.op === "createCode")!.args, [
    "laptop",
  ]);
  for (const line of logs) assert.ok(!line.includes("laptop"), line);
});

test("T4 malformed requests answer bad_request before the adapter", async () => {
  const { port, fake } = await startUi();
  const cookie = await signIn(port);
  const malformed: [string, unknown][] = [
    ["/api/integrations/atlassian/set", { site: "x", email: "e" }],
    ["/api/integrations/atlassian/set", { ...SET_BODY, token: 5 }],
    ["/api/integrations/atlassian/set", "not json"],
    [
      "/api/integrations/atlassian/set",
      { ...SET_BODY, token: "t".repeat(601) },
    ],
    ["/api/clients/code", {}],
    ["/api/clients/code", { label: "   " }],
    ["/api/clients/code", { label: "l".repeat(201) }],
    ["/api/clients/revoke", {}],
    ["/api/clients/mcp-token", { clientId: "" }],
    ["/api/clients/mcp-token/revoke", { clientId: 7 }],
  ];
  for (const [path, body] of malformed) {
    const answer = await api(port, cookie, "POST", path, body);
    assert.equal(answer.status, 400, path);
    assert.deepEqual(json(answer), { error: "bad_request" });
  }
  assert.deepEqual(fake.calls, []);
  assert.equal(
    (await api(port, cookie, "POST", "/api/clients/other", { clientId: "c" }))
      .status,
    404,
  );
});

test("T4 each refusal answers its status and fixed code; a MARKER token reaches no answer or log", async () => {
  const { port, fake } = await startUi();
  const cookie = await signIn(port);
  const set = () =>
    api(port, cookie, "POST", "/api/integrations/atlassian/set", SET_BODY);
  const expected: [IntegrationsRefusalCode, number][] = [
    ["integration_invalid", 400],
    ["integration_rejected", 422],
    ["integration_unreachable", 502],
    ["vault_locked", 503],
    ["vault_unavailable", 503],
    ["tools_unavailable", 503],
    ["integration_busy", 409],
  ];
  for (const [code, status] of expected) {
    fake.fail(new IntegrationsRefusal(code));
    const answer = await set();
    assert.equal(answer.status, status, code);
    assert.deepEqual(json(answer), { error: code });
  }
  fake.fail(new ClientsRefusal("unknown_client"));
  for (const path of [
    "/api/clients/revoke",
    "/api/clients/mcp-token",
    "/api/clients/mcp-token/revoke",
  ]) {
    const answer = await api(port, cookie, "POST", path, { clientId: "c1" });
    assert.equal(answer.status, 404, path);
    assert.deepEqual(json(answer), { error: "unknown_client" });
  }
  fake.fail(new ClientsRefusal("limit_reached"));
  const limited = await api(port, cookie, "POST", "/api/clients/code", {
    label: "x",
  });
  assert.equal(limited.status, 409);
  assert.deepEqual(json(limited), { error: "limit_reached" });
  // Anything else, as a held registry lock, is unavailable without its text.
  fake.fail(new Error(`registry lock held ${MARKER}`));
  for (const [method, path, body] of ROUTES) {
    const answer = await api(port, cookie, method, path, body);
    assert.equal(answer.status, 503, path);
    assert.deepEqual(json(answer), { error: "unavailable" });
  }
  fake.fail(undefined);
  // A successful set logs a fixed line: no token, site or email.
  await set();
  assert.ok(logs.includes("ui integration atlassian: set user=u1"));
  for (const line of logs) {
    assert.ok(!line.includes(MARKER), line);
    assert.ok(!line.includes(EMAIL), line);
    assert.ok(!line.includes("x.atlassian.net"), line);
  }
});

/** Resolves with the ms from `from` until the socket closes. */
function closedAfter(socket: net.Socket, from: () => number): Promise<number> {
  return new Promise((resolve) =>
    socket.once("close", () => resolve(Date.now() - from())),
  );
}

test("T4 socket idle: an integration request outlives the idle bound, which is back before its response; other routes get no raise", async () => {
  const { port, fake } = await startUi(fakeSettings(), {
    idle: 300,
    integration: 3_000,
  });
  const cookie = await signIn(port);
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

  // A set answering after 1 s, beyond the 300 ms baseline, is answered.
  fake.delaySet(1_000);
  const answer = await api(
    port,
    cookie,
    "POST",
    "/api/integrations/atlassian/set",
    SET_BODY,
  );
  const answeredAt = Date.now();
  assert.equal(answer.status, 200);
  const raised = bounds.filter((bound) => bound.ms === 3_000);
  assert.equal(raised.length, 1);
  const restored = bounds.filter(
    (bound) => bound.socket === raised[0]!.socket && bound.ms === 300,
  );
  assert.ok(
    restored.some((bound) => bound.at >= raised[0]!.at + 900),
    "the baseline is restored after the adapter",
  );
  assert.ok(restored.every((bound) => bound.at <= answeredAt));

  // Status and clear are raised and restored too; the clients routes not.
  bounds.length = 0;
  await api(port, cookie, "GET", "/api/integrations/atlassian");
  await api(port, cookie, "POST", "/api/integrations/atlassian/clear", {});
  assert.equal(bounds.filter((bound) => bound.ms === 3_000).length, 2);
  bounds.length = 0;
  await api(port, cookie, "GET", "/api/clients");
  await api(port, cookie, "POST", "/api/clients/code", { label: "x" });
  assert.deepEqual(
    bounds.filter((bound) => bound.ms === 3_000),
    [],
  );

  // A fresh socket left without a request closes at the baseline.
  vi.restoreAllMocks();
  const raw = tls.connect({ host: "127.0.0.1", port, ca: edgeTls.caCertPem });
  await new Promise<void>((resolve, reject) => {
    raw.once("secureConnect", resolve);
    raw.once("error", reject);
  });
  const connectedAt = Date.now();
  const fresh = await closedAfter(raw, () => connectedAt);
  assert.ok(fresh >= 200 && fresh < 1_500, `closed after ${fresh} ms`);
});

// --- startEdge over the real seam -------------------------------------------

/** Fake Atlassian tools: any `*.atlassian.net`, a check as told. */
function fakeTools(check: () => Promise<IntegrationCheck>): EdgeTools {
  return {
    handleMcp: (_req, res) => {
      res.writeHead(200);
      res.end("mcp");
    },
    host: { list: () => [], call: () => Promise.reject(new Error("unused")) },
    integrations: {
      atlassian: {
        parse: (input) => {
          const { site, email, token } = input as Record<string, unknown>;
          return typeof site === "string" &&
            site.endsWith(".atlassian.net") &&
            typeof email === "string" &&
            typeof token === "string"
            ? {
                ok: true,
                credential: JSON.stringify({ site, email, token }),
                site,
                email,
              }
            : { ok: false };
        },
        check: () => check(),
        describe: (credential) => {
          const { site, email } = JSON.parse(credential) as Record<
            string,
            string
          >;
          return site && email ? { site, email } : undefined;
        },
      },
    },
  };
}

async function edgeWithUi(tools: EdgeTools) {
  const edgeIssuer = await startFakeIssuer({
    advertised: EDGE_ISSUER,
    now: () => Date.now(),
  });
  open.push({ close: () => edgeIssuer.close() });
  mkdirSync(DATA_DIR, { recursive: true });
  const dir = mkdtempSync(join(DATA_DIR, "gateway-settings-"));
  writeFileSync(join(dir, "cert.pem"), edgeTls.serverCertPem);
  writeFileSync(join(dir, "key.pem"), edgeTls.serverKeyPem, { mode: 0o600 });
  const uiConfigFile = join(dir, "ui.json");
  writeFileSync(
    uiConfigFile,
    JSON.stringify({
      port: 0,
      publicOrigin: PUBLIC_ORIGIN,
      certFile: join(dir, "cert.pem"),
      keyFile: join(dir, "key.pem"),
      distDir,
      oidc: {
        issuer: EDGE_ISSUER,
        clientId: CLIENT_ID,
        clientSecret: CLIENT_PW,
      },
      allow: { emailDomains: ["example.org"] },
    }),
    { mode: 0o600 },
  );
  // The edge's own lines go to the console; they join the leak check.
  vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    logs.push(args.map(String).join(" "));
  });
  const edge: RunningEdge = await startEdge(
    {
      stateDir: join(dir, "state"),
      port: 0,
      modelPort: 0,
      clientPort: 0,
      enrollPort: 0,
      uiConfig: uiConfigFile,
    },
    {
      log: (line) => logs.push(line),
      oidcTestOptions: {
        fetch: (url, init) =>
          fetch(url.replace(EDGE_ISSUER, edgeIssuer.listening), init),
      },
      tools,
    },
  );
  open.push(edge);
  const port = edge.uiPort!;
  return {
    edge,
    port,
    signIn: (sub?: string) => signIn(port, edgeIssuer, sub),
  };
}

test("T5 two users over the real seam: clients, MCP tokens, limits and the Atlassian credential", async () => {
  let check: () => Promise<IntegrationCheck> = () =>
    Promise.resolve({ ok: true, displayName: "Person", accountId: "acc-1" });
  const {
    edge,
    port,
    signIn: signInEdge,
  } = await edgeWithUi(fakeTools(() => check()));
  const registry = edge.gateway.clients!.registry;
  const a = await signInEdge("subject-a");
  const b = await signInEdge("subject-b");
  const from = answers.length;
  const secrets: string[] = [];

  // 1. A's code, redeemed as the relay would, then A's MCP token.
  const coded = await api(port, a, "POST", "/api/clients/code", {
    label: "laptop",
  });
  assert.equal(coded.status, 200);
  const { code, validForSeconds } = json(coded) as {
    code: string;
    validForSeconds: number;
  };
  assert.equal(validForSeconds, 900);
  secrets.push(code);
  const client = registry.redeem(code, (pending) => ({
    id: "client-a",
    userId: pending.userId,
    label: pending.label,
    fingerprint: "fp-a",
    createdAt: 1_000,
  }));
  assert.ok(client);
  const minted = await api(port, a, "POST", "/api/clients/mcp-token", {
    clientId: "client-a",
  });
  assert.equal(minted.status, 200);
  const token = json(minted).token as string;
  secrets.push(token);
  const recordA = () => registry.clients().find((c) => c.id === "client-a")!;
  const hash = recordA().mcpTokenHash;

  // 2. B sees none of A's clients and can change none of them.
  assert.deepEqual(json(await api(port, b, "GET", "/api/clients")), {
    clients: [],
  });
  for (const path of [
    "/api/clients/revoke",
    "/api/clients/mcp-token",
    "/api/clients/mcp-token/revoke",
  ]) {
    const refused = await api(port, b, "POST", path, { clientId: "client-a" });
    assert.equal(refused.status, 404, path);
    assert.deepEqual(json(refused), { error: "unknown_client" });
    assert.equal(recordA().revokedAt, undefined, path);
    assert.equal(recordA().mcpTokenHash, hash, path);
    assert.ok(mcpTokenMatches(recordA(), token), path);
  }

  // 3. A's list shows the token's presence, never the token.
  assert.deepEqual(json(await api(port, a, "GET", "/api/clients")), {
    clients: [
      { id: "client-a", label: "laptop", createdAt: 1_000, mcpToken: true },
    ],
  });
  assert.equal(
    (
      await api(port, a, "POST", "/api/clients/mcp-token/revoke", {
        clientId: "client-a",
      })
    ).status,
    204,
  );
  assert.equal(
    (
      json(await api(port, a, "GET", "/api/clients")).clients as {
        mcpToken: boolean;
      }[]
    )[0]!.mcpToken,
    false,
  );
  const again = json(
    await api(port, a, "POST", "/api/clients/mcp-token", {
      clientId: "client-a",
    }),
  ).token as string;
  secrets.push(again);
  assert.notEqual(again, token);
  assert.ok(!mcpTokenMatches(recordA(), token));
  assert.ok(mcpTokenMatches(recordA(), again));
  assert.equal(
    (
      await api(port, a, "POST", "/api/clients/revoke", {
        clientId: "client-a",
      })
    ).status,
    204,
  );
  assert.deepEqual(json(await api(port, a, "GET", "/api/clients")), {
    clients: [],
  });
  assert.ok(recordA().revokedAt !== undefined);

  // 4. Four unused codes, then the limit.
  for (let i = 0; i < 4; i++) {
    const issued = await api(port, a, "POST", "/api/clients/code", {
      label: `spare ${i}`,
    });
    assert.equal(issued.status, 200);
    secrets.push(json(issued).code as string);
  }
  const limited = await api(port, a, "POST", "/api/clients/code", {
    label: "one more",
  });
  assert.equal(limited.status, 409);
  assert.deepEqual(json(limited), { error: "limit_reached" });

  // 5. The Atlassian credential: stored for A only; the token never answered.
  const set = await api(port, a, "POST", "/api/integrations/atlassian/set", {
    site: "x.atlassian.net",
    email: EMAIL,
    token: MARKER,
    userId: "someone-else",
  });
  assert.equal(set.status, 200);
  assert.deepEqual(json(set), {
    connected: true,
    site: "x.atlassian.net",
    email: EMAIL,
    displayName: "Person",
  });
  assert.deepEqual(
    json(await api(port, a, "GET", "/api/integrations/atlassian")),
    { connected: true, site: "x.atlassian.net", email: EMAIL },
  );
  assert.deepEqual(
    json(await api(port, b, "GET", "/api/integrations/atlassian")),
    { connected: false },
  );
  assert.equal(
    (await api(port, a, "POST", "/api/integrations/atlassian/clear", {}))
      .status,
    204,
  );
  assert.deepEqual(
    json(await api(port, a, "GET", "/api/integrations/atlassian")),
    { connected: false },
  );
  check = () => Promise.resolve({ ok: false, problem: "rejected" });
  const rejected = await api(
    port,
    a,
    "POST",
    "/api/integrations/atlassian/set",
    { site: "x.atlassian.net", email: EMAIL, token: MARKER },
  );
  assert.equal(rejected.status, 422);
  assert.deepEqual(json(rejected), { error: "integration_rejected" });

  // While one write runs, a second one is refused at once: 409, no change.
  let release: (() => void) | undefined;
  check = () =>
    new Promise((resolve) => {
      release = () => resolve({ ok: true });
    });
  const first = api(port, a, "POST", "/api/integrations/atlassian/set", {
    site: "x.atlassian.net",
    email: EMAIL,
    token: MARKER,
  });
  await vi.waitFor(() => assert.ok(release));
  for (const [path, body] of [
    [
      "/api/integrations/atlassian/set",
      { site: "x.atlassian.net", email: "other@example.org", token: MARKER },
    ],
    ["/api/integrations/atlassian/clear", {}],
  ] as const) {
    const busy = await api(port, a, "POST", path, body);
    assert.equal(busy.status, 409, path);
    assert.deepEqual(json(busy), { error: "integration_busy" });
  }
  release!();
  assert.equal((await first).status, 200);
  assert.deepEqual(
    json(await api(port, a, "GET", "/api/integrations/atlassian")),
    { connected: true, site: "x.atlassian.net", email: EMAIL },
  );

  // 6. Each code and token is in its creating answer only, and in no log.
  const later = answers.slice(from);
  for (const secret of secrets) {
    const carrying = later.filter(
      (answer) =>
        answer.body.includes(secret) ||
        JSON.stringify(answer.headers).includes(secret),
    );
    assert.equal(carrying.length, 1, "a secret outside its creating answer");
    for (const line of logs) assert.ok(!line.includes(secret), line);
  }
});
