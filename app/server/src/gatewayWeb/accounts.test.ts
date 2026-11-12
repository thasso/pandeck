/**
 * The gateway page's accounts and logins (Task-1402 B2): the routes over a
 * fake `GatewayWebAccounts` (the session gate, the mutation rule, the body
 * limits, refusals and the browser projection), then `startEdge` with fake
 * login drivers over the edge's real user-scoped operations (add, log in,
 * cancel, remove, and the session's end cancelling its logins).
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type http from "node:http";
import https from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, test, vi } from "vitest";
import { DATA_DIR } from "../config.ts";
import type { LoginDrivers } from "../gateway/vaultPort.ts";
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
import {
  AccountsRefusal,
  type GatewayWebAccounts,
  type GatewayWebActor,
  type GatewayWebLoginView,
} from "./accounts.ts";
import { startGatewayWeb } from "./server.ts";

const HOUR = 60 * 60_000;
const EDGE_ISSUER = "https://issuer.test";
const MARKER = "MARKER-sk-ant-oat01-fake";
const MARKED_URL = `https://claude.com/cai/oauth/authorize?code=${MARKER}`;

const tls = edgeTlsFor(["localhost", "127.0.0.1"], undefined);
const agent = new https.Agent({ ca: tls.caCertPem, keepAlive: true });
let issuer: FakeIssuer;
let clock = Date.now();
let distDir: string;
const logs: string[] = [];
/** Every refusal body, checked for markers. */
const refusals: string[] = [];
const open: { close(): Promise<void> | void }[] = [];
/** Every fake driver run, released before the edge closes. */
const allRuns: { release(): void }[] = [];

/** Polls on real timers, unlike `vi.waitFor` under a faked `setInterval`. */
async function eventually(
  check: () => Promise<void> | void,
  timeoutMs = 5_000,
): Promise<void> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    try {
      await check();
      return;
    } catch (err) {
      if (Date.now() > until) throw err;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
}

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
        agent,
      },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => (body += chunk));
        res.on("end", () => {
          if ((res.statusCode ?? 0) >= 400) refusals.push(body);
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body });
        });
      },
    );
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
  });
}

const json = (answer: Answer): Record<string, unknown> =>
  JSON.parse(answer.body) as Record<string, unknown>;

function uiConfig(issuerUrl: string) {
  return {
    port: 0,
    publicOrigin: PUBLIC_ORIGIN,
    certPem: tls.serverCertPem,
    keyPem: tls.serverKeyPem,
    distDir,
    oidc: { issuer: issuerUrl, clientId: CLIENT_ID, clientSecret: CLIENT_PW },
    allow: { emailDomains: ["example.org"], emails: [], claims: {} },
  };
}

/** A fake seam: records every call with the session it came from. */
function fakeAccounts() {
  const calls: {
    op: string;
    userId: string;
    actorId?: string;
    args: unknown[];
  }[] = [];
  const actors = new Map<string, GatewayWebActor>();
  const ended: string[] = [];
  let failWith: Error | undefined;
  let view: GatewayWebLoginView = {
    kind: "claude",
    state: "running",
    output: "hello",
    cursor: 5,
  };
  const record = (op: string, actor: GatewayWebActor, ...args: unknown[]) => {
    actors.set(actor.actorId, actor);
    calls.push({ op, userId: actor.userId, actorId: actor.actorId, args });
    if (failWith) throw failWith;
  };
  const accounts: GatewayWebAccounts = {
    list: (userId) => {
      calls.push({ op: "list", userId, args: [] });
      if (failWith) throw failWith;
      return [
        { id: "claude-a", provider: "claude", name: "A", needsLogin: true },
      ];
    },
    remove: (userId, accountId) => {
      calls.push({ op: "remove", userId, args: [accountId] });
      if (failWith) throw failWith;
    },
    start: (actor, start) => {
      record("start", actor, start);
      return { loginId: "login-1", accountId: start.accountId ?? "claude-new" };
    },
    input: (actor, loginId, text) => record("input", actor, loginId, text),
    cancel: (actor, loginId) => record("cancel", actor, loginId),
    read: (actor, loginId, cursor) => {
      record("read", actor, loginId, cursor);
      return view;
    },
    endActor: (actorId) => ended.push(actorId),
  };
  return {
    accounts,
    calls,
    actors,
    ended,
    fail: (err: Error | undefined) => (failWith = err),
    setView: (next: GatewayWebLoginView) => (view = next),
  };
}

async function startUi(fake = fakeAccounts()) {
  const web = await startGatewayWeb({
    config: uiConfig(issuer.url),
    users: {
      signIn: () => ({ userId: "u1", outcome: "existing" }),
      user: (id) => ({ id, label: EMAIL, email: EMAIL }),
    },
    accounts: fake.accounts,
    log: (line) => logs.push(line),
    now: () => clock,
    oidcTestOptions: { allowInsecureRequests: true },
  });
  open.push(web);
  return { port: web.port, fake };
}

beforeAll(async () => {
  issuer = await startFakeIssuer({ now: () => clock });
  distDir = mkdtempSync(join(tmpdir(), "gateway-dist-"));
  writeFileSync(
    join(distDir, "gateway.html"),
    "<!doctype html><title>g</title>",
  );
});

afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const run of allRuns.splice(0)) run.release();
  while (open.length) await open.pop()!.close();
  clock = Date.now();
});

afterAll(async () => {
  agent.destroy();
  await issuer.close();
  rmSync(distDir, { recursive: true, force: true });
  for (const text of [...refusals, ...logs])
    assert.ok(
      !text.includes("MARKER"),
      `a refusal or log line leaked: ${text}`,
    );
});

// --- the routes -------------------------------------------------------------

const ROUTES: ["GET" | "POST", string, unknown?][] = [
  ["GET", "/api/accounts"],
  ["POST", "/api/accounts/remove", { accountId: "claude-a" }],
  ["POST", "/api/logins/start", { kind: "claude" }],
  ["POST", "/api/logins/input", { loginId: "login-1", text: "x" }],
  ["POST", "/api/logins/cancel", { loginId: "login-1" }],
  ["GET", "/api/logins/read?login=login-1&cursor=0"],
];

test("AC1: every account and login route answers 401 signed_out without a live session", async () => {
  const { port, fake } = await startUi();
  const cookie = await signIn(port);
  // Ended: signed out.
  assert.equal(
    (
      await request(port, "/auth/logout", {
        method: "POST",
        headers: { cookie, ...MUTATION },
      })
    ).status,
    204,
  );
  // Expired: signed in, then 12 h later.
  const expired = await signIn(port);
  clock += 12 * HOUR;
  for (const session of [
    undefined,
    cookie,
    expired,
    "__Host-pgw_session=forged",
  ])
    for (const [method, path, body] of ROUTES) {
      const answer = await api(port, session, method, path, body);
      assert.equal(answer.status, 401, `${method} ${path}`);
      assert.deepEqual(json(answer), { error: "signed_out" });
    }
  assert.deepEqual(fake.calls, []);
});

test("AC1: the user and the actor come only from the session; a body userId changes nothing", async () => {
  const { port, fake } = await startUi();
  const cookie = await signIn(port);
  const started = await api(port, cookie, "POST", "/api/logins/start", {
    kind: "claude",
    userId: "u2",
    actorId: "someone-else",
  });
  assert.equal(started.status, 200);
  assert.deepEqual(json(started), {
    loginId: "login-1",
    accountId: "claude-new",
  });
  await api(port, cookie, "POST", "/api/accounts/remove", {
    accountId: "claude-a",
    userId: "u2",
  });
  await api(port, cookie, "GET", "/api/accounts?userId=u2");
  assert.deepEqual(
    fake.calls.map((c) => [c.op, c.userId]),
    [
      ["start", "u1"],
      ["remove", "u1"],
      ["list", "u1"],
    ],
  );
  assert.deepEqual(fake.calls[0]!.args, [{ kind: "claude" }]);
  assert.notEqual(fake.calls[0]!.actorId, "someone-else");
});

test("every POST needs the Origin and the header", async () => {
  const { port, fake } = await startUi();
  const cookie = await signIn(port);
  for (const headers of [
    { cookie },
    { cookie, origin: PUBLIC_ORIGIN },
    { cookie, "x-gateway-ui": "1" },
    { cookie, origin: "https://evil.test", "x-gateway-ui": "1" },
  ]) {
    const answer = await request(port, "/api/logins/start", {
      method: "POST",
      headers,
      body: JSON.stringify({ kind: "claude" }),
    });
    assert.equal(answer.status, 403);
  }
  assert.deepEqual(fake.calls, []);
});

test("AC4/AC7: refusals are fixed codes; a registry failure is 503 unavailable; malformed requests 400", async () => {
  const { port, fake } = await startUi();
  const cookie = await signIn(port);
  const cases: [AccountsRefusal | Error, number, string][] = [
    [new AccountsRefusal("unknown_account"), 404, "unknown_account"],
    [new AccountsRefusal("unknown_login"), 404, "unknown_login"],
    [new AccountsRefusal("login_unavailable"), 503, "login_unavailable"],
    [new Error(`registry broke ${MARKER}`), 503, "unavailable"],
  ];
  for (const [err, status, code] of cases) {
    fake.fail(err);
    const answer = await api(port, cookie, "POST", "/api/logins/start", {
      kind: "claude",
      accountId: "claude-a",
    });
    assert.equal(answer.status, status);
    assert.deepEqual(json(answer), { error: code });
  }
  fake.fail(undefined);
  for (const [path, body] of [
    ["/api/logins/start", "not json"],
    ["/api/logins/start", { kind: "gemini" }],
    ["/api/logins/start", { kind: "claude", accountId: 7 }],
    ["/api/logins/input", { loginId: "login-1" }],
    ["/api/logins/cancel", {}],
    ["/api/accounts/remove", { accountId: "" }],
  ] as const) {
    const answer = await api(port, cookie, "POST", path, body);
    assert.equal(answer.status, 400, path);
    assert.deepEqual(json(answer), { error: "bad_request" });
  }
  for (const query of ["", "?login=x&cursor=-1", "?login=x&cursor=1.5"]) {
    const answer = await api(port, cookie, "GET", `/api/logins/read${query}`);
    assert.equal(answer.status, 400, query);
  }
});

test("AC6: the input route takes 16 KiB; every other route keeps 1 KiB", async () => {
  const { port, fake } = await startUi();
  const cookie = await signIn(port);
  const code = "c".repeat(8_192);
  const ok = await api(port, cookie, "POST", "/api/logins/input", {
    loginId: "login-1",
    text: code,
  });
  assert.equal(ok.status, 204);
  assert.deepEqual(fake.calls.at(-1)!.args, ["login-1", code]);
  const big = JSON.stringify({
    loginId: "login-1",
    text: "c".repeat(16 * 1024),
  });
  assert.ok(Buffer.byteLength(big) > 16 * 1024);
  assert.equal(
    (await api(port, cookie, "POST", "/api/logins/input", big)).status,
    413,
  );
  for (const path of [
    "/api/logins/start",
    "/api/logins/cancel",
    "/api/accounts/remove",
  ])
    for (const size of [1_025, 2_048])
      assert.equal(
        (await api(port, cookie, "POST", path, "x".repeat(size))).status,
        413,
        `${path} ${size}`,
      );
});

test("AC5/AC15: a read shows a ChatGPT device only with both parts, never Claude's url or a reason's text", async () => {
  const { port, fake } = await startUi();
  const cookie = await signIn(port);
  const read = async () =>
    json(
      await api(port, cookie, "GET", "/api/logins/read?login=login-1&cursor=2"),
    );
  fake.setView({
    kind: "claude",
    state: "error",
    reason: "failed",
    output: "out",
    cursor: 5,
    url: "https://claude.example/u",
    code: "ABC",
  });
  assert.deepEqual(await read(), {
    state: "error",
    reason: "failed",
    output: "out",
    cursor: 5,
  });
  assert.deepEqual(fake.calls.at(-1)!.args, ["login-1", 2]);
  fake.setView({
    kind: "openai-codex",
    state: "running",
    output: "",
    cursor: 0,
    url: "https://auth.example/device",
  });
  assert.equal((await read()).device, undefined);
  fake.setView({
    kind: "openai-codex",
    state: "running",
    output: "",
    cursor: 0,
    url: "https://auth.example/device",
    code: "ABCD-1234",
  });
  assert.deepEqual((await read()).device, {
    verificationUri: "https://auth.example/device",
    userCode: "ABCD-1234",
  });
});

test("AC10: sign-out ends the actor at once; expiry ends it at the next sweep without a request", async () => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  const { port, fake } = await startUi();
  const first = await signIn(port);
  await api(port, first, "POST", "/api/logins/start", { kind: "claude" });
  const firstActor = fake.actors.get(fake.calls[0]!.actorId!)!;
  assert.equal(firstActor.active(), true);
  await request(port, "/auth/logout", {
    method: "POST",
    headers: { cookie: first, ...MUTATION },
  });
  assert.deepEqual(fake.ended, [firstActor.actorId]);
  assert.equal(firstActor.active(), false);

  const second = await signIn(port);
  await api(port, second, "POST", "/api/logins/start", { kind: "claude" });
  const secondActor = fake.actors.get(fake.calls[1]!.actorId!)!;
  clock += 12 * HOUR;
  // No request: only the sweep's timer.
  await vi.advanceTimersByTimeAsync(60_000);
  assert.deepEqual(fake.ended, [firstActor.actorId, secondActor.actorId]);
});

// --- startEdge over the real seam ---------------------------------------------

interface FakeDriverRun {
  inputs: string[];
  cancels: number;
  complete(): void;
  fail(message: string): void;
  release(): void;
}

/**
 * A Claude driver emitting an authorization URL, writing its credential on
 * input; a Codex driver emitting its link and code. With `holdCancel`, a
 * cancel only counts until `release()`.
 */
function fakeDrivers(holdCancel = false) {
  const runs: FakeDriverRun[] = [];
  const make =
    (kind: "claude" | "codex"): NonNullable<LoginDrivers["claude"]> =>
    (dir, events) => {
      let resolve!: () => void;
      let reject!: (err: Error) => void;
      const done = new Promise<void>((res, rej) => {
        resolve = res;
        reject = rej;
      });
      const write = () =>
        writeFileSync(
          join(dir, ".credentials.json"),
          JSON.stringify({
            claudeAiOauth: {
              accessToken: "fake-access",
              expiresAt: Date.now() + HOUR,
            },
          }),
        );
      const run: FakeDriverRun = {
        inputs: [],
        cancels: 0,
        complete: () => {
          write();
          resolve();
        },
        fail: (message) => reject(new Error(message)),
        release: () => reject(new Error(`stopped ${MARKER}`)),
      };
      runs.push(run);
      allRuns.push(run);
      if (kind === "claude") {
        events.output(`Open this link:\n${MARKED_URL}\nPaste code: `);
      } else {
        events.url("https://auth.example/device");
        events.code("ABCD-1234");
      }
      return {
        input: (text) => {
          run.inputs.push(text);
          run.complete();
        },
        cancel: () => {
          run.cancels++;
          if (!holdCancel) run.release();
        },
        done,
      };
    };
  return {
    runs,
    drivers: {
      claude: make("claude"),
      "openai-codex": make("codex"),
    } as LoginDrivers,
  };
}

async function edgeWithUi(drivers: LoginDrivers) {
  const edgeIssuer = await startFakeIssuer({
    advertised: EDGE_ISSUER,
    now: () => clock,
  });
  open.push({ close: () => edgeIssuer.close() });
  mkdirSync(DATA_DIR, { recursive: true });
  const dir = mkdtempSync(join(DATA_DIR, "gateway-accounts-"));
  writeFileSync(join(dir, "cert.pem"), tls.serverCertPem);
  writeFileSync(join(dir, "key.pem"), tls.serverKeyPem, { mode: 0o600 });
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
      loginDrivers: drivers,
      oidcTestOptions: {
        fetch: (url, init) =>
          fetch(url.replace(EDGE_ISSUER, edgeIssuer.listening), init),
      },
      uiNow: () => clock,
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

const accountsOf = async (port: number, cookie: string) =>
  json(await api(port, cookie, "GET", "/api/accounts")).accounts as {
    id: string;
    provider: string;
    name: string;
    needsLogin: boolean;
  }[];

async function readUntil(
  port: number,
  cookie: string,
  loginId: string,
  state: string,
): Promise<Record<string, unknown>> {
  let last: Record<string, unknown> = {};
  await eventually(async () => {
    last = json(
      await api(
        port,
        cookie,
        "GET",
        `/api/logins/read?login=${loginId}&cursor=0`,
      ),
    );
    assert.equal(last.state, state);
  });
  return last;
}

test("AC3/AC13: startEdge serves add, log in, paste and list over the real seam", async () => {
  const { runs, drivers } = fakeDrivers();
  const { port, signIn: edgeSignIn } = await edgeWithUi(drivers);
  const cookie = await edgeSignIn();
  assert.deepEqual(await accountsOf(port, cookie), []);
  const started = json(
    await api(port, cookie, "POST", "/api/logins/start", {
      kind: "claude",
      name: "Work",
    }),
  );
  const loginId = started.loginId as string;
  const accountId = started.accountId as string;
  assert.deepEqual(await accountsOf(port, cookie), [
    { id: accountId, provider: "claude", name: "Work", needsLogin: true },
  ]);
  const head = json(
    await api(
      port,
      cookie,
      "GET",
      `/api/logins/read?login=${loginId}&cursor=0`,
    ),
  );
  assert.equal(head.state, "running");
  assert.match(head.output as string, /claude\.com\/cai\/oauth\/authorize/);
  assert.equal(head.device, undefined);
  const tail = json(
    await api(
      port,
      cookie,
      "GET",
      `/api/logins/read?login=${loginId}&cursor=${String(head.cursor)}`,
    ),
  );
  assert.equal(tail.output, "");
  assert.equal(
    (
      await api(port, cookie, "POST", "/api/logins/input", {
        loginId,
        text: "pasted-code",
      })
    ).status,
    204,
  );
  assert.deepEqual(runs[0]!.inputs, ["pasted-code"]);
  await readUntil(port, cookie, loginId, "ready");
  assert.deepEqual(await accountsOf(port, cookie), [
    { id: accountId, provider: "claude", name: "Work", needsLogin: false },
  ]);

  // ChatGPT: the device once both parts are known.
  const codex = json(
    await api(port, cookie, "POST", "/api/logins/start", {
      kind: "openai-codex",
    }),
  );
  await eventually(async () => {
    const view = json(
      await api(
        port,
        cookie,
        "GET",
        `/api/logins/read?login=${String(codex.loginId)}`,
      ),
    );
    assert.deepEqual(view.device, {
      verificationUri: "https://auth.example/device",
      userCode: "ABCD-1234",
    });
  });
});

test("AC7/AC8: cancel ends a login and drops its new account after the driver settled; another session gets 404; remove goes everywhere", async () => {
  const { runs, drivers } = fakeDrivers(true);
  const { edge, port, signIn: edgeSignIn } = await edgeWithUi(drivers);
  const cookie = await edgeSignIn();
  const other = await edgeSignIn();
  const started = json(
    await api(port, cookie, "POST", "/api/logins/start", { kind: "claude" }),
  );
  const loginId = started.loginId as string;
  const accountId = started.accountId as string;
  for (const path of ["/api/logins/cancel", "/api/logins/input"]) {
    const answer = await api(port, other, "POST", path, { loginId, text: "x" });
    assert.equal(answer.status, 404);
    assert.deepEqual(json(answer), { error: "unknown_login" });
  }
  assert.equal(
    (await api(port, other, "GET", `/api/logins/read?login=${loginId}`)).status,
    404,
  );
  assert.equal(runs[0]!.cancels, 0);
  assert.equal(
    (await api(port, cookie, "POST", "/api/logins/cancel", { loginId })).status,
    204,
  );
  assert.equal(runs[0]!.cancels, 1);
  // Withdrawn but unsettled: still listed, still running.
  assert.equal((await accountsOf(port, cookie)).length, 1);
  runs[0]!.release();
  await readUntil(port, cookie, loginId, "cancelled");
  await eventually(async () =>
    assert.deepEqual(await accountsOf(port, cookie), []),
  );
  assert.equal(edge.gateway.clients!.registry.ownerOf(accountId), undefined);

  // Remove: a logged-in account leaves the registry and the profiles.
  const next = json(
    await api(port, cookie, "POST", "/api/logins/start", { kind: "claude" }),
  );
  await api(port, cookie, "POST", "/api/logins/input", {
    loginId: next.loginId,
    text: "code",
  });
  await readUntil(port, cookie, next.loginId as string, "ready");
  assert.equal(
    (
      await api(port, other, "POST", "/api/accounts/remove", {
        accountId: "claude-unknown",
      })
    ).status,
    404,
  );
  assert.equal(
    (
      await api(port, cookie, "POST", "/api/accounts/remove", {
        accountId: next.accountId,
      })
    ).status,
    204,
  );
  assert.deepEqual(await accountsOf(port, cookie), []);
  assert.equal(
    edge.gateway.clients!.registry.ownerOf(next.accountId as string),
    undefined,
  );
});

test("AC10: sign-out, expiry and eviction cancel a session's driver; a late success after expiry installs nothing", async () => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  const { runs, drivers } = fakeDrivers(true);
  const { port, signIn: edgeSignIn } = await edgeWithUi(drivers);

  // Sign-out.
  const a = await edgeSignIn();
  await api(port, a, "POST", "/api/logins/start", { kind: "claude" });
  await request(port, "/auth/logout", {
    method: "POST",
    headers: { cookie: a, ...MUTATION },
  });
  assert.equal(runs[0]!.cancels, 1);
  runs[0]!.release();

  // Expiry, found by the sweep's timer with no request; the driver then
  // completes, but the session ended first.
  const b = await edgeSignIn();
  const late = json(
    await api(port, b, "POST", "/api/logins/start", { kind: "claude" }),
  );
  clock += 12 * HOUR;
  runs[1]!.complete();
  await vi.advanceTimersByTimeAsync(60_000);
  assert.equal(runs[1]!.cancels, 1);
  const c = await edgeSignIn();
  await eventually(async () =>
    assert.ok(
      !(await accountsOf(port, c)).some((acc) => acc.id === late.accountId),
    ),
  );

  // Eviction: the user's 17th session drops the first.
  const first = c;
  await api(port, first, "POST", "/api/logins/start", { kind: "claude" });
  const evictedRun = runs.at(-1)!;
  for (let i = 0; i < 15; i++) await edgeSignIn();
  assert.equal(evictedRun.cancels, 0);
  await edgeSignIn();
  assert.equal(evictedRun.cancels, 1);
});

test("AC15: a driver failure reaches the browser as a reason code only", async () => {
  const { runs, drivers } = fakeDrivers();
  const { port, signIn: edgeSignIn } = await edgeWithUi(drivers);
  const cookie = await edgeSignIn();
  const started = json(
    await api(port, cookie, "POST", "/api/logins/start", { kind: "claude" }),
  );
  runs[0]!.fail(`provider said ${MARKER}`);
  const view = await readUntil(
    port,
    cookie,
    started.loginId as string,
    "error",
  );
  assert.equal(view.reason, "failed");
  // The output is the login's own content, the URL included; nothing else.
  const { output: _output, ...rest } = view;
  assert.ok(!JSON.stringify(rest).includes("MARKER"));
});
