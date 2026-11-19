/**
 * The gateway page's enrollment request routes (Task-1410) over a fake
 * `GatewayWebClients`: the session gate and mutation rule, the user only
 * from the session, the fixed refusals, the per-user budget shared by lookup
 * and decide across sessions, the global miss cap, and that no user code
 * reaches a log line, a refusal or a URL. Every value is fake.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import https from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, test } from "vitest";
import type { GatewayUiEnrollmentRequest } from "@assistant/shared/gatewayUi";
import { edgeTlsFor } from "../gateway/x509.ts";
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
  EnrollmentBudget,
  MISSES_PER_HOUR,
  USER_PER_HOUR,
  USER_PER_MINUTE,
} from "./enrollmentBudget.ts";
import { IntegrationsRefusal } from "./integrations.ts";
import { startGatewayWeb } from "./server.ts";

const KNOWN = "BCDF-GHJK";
const LIMITED = "LMNP-QRST";
const REQUEST: GatewayUiEnrollmentRequest = {
  name: "devbox-7",
  kind: "devbox",
  from: "100.64.0.7",
  createdAt: 1_000,
  expiresAt: 601_000,
};

const edgeTls = edgeTlsFor(["localhost", "127.0.0.1"], undefined);
const agent = new https.Agent({ ca: edgeTls.caCertPem, keepAlive: true });
let issuer: FakeIssuer;
let distDir: string;
const logs: string[] = [];
const open: { close(): Promise<void> }[] = [];
/** Every user code a test sent; none may reach a log line or a refusal. */
const sentCodes = new Set<string>();
const refusals: string[] = [];

interface Answer {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

function request(
  port: number,
  path: string,
  options: { method?: string; headers?: Record<string, string>; body?: string },
): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        host: "127.0.0.1",
        port,
        path,
        method: options.method ?? "GET",
        agent,
        headers: {
          ...options.headers,
          ...(options.body === undefined
            ? {}
            : { "content-length": String(Buffer.byteLength(options.body)) }),
        },
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
          if (answer.status >= 400) refusals.push(body);
          resolve(answer);
        });
      },
    );
    req.on("error", reject);
    req.end(options.body);
  });
}

function cookieValue(answer: Answer, name: string): string | undefined {
  const lines = answer.headers["set-cookie"];
  for (const line of Array.isArray(lines) ? lines : [])
    if (line.startsWith(`${name}=`))
      return line.slice(name.length + 1).split(";")[0];
  return undefined;
}

async function signIn(port: number, sub: string): Promise<string> {
  const login = await request(port, "/auth/login", {});
  const provider = new URL(String(login.headers.location));
  const signin = cookieValue(login, "__Host-pgw_signin")!;
  const code = issuer.authorize(provider, {
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

const MUTATION = {
  origin: PUBLIC_ORIGIN,
  "x-gateway-ui": "1",
  "content-type": "application/json",
};

function post(
  port: number,
  cookie: string | undefined,
  path: string,
  body: unknown,
  headers: Record<string, string> = MUTATION,
): Promise<Answer> {
  const code = (body as { userCode?: unknown } | undefined)?.userCode;
  if (typeof code === "string" && code.length >= 4) sentCodes.add(code);
  return request(port, path, {
    method: "POST",
    headers: { ...headers, ...(cookie ? { cookie } : {}) },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

const lookup = (port: number, cookie: string | undefined, userCode: string) =>
  post(port, cookie, "/api/enrollments/lookup", { userCode });
const decide = (
  port: number,
  cookie: string | undefined,
  userCode: string,
  approve: boolean,
) => post(port, cookie, "/api/enrollments/decide", { userCode, approve });

const NO_ACCOUNTS: GatewayWebAccounts = {
  list: () => [],
  remove: () => {},
  start: () => ({ loginId: "l", accountId: "a" }),
  input: () => {},
  cancel: () => {},
  read: () => ({ kind: "claude", state: "running", output: "", cursor: 0 }),
  endActor: () => {},
};

/** Clients that know `KNOWN` (and `LIMITED`, whose approval is refused). */
function fakeClients() {
  const calls: { op: string; userId: string; args: unknown[] }[] = [];
  let failWith: Error | undefined;
  const clients: GatewayWebClients = {
    list: () => [],
    createCode: () => ({ code: "unused", validForSeconds: 900 }),
    revoke: () => {},
    mintMcpToken: () => ({ token: "unused" }),
    revokeMcpToken: () => {},
    enrollment: (userId, userCode) => {
      calls.push({ op: "enrollment", userId, args: [userCode] });
      if (failWith) throw failWith;
      if (userCode !== KNOWN && userCode !== LIMITED)
        throw new ClientsRefusal("unknown_request");
      return REQUEST;
    },
    decideEnrollment: (userId, userCode, approve) => {
      calls.push({ op: "decide", userId, args: [userCode, approve] });
      if (failWith) throw failWith;
      if (userCode === LIMITED && approve)
        throw new ClientsRefusal("limit_reached");
      if (userCode !== KNOWN && userCode !== LIMITED)
        throw new ClientsRefusal("unknown_request");
    },
  };
  return { clients, calls, fail: (err?: Error) => (failWith = err) };
}

async function startUi() {
  let now = Date.now();
  const fake = fakeClients();
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
    // Each subject is its own user.
    users: {
      signIn: (identity) => ({
        userId: `u-${identity.subject}`,
        outcome: "existing",
      }),
      user: (id) => ({ id, label: EMAIL, email: EMAIL }),
    },
    accounts: NO_ACCOUNTS,
    integrations: {
      status: () => Promise.resolve({ connected: false, connectWith: "token" }),
      set: () => Promise.reject(new IntegrationsRefusal("tools_unavailable")),
      clear: () => Promise.reject(new IntegrationsRefusal("tools_unavailable")),
      connect: () =>
        Promise.reject(new IntegrationsRefusal("tools_unavailable")),
      slackStatus: () => Promise.resolve({ connected: false }),
      connectSlack: () =>
        Promise.reject(new IntegrationsRefusal("tools_unavailable")),
      clearSlack: () =>
        Promise.reject(new IntegrationsRefusal("tools_unavailable")),
    },
    clients: fake.clients,
    requests: { since: () => ({ epoch: "", requests: [] }) },
    log: (line) => logs.push(line),
    now: () => now,
    oidcTestOptions: { allowInsecureRequests: true },
  });
  open.push(web);
  return {
    port: web.port,
    fake,
    advance: (ms: number) => (now += ms),
  };
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
  while (open.length) await open.pop()!.close();
});

afterAll(async () => {
  agent.destroy();
  await issuer.close();
  rmSync(distDir, { recursive: true, force: true });
  // No user code in a log line or a refusal body.
  for (const code of sentCodes) {
    for (const line of logs)
      assert.ok(!line.includes(code), `a log line holds a code: ${line}`);
    for (const body of refusals)
      assert.ok(!body.includes(code), `a refusal holds a code: ${body}`);
  }
});

test("both routes answer 401 without a session and 403 without Origin and the header; nothing reaches the adapter", async () => {
  const { port, fake } = await startUi();
  for (const path of ["/api/enrollments/lookup", "/api/enrollments/decide"]) {
    const answer = await post(port, undefined, path, {
      userCode: KNOWN,
      approve: true,
    });
    assert.equal(answer.status, 401, path);
    assert.deepEqual(JSON.parse(answer.body), { error: "signed_out" });
  }
  const cookie = await signIn(port, "a");
  for (const path of ["/api/enrollments/lookup", "/api/enrollments/decide"])
    for (const headers of [
      { "x-gateway-ui": "1" },
      { origin: PUBLIC_ORIGIN },
      { origin: "https://elsewhere.test", "x-gateway-ui": "1" },
    ]) {
      const answer = await post(
        port,
        cookie,
        path,
        { userCode: KNOWN, approve: true },
        { ...headers, "content-type": "application/json" },
      );
      assert.equal(answer.status, 403, path);
      assert.deepEqual(JSON.parse(answer.body), { error: "forbidden" });
    }
  // A GET carries no code and is no route.
  const got = await request(port, "/api/enrollments/lookup", {
    headers: { cookie },
  });
  assert.equal(got.status, 404);
  assert.deepEqual(fake.calls, []);
});

test("lookup answers the request; decide approves or denies for the session's user, never a body's", async () => {
  const { port, fake } = await startUi();
  const cookie = await signIn(port, "a");
  const found = await post(port, cookie, "/api/enrollments/lookup", {
    userCode: KNOWN,
    userId: "u-mallory",
  });
  assert.equal(found.status, 200);
  assert.equal(found.headers["cache-control"], "no-store");
  assert.deepEqual(JSON.parse(found.body), REQUEST);
  const approved = await post(port, cookie, "/api/enrollments/decide", {
    userCode: KNOWN,
    approve: true,
    userId: "u-mallory",
  });
  assert.equal(approved.status, 204);
  const denied = await decide(port, cookie, KNOWN, false);
  assert.equal(denied.status, 204);
  assert.deepEqual(fake.calls, [
    { op: "enrollment", userId: "u-a", args: [KNOWN] },
    { op: "decide", userId: "u-a", args: [KNOWN, true] },
    { op: "decide", userId: "u-a", args: [KNOWN, false] },
  ]);
  assert.ok(logs.includes("ui enrollments: request approved user=u-a"));
  assert.ok(logs.includes("ui enrollments: request denied user=u-a"));
});

test("refusals are fixed: unknown_request 404, limit_reached 409, malformed 400, a broken adapter 503", async () => {
  const { port, fake } = await startUi();
  const cookie = await signIn(port, "a");
  const unknown = await lookup(port, cookie, "ZZZZ-ZZZZ");
  assert.equal(unknown.status, 404);
  assert.deepEqual(JSON.parse(unknown.body), { error: "unknown_request" });
  const unknownDecide = await decide(port, cookie, "ZZZZ-ZZZY", true);
  assert.deepEqual(
    [unknownDecide.status, JSON.parse(unknownDecide.body)],
    [404, { error: "unknown_request" }],
  );
  const limited = await decide(port, cookie, LIMITED, true);
  assert.deepEqual(
    [limited.status, JSON.parse(limited.body)],
    [409, { error: "limit_reached" }],
  );
  const callsBefore = fake.calls.length;
  for (const [path, body] of [
    ["/api/enrollments/lookup", "not json"],
    ["/api/enrollments/lookup", {}],
    ["/api/enrollments/lookup", { userCode: 7 }],
    ["/api/enrollments/lookup", { userCode: "" }],
    ["/api/enrollments/lookup", { userCode: "X".repeat(17) }],
    ["/api/enrollments/decide", { userCode: KNOWN }],
    ["/api/enrollments/decide", { userCode: KNOWN, approve: "yes" }],
  ] as const) {
    const answer = await post(port, cookie, path, body);
    assert.equal(answer.status, 400, JSON.stringify(body));
    assert.deepEqual(JSON.parse(answer.body), { error: "bad_request" });
  }
  assert.equal(
    fake.calls.length,
    callsBefore,
    "malformed bodies reach nothing",
  );
  fake.fail(new Error("registry down"));
  const broken = await lookup(port, cookie, KNOWN);
  assert.deepEqual(
    [broken.status, JSON.parse(broken.body)],
    [503, { error: "unavailable" }],
  );
});

test("lookup and decide share one budget per user across sessions: 10 a minute, 60 an hour", async () => {
  const { port, fake, advance } = await startUi();
  const first = await signIn(port, "a");
  const second = await signIn(port, "a");
  const other = await signIn(port, "b");
  // Malformed bodies cost nothing.
  for (let i = 0; i < 20; i++)
    await post(port, first, "/api/enrollments/lookup", { userCode: 1 });
  for (let i = 0; i < USER_PER_MINUTE; i++) {
    const answer =
      i % 2 === 0
        ? await lookup(port, i < 5 ? first : second, KNOWN)
        : await decide(port, i < 5 ? first : second, KNOWN, false);
    assert.ok(answer.status < 400, `call ${i}`);
  }
  for (const [cookie, call] of [
    [first, () => lookup(port, first, KNOWN)],
    [second, () => decide(port, second, KNOWN, true)],
  ] as const) {
    const refused = await call();
    assert.equal(refused.status, 429, cookie === first ? "first" : "second");
    assert.deepEqual(JSON.parse(refused.body), { error: "rate_limited" });
    assert.ok(Number(refused.headers["retry-after"]) >= 1);
  }
  assert.equal(
    fake.calls.length,
    USER_PER_MINUTE,
    "a refused call reaches nothing",
  );
  // Another user has their own budget.
  assert.equal((await lookup(port, other, KNOWN)).status, 200);
  assert.ok(logs.includes("ui enrollments: refused, budget spent user=u-a"));

  // A minute later the minute budget is back; the hour's runs out at 60.
  let spent = USER_PER_MINUTE;
  while (spent < USER_PER_HOUR) {
    advance(60_000);
    for (let i = 0; i < USER_PER_MINUTE && spent < USER_PER_HOUR; i++, spent++)
      assert.equal((await lookup(port, second, KNOWN)).status, 200);
  }
  advance(60_000);
  const hourly = await lookup(port, first, KNOWN);
  assert.equal(hourly.status, 429);
  const wait = Number(hourly.headers["retry-after"]);
  assert.ok(wait > 60 && wait <= 3_600, String(wait));
  advance(wait * 1_000);
  assert.equal((await lookup(port, first, KNOWN)).status, 200);
});

test("misses across all users are capped at 120 an hour, then every user is refused until the oldest is an hour old", async () => {
  const { port, advance } = await startUi();
  const users = await Promise.all(
    Array.from({ length: MISSES_PER_HOUR / USER_PER_MINUTE + 1 }, (_, i) =>
      signIn(port, `m${i}`),
    ),
  );
  const bystander = users.pop()!;
  let n = 0;
  const miss = () =>
    `ZZZZ-${String(n++)
      .padStart(4, "0")
      .replace(/\d/g, (d) => "BCDFGHJKLM"[Number(d)]!)}`;
  for (const cookie of users)
    for (let i = 0; i < USER_PER_MINUTE; i++)
      assert.equal((await lookup(port, cookie, miss())).status, 404);
  assert.ok(logs.includes("ui enrollments: miss cap reached"));
  // The cap holds for a user who never missed, and for a known code.
  for (const call of [
    () => lookup(port, bystander, KNOWN),
    () => decide(port, bystander, KNOWN, true),
  ]) {
    const refused = await call();
    assert.equal(refused.status, 429);
    assert.deepEqual(JSON.parse(refused.body), { error: "rate_limited" });
  }
  assert.ok(
    logs.includes("ui enrollments: refused, miss cap reached user=u-m12"),
  );
  advance(60 * 60_000);
  assert.equal((await lookup(port, bystander, KNOWN)).status, 200);
});

test("the budget holds only users who called in the last hour", () => {
  let now = 0;
  const budget = new EnrollmentBudget(() => now);
  for (let i = 0; i < 100; i++) assert.equal(budget.admit(`u${i}`), undefined);
  assert.equal(budget.users, 100);
  now += 60 * 60_000;
  assert.equal(budget.admit("late"), undefined);
  assert.equal(budget.users, 1);
});
