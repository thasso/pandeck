/**
 * "Sign in with Atlassian" on the gateway page (Task-1411 PR2): the connect
 * start and `/auth/atlassian/callback` over a fake `GatewayWebIntegrations`.
 * The start's gate and authorize URL (compared with the config fixture and
 * Atlassian's documented parameters), the callback's one-use state bound to
 * its cookie and its user, every fixed `?atlassian=` code, the connect's
 * socket bound, and that the state, code and provider text reach nowhere
 * else. Every value is fake.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type http from "node:http";
import https from "node:https";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, test, vi } from "vitest";
import { edgeTlsFor } from "../gateway/x509.ts";
import { FAKE_CLIENT, FAKE_CODE } from "../test/atlassianFake.ts";
import {
  CLIENT_ID,
  CLIENT_PW,
  EMAIL,
  PUBLIC_ORIGIN,
  startFakeIssuer,
  type FakeIssuer,
} from "../test/gatewayUiIssuer.ts";
import type { GatewayWebAccounts } from "./accounts.ts";
import type { GatewayWebClients } from "./clients.ts";
import type { AtlassianPreset } from "./config.ts";
import {
  IntegrationsRefusal,
  type GatewayWebIntegrations,
  type IntegrationsRefusalCode,
} from "./integrations.ts";
import { PENDING_TTL_MS } from "./sessions.ts";
import { startGatewayWeb } from "./server.ts";

const COOKIE = "__Host-pgw_atlassian";
const CALLBACK = `${PUBLIC_ORIGIN}/auth/atlassian/callback`;
const PRESET_SITE = "fake-preset.atlassian.net";
/** The config fixture's scopes, and the authorize URL's `scope` for them. */
const SCOPES = ["read:jira-work", "write:jira-work", "offline_access"];
const SCOPE_PARAM = "read:jira-work write:jira-work offline_access";
const DESCRIPTION_SENTINEL = "FAKE_PROVIDER_TEXT_SENTINEL";

const edgeTls = edgeTlsFor(["localhost", "127.0.0.1"], undefined);
const agent = new https.Agent({ ca: edgeTls.caCertPem, keepAlive: true });
let issuer: FakeIssuer;
let distDir: string;
const logs: string[] = [];
const answers: Answer[] = [];
const open: { close(): Promise<void> | void }[] = [];

interface Answer {
  path: string;
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
        // The certificate is checked against this, not a test's Host header.
        servername: "localhost",
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
          const answer = {
            path,
            status: res.statusCode ?? 0,
            headers: res.headers,
            body,
          };
          answers.push(answer);
          resolve(answer);
        });
      },
    );
    req.on("error", reject);
    req.end(options.body);
  });
}

function setCookie(answer: Answer, name: string): string | undefined {
  return (answer.headers["set-cookie"] ?? []).find((line) =>
    line.startsWith(`${name}=`),
  );
}

function cookieValue(answer: Answer, name: string): string | undefined {
  return setCookie(answer, name)
    ?.slice(name.length + 1)
    .split(";")[0];
}

/** A full sign-in as `sub`; answers the session cookie pair. */
async function signIn(port: number, sub = "subject-1"): Promise<string> {
  const login = await request(port, "/auth/login");
  const provider = new URL(login.headers.location!);
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

const MUTATION = { origin: PUBLIC_ORIGIN, "x-gateway-ui": "1" };

/** POSTs the connect start with the given headers (default: the gate's). */
function start(
  port: number,
  session: string | undefined,
  headers: Record<string, string> = MUTATION,
): Promise<Answer> {
  return request(port, "/api/integrations/atlassian/connect", {
    method: "POST",
    headers: {
      ...headers,
      ...(session ? { cookie: session } : {}),
      "content-type": "application/json",
    },
    body: "{}",
  });
}

/** A started connect: the state, the browser's pending cookie pair. */
async function started(port: number, session: string) {
  const answer = await start(port, session);
  assert.equal(answer.status, 200);
  const url = new URL(
    (JSON.parse(answer.body) as { authorizeUrl: string }).authorizeUrl,
  );
  const state = url.searchParams.get("state")!;
  const pending = `${COOKIE}=${cookieValue(answer, COOKIE)!}`;
  return { answer, url, state, pending };
}

function callback(
  port: number,
  query: Record<string, string>,
  cookies: (string | undefined)[],
): Promise<Answer> {
  const cookie = cookies.filter((c) => c !== undefined).join("; ");
  return request(
    port,
    `/auth/atlassian/callback?${new URLSearchParams(query).toString()}`,
    cookie === "" ? {} : { headers: { cookie } },
  );
}

/** The callback's 303: its location, and that it cleared the cookie. */
function redirected(answer: Answer): string {
  assert.equal(answer.status, 303);
  assert.equal(answer.headers["cache-control"], "no-store");
  const cleared = setCookie(answer, COOKIE);
  assert.ok(cleared, "the pending cookie is cleared");
  assert.match(cleared, /^__Host-pgw_atlassian=; Path=\/; .*Max-Age=0$/);
  return answer.headers.location!;
}

const NO_ACCOUNTS: GatewayWebAccounts = {
  list: () => [],
  remove: () => {},
  start: () => ({ loginId: "l", accountId: "a" }),
  input: () => {},
  cancel: () => {},
  read: () => ({ kind: "claude", state: "running", output: "", cursor: 0 }),
  endActor: () => {},
};

const NO_CLIENTS = {} as GatewayWebClients;

/** A fake seam: connect recorded, answered as told, optionally held. */
function fakeIntegrations() {
  const connects: { userId: string; request: unknown }[] = [];
  let refusal: IntegrationsRefusalCode | Error | undefined;
  let holdMs = 0;
  const integrations: GatewayWebIntegrations = {
    status: () => Promise.resolve({ connected: false, connectWith: "oauth" }),
    set: () =>
      Promise.reject(new IntegrationsRefusal("integration_sign_in_required")),
    clear: () => Promise.resolve(),
    connect: async (userId, request) => {
      connects.push({ userId, request });
      if (holdMs) await new Promise((resolve) => setTimeout(resolve, holdMs));
      if (refusal instanceof Error) throw refusal;
      if (refusal) throw new IntegrationsRefusal(refusal);
      return {
        connected: true,
        kind: "oauth",
        connectWith: "oauth",
        site: PRESET_SITE,
      };
    },
  };
  return {
    integrations,
    connects,
    refuse: (code: IntegrationsRefusalCode | Error | undefined) =>
      (refusal = code),
    hold: (ms: number) => (holdMs = ms),
  };
}

async function startUi(
  options: {
    atlassian?: AtlassianPreset | null;
    now?: () => number;
    testIdleMs?: { idle: number; integration: number; connect?: number };
  } = {},
) {
  const fake = fakeIntegrations();
  const atlassian =
    options.atlassian === undefined
      ? {
          site: PRESET_SITE,
          emailFromSignIn: false,
          clientId: FAKE_CLIENT.clientId,
          scopes: SCOPES,
        }
      : options.atlassian;
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
      ...(atlassian ? { atlassian } : {}),
    },
    users: {
      signIn: ({ subject }) => ({
        userId: subject === "subject-2" ? "u2" : "u1",
        outcome: "existing",
      }),
      user: (id) => ({ id, label: EMAIL, email: EMAIL }),
    },
    accounts: NO_ACCOUNTS,
    integrations: fake.integrations,
    clients: NO_CLIENTS,
    log: (line) => logs.push(line),
    oidcTestOptions: { allowInsecureRequests: true },
    ...(options.now ? { now: options.now } : {}),
    ...(options.testIdleMs ? { testIdleMs: options.testIdleMs } : {}),
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
  // Neither the code nor Atlassian's own text reached an answer or a line.
  for (const answer of answers)
    for (const secret of [FAKE_CODE, DESCRIPTION_SENTINEL])
      assert.ok(
        !answer.body.includes(secret) &&
          !JSON.stringify(answer.headers).includes(secret),
        `an answer leaked: ${answer.path}`,
      );
  for (const line of logs)
    for (const secret of [FAKE_CODE, DESCRIPTION_SENTINEL])
      assert.ok(!line.includes(secret), `a log line leaked: ${line}`);
});

// --- the start --------------------------------------------------------------

test("the start needs Origin, the header and a session, and is 404 by GET or without an OAuth client", async () => {
  const { port } = await startUi();
  const session = await signIn(port);
  for (const headers of [
    { "x-gateway-ui": "1" },
    { origin: "https://evil.test", "x-gateway-ui": "1" },
    { origin: PUBLIC_ORIGIN },
  ]) {
    const refused = await start(port, session, headers);
    assert.equal(refused.status, 403);
    assert.equal(setCookie(refused, COOKIE), undefined);
  }
  const signedOut = await start(port, undefined);
  assert.equal(signedOut.status, 401);
  assert.equal(setCookie(signedOut, COOKIE), undefined);
  const byGet = await request(port, "/api/integrations/atlassian/connect", {
    headers: { cookie: session },
  });
  assert.equal(byGet.status, 404);
  assert.equal(setCookie(byGet, COOKIE), undefined);

  for (const atlassian of [
    null,
    { emailFromSignIn: false, scopes: SCOPES },
  ] as const) {
    const plain = await startUi({ atlassian });
    const plainSession = await signIn(plain.port);
    const none = await start(plain.port, plainSession);
    assert.equal(none.status, 404);
    assert.equal(setCookie(none, COOKIE), undefined);
  }
});

test("the start answers Atlassian's authorize URL with exactly the documented parameters and sets the pending cookie", async () => {
  const { port } = await startUi();
  const session = await signIn(port);
  const first = await started(port, session);
  assert.equal(first.answer.headers["cache-control"], "no-store");
  assert.equal(
    `${first.url.origin}${first.url.pathname}`,
    "https://auth.atlassian.com/authorize",
  );
  assert.deepEqual([...first.url.searchParams.keys()].sort(), [
    "audience",
    "client_id",
    "prompt",
    "redirect_uri",
    "response_type",
    "scope",
    "state",
  ]);
  assert.equal(first.url.searchParams.get("audience"), "api.atlassian.com");
  assert.equal(first.url.searchParams.get("client_id"), FAKE_CLIENT.clientId);
  assert.equal(first.url.searchParams.get("scope"), SCOPE_PARAM);
  assert.equal(first.url.searchParams.get("redirect_uri"), CALLBACK);
  assert.equal(first.url.searchParams.get("response_type"), "code");
  assert.equal(first.url.searchParams.get("prompt"), "consent");
  assert.equal(first.url.searchParams.get("code_challenge"), null);
  // 32 random bytes, base64url.
  assert.match(first.state, /^[A-Za-z0-9_-]{43}$/);
  assert.match(
    setCookie(first.answer, COOKIE)!,
    /^__Host-pgw_atlassian=[A-Za-z0-9_-]{43}; Path=\/; Secure; HttpOnly; SameSite=Lax; Max-Age=600$/,
  );
  // The cookie id is not the state.
  assert.notEqual(cookieValue(first.answer, COOKIE), first.state);
  const second = await started(port, session);
  assert.notEqual(second.state, first.state);
  assert.notEqual(second.pending, first.pending);
  // No log line holds a state or a cookie id.
  for (const line of logs)
    for (const value of [
      first.state,
      second.state,
      first.pending,
      second.pending,
    ])
      assert.ok(!line.includes(value.replace(`${COOKIE}=`, "")), line);
});

test("a full pending table refuses the start with 503 and no cookie", async () => {
  const { port } = await startUi();
  const session = await signIn(port);
  for (let i = 0; i < 256; i++) await started(port, session);
  const full = await start(port, session);
  assert.equal(full.status, 503);
  assert.deepEqual(JSON.parse(full.body), { error: "unavailable" });
  assert.equal(setCookie(full, COOKIE), undefined);
});

// --- the callback -----------------------------------------------------------

test("the callback connects with the exact code, the public-origin redirect URI and the preset site, then goes to / once", async () => {
  const { port, fake } = await startUi();
  const session = await signIn(port);
  const { state, pending } = await started(port, session);
  const done = await callback(port, { code: FAKE_CODE, state }, [
    session,
    pending,
  ]);
  assert.equal(redirected(done), "/");
  assert.deepEqual(fake.connects, [
    {
      userId: "u1",
      request: { code: FAKE_CODE, redirectUri: CALLBACK, site: PRESET_SITE },
    },
  ]);
  assert.ok(logs.includes("ui atlassian connect: ok user=u1"));
  // Replayed: the state was used.
  const replay = await callback(port, { code: FAKE_CODE, state }, [
    session,
    pending,
  ]);
  assert.equal(redirected(replay), "/?atlassian=failed");
  assert.equal(fake.connects.length, 1);
});

test("without a preset site the callback passes none; the redirect URI never comes from the Host header", async () => {
  const { port, fake } = await startUi({
    atlassian: {
      emailFromSignIn: false,
      clientId: FAKE_CLIENT.clientId,
      scopes: SCOPES,
    },
  });
  const session = await signIn(port);
  const { state, pending } = await started(port, session);
  const answer = await request(
    port,
    `/auth/atlassian/callback?${new URLSearchParams({ code: FAKE_CODE, state })}`,
    { headers: { cookie: `${session}; ${pending}`, host: "evil.test" } },
  );
  assert.equal(redirected(answer), "/");
  assert.deepEqual(fake.connects, [
    { userId: "u1", request: { code: FAKE_CODE, redirectUri: CALLBACK } },
  ]);
});

test("the state is bound to its cookie and its user: another start's cookie, no cookie or another user fails without a connect", async () => {
  const { port, fake } = await startUi();
  const session = await signIn(port);
  const other = await signIn(port, "subject-2");

  const a = await started(port, session);
  const b = await started(port, session);
  // Another start's cookie: failed, and the state is spent.
  assert.equal(
    redirected(
      await callback(port, { code: FAKE_CODE, state: a.state }, [
        session,
        b.pending,
      ]),
    ),
    "/?atlassian=failed",
  );
  assert.equal(
    redirected(
      await callback(port, { code: FAKE_CODE, state: a.state }, [
        session,
        a.pending,
      ]),
    ),
    "/?atlassian=failed",
  );
  // No cookie: expired (the browser dropped it or never started).
  assert.equal(
    redirected(
      await callback(port, { code: FAKE_CODE, state: b.state }, [session]),
    ),
    "/?atlassian=expired",
  );
  // An unknown state with a cookie: failed.
  const c = await started(port, session);
  assert.equal(
    redirected(
      await callback(port, { code: FAKE_CODE, state: "FAKE-UNKNOWN-STATE" }, [
        session,
        c.pending,
      ]),
    ),
    "/?atlassian=failed",
  );
  // u1's state and cookie under u2's session: failed.
  const d = await started(port, session);
  assert.equal(
    redirected(
      await callback(port, { code: FAKE_CODE, state: d.state }, [
        other,
        d.pending,
      ]),
    ),
    "/?atlassian=failed",
  );
  assert.deepEqual(fake.connects, []);
  assert.ok(logs.includes("ui atlassian connect: failed (state) user=u2"));
});

test("signed out, the callback answers signed_out and still spends the state", async () => {
  const { port, fake } = await startUi();
  const session = await signIn(port);
  const { state, pending } = await started(port, session);
  assert.equal(
    redirected(await callback(port, { code: FAKE_CODE, state }, [pending])),
    "/?atlassian=signed_out",
  );
  assert.equal(
    redirected(
      await callback(port, { code: FAKE_CODE, state }, [session, pending]),
    ),
    "/?atlassian=failed",
  );
  assert.deepEqual(fake.connects, []);
  assert.ok(logs.includes("ui atlassian connect: failed (signed_out)"));
});

test("a start older than ten minutes is expired", async () => {
  let skew = 0;
  const { port, fake } = await startUi({ now: () => Date.now() + skew });
  const session = await signIn(port);
  const { state, pending } = await started(port, session);
  skew = PENDING_TTL_MS;
  assert.equal(
    redirected(
      await callback(port, { code: FAKE_CODE, state }, [session, pending]),
    ),
    "/?atlassian=expired",
  );
  assert.deepEqual(fake.connects, []);
});

test("Atlassian's error answers denied or failed and its text goes nowhere; a missing or malformed code fails", async () => {
  const { port, fake } = await startUi();
  const session = await signIn(port);
  const cases: [Record<string, string>, string][] = [
    [{ error: "access_denied" }, "/?atlassian=denied"],
    [
      { error: "server_error", error_description: DESCRIPTION_SENTINEL },
      "/?atlassian=failed",
    ],
    [
      {
        error: DESCRIPTION_SENTINEL,
        error_description: DESCRIPTION_SENTINEL,
        code: FAKE_CODE,
      },
      "/?atlassian=failed",
    ],
    [{}, "/?atlassian=failed"],
    [{ code: "" }, "/?atlassian=failed"],
    [{ code: `${FAKE_CODE} x` }, "/?atlassian=failed"],
    [{ code: `${FAKE_CODE}é` }, "/?atlassian=failed"],
    [{ code: `${FAKE_CODE}${"x".repeat(2_048)}` }, "/?atlassian=failed"],
  ];
  for (const [query, location] of cases) {
    const { state, pending } = await started(port, session);
    assert.equal(
      redirected(await callback(port, { ...query, state }, [session, pending])),
      location,
      JSON.stringify(query),
    );
  }
  assert.deepEqual(fake.connects, []);
});

test("each connect refusal maps to its fixed code; anything else thrown is failed", async () => {
  const { port, fake } = await startUi();
  const session = await signIn(port);
  const cases: [IntegrationsRefusalCode | Error, string][] = [
    ["integration_rejected", "rejected"],
    ["integration_unreachable", "unreachable"],
    ["integration_site_missing", "site_missing"],
    ["integration_site_ambiguous", "site_ambiguous"],
    ["integration_not_configured", "not_configured"],
    ["vault_locked", "vault_locked"],
    ["vault_unavailable", "vault_unavailable"],
    ["integration_busy", "busy"],
    ["tools_unavailable", "tools_unavailable"],
    ["integration_invalid", "failed"],
    [new Error(DESCRIPTION_SENTINEL), "failed"],
  ];
  for (const [refusal, code] of cases) {
    fake.refuse(refusal);
    const { state, pending } = await started(port, session);
    assert.equal(
      redirected(
        await callback(port, { code: FAKE_CODE, state }, [session, pending]),
      ),
      `/?atlassian=${code}`,
    );
    assert.ok(
      logs.includes(`ui atlassian connect: failed (${code}) user=u1`),
      code,
    );
  }
  assert.equal(fake.connects.length, cases.length);
});

test("without an OAuth client the callback is 404 and connects nothing", async () => {
  const { port, fake } = await startUi({ atlassian: null });
  const session = await signIn(port);
  const answer = await callback(port, { code: FAKE_CODE, state: "x" }, [
    session,
  ]);
  assert.equal(answer.status, 404);
  assert.equal(answer.headers.location, undefined);
  assert.deepEqual(fake.connects, []);
});

test("the state appears only in its start's authorize URL: in no other answer, header, redirect or log line", async () => {
  const { port, fake } = await startUi();
  const session = await signIn(port);
  const from = answers.length;
  const fromLog = logs.length;
  const states: string[] = [];
  // Success, a refusal, a replay and a provider error.
  const ok = await started(port, session);
  states.push(ok.state);
  await callback(port, { code: FAKE_CODE, state: ok.state }, [
    session,
    ok.pending,
  ]);
  await callback(port, { code: FAKE_CODE, state: ok.state }, [
    session,
    ok.pending,
  ]);
  fake.refuse("integration_rejected");
  const refused = await started(port, session);
  states.push(refused.state);
  await callback(port, { code: FAKE_CODE, state: refused.state }, [
    session,
    refused.pending,
  ]);
  const denied = await started(port, session);
  states.push(denied.state);
  await callback(port, { error: "access_denied", state: denied.state }, [
    session,
    denied.pending,
  ]);
  const later = answers.slice(from);
  for (const state of states) {
    const carrying = later.filter(
      (answer) =>
        answer.body.includes(state) ||
        JSON.stringify(answer.headers).includes(state),
    );
    assert.equal(carrying.length, 1);
    const url = new URL(
      (JSON.parse(carrying[0]!.body) as { authorizeUrl: string }).authorizeUrl,
    );
    assert.equal(url.searchParams.get("state"), state);
    assert.ok(!JSON.stringify(carrying[0]!.headers).includes(state));
    for (const line of logs.slice(fromLog))
      assert.ok(!line.includes(state), line);
  }
});

// --- the connect's socket bound (AC7) ---------------------------------------

test("a connect longer than the integration bound but shorter than the connect bound still gets its redirect", async () => {
  const { port, fake } = await startUi({
    testIdleMs: { idle: 300, integration: 600, connect: 3_000 },
  });
  const session = await signIn(port);
  const { state, pending } = await started(port, session);
  const bounds: number[] = [];
  const setTimeout = net.Socket.prototype.setTimeout;
  vi.spyOn(net.Socket.prototype, "setTimeout").mockImplementation(function (
    this: net.Socket,
    ms: number,
    ...rest: unknown[]
  ) {
    bounds.push(ms);
    return setTimeout.call(this, ms, ...(rest as [])) as net.Socket;
  });
  fake.hold(1_200);
  const answer = await callback(port, { code: FAKE_CODE, state }, [
    session,
    pending,
  ]);
  assert.equal(redirected(answer), "/");
  // Raised to the connect bound, then back to the baseline.
  assert.deepEqual(bounds.slice(-2), [3_000, 300]);
});
