/**
 * "Sign in with Slack" on the gateway page (Task-1453): the connect start,
 * `/auth/slack/callback`, the status and the clear over a fake
 * `GatewayWebIntegrations`. The start's gate and authorize URL (user scopes
 * only, the `team` hint only from config), the callback's one-use state
 * bound to its cookie and its user, every fixed `?slack=` code, the
 * connect's socket bound, the separation from "Sign in with Atlassian" in
 * both directions, the display rule on the workspace's name, and that the
 * state, code, provider text and name reach nowhere else. Every value is
 * fake.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type http from "node:http";
import https from "node:https";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, test, vi } from "vitest";
import type { GatewayUiSlack } from "@assistant/shared/gatewayUi";
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
import { FAKE_SLACK_CLIENT, FAKE_SLACK_CODE } from "../test/slackFake.ts";
import type { GatewayWebAccounts } from "./accounts.ts";
import type { GatewayWebClients } from "./clients.ts";
import type { AtlassianPreset, SlackPreset } from "./config.ts";
import {
  IntegrationsRefusal,
  type GatewayWebIntegrations,
  type IntegrationsRefusalCode,
} from "./integrations.ts";
import { PENDING_TTL_MS } from "./sessions.ts";
import { startGatewayWeb } from "./server.ts";

const SLACK_COOKIE = "__Host-pgw_slack";
const ATLASSIAN_COOKIE = "__Host-pgw_atlassian";
const CALLBACK = `${PUBLIC_ORIGIN}/auth/slack/callback`;
const ATLASSIAN_CALLBACK = `${PUBLIC_ORIGIN}/auth/atlassian/callback`;
const TEAM_ID = "TFAKE0001";
/** Task-1420 R6, in that order. */
const R6_SCOPES = [
  "search:read",
  "channels:history",
  "groups:history",
  "im:history",
  "mpim:history",
  "channels:read",
  "groups:read",
  "im:read",
  "mpim:read",
  "files:read",
  "users:read",
  "users:read.email",
  "usergroups:read",
];
const PROVIDER_TEXT = "FAKE_SLACK_PROVIDER_TEXT_SENTINEL";
const UNSAFE_TEAM_NAME = "Fake\u001b[2JWork\u202espace";
const UNSAFE_NAME_PART = "Work\u202espace";

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

type Provider = "slack" | "atlassian";
const COOKIE: Record<Provider, string> = {
  slack: SLACK_COOKIE,
  atlassian: ATLASSIAN_COOKIE,
};

function post(
  port: number,
  path: string,
  session: string | undefined,
  headers: Record<string, string> = MUTATION,
): Promise<Answer> {
  return request(port, path, {
    method: "POST",
    headers: {
      ...headers,
      ...(session ? { cookie: session } : {}),
      "content-type": "application/json",
    },
    body: "{}",
  });
}

/** POSTs a connect start with the given headers (default: the gate's). */
function start(
  port: number,
  session: string | undefined,
  headers: Record<string, string> = MUTATION,
  provider: Provider = "slack",
): Promise<Answer> {
  return post(port, `/api/integrations/${provider}/connect`, session, headers);
}

/** A started connect: the state, the browser's pending cookie pair. */
async function started(
  port: number,
  session: string,
  provider: Provider = "slack",
) {
  const answer = await start(port, session, MUTATION, provider);
  assert.equal(answer.status, 200);
  const url = new URL(
    (JSON.parse(answer.body) as { authorizeUrl: string }).authorizeUrl,
  );
  const state = url.searchParams.get("state")!;
  const value = cookieValue(answer, COOKIE[provider])!;
  const pending = `${COOKIE[provider]}=${value}`;
  return { answer, url, state, value, pending };
}

function callback(
  port: number,
  query: Record<string, string>,
  cookies: (string | undefined)[],
  provider: Provider = "slack",
): Promise<Answer> {
  const cookie = cookies.filter((c) => c !== undefined).join("; ");
  return request(
    port,
    `/auth/${provider}/callback?${new URLSearchParams(query).toString()}`,
    cookie === "" ? {} : { headers: { cookie } },
  );
}

/** The callback's 303: its location, and that it cleared its cookie. */
function redirected(answer: Answer, provider: Provider = "slack"): string {
  assert.equal(answer.status, 303);
  assert.equal(answer.headers["cache-control"], "no-store");
  const cleared = setCookie(answer, COOKIE[provider]);
  assert.ok(cleared, "the pending cookie is cleared");
  assert.match(
    cleared,
    new RegExp(`^${COOKIE[provider]}=; Path=/; .*Max-Age=0$`),
  );
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

/** A fake seam: every call recorded, answered as told, a connect held. */
function fakeIntegrations() {
  const calls: { op: string; userId: string; request?: unknown }[] = [];
  let refusal: IntegrationsRefusalCode | Error | undefined;
  let holdMs = 0;
  let status: Omit<GatewayUiSlack, "offered"> = { connected: false };
  const fail = () => {
    if (refusal instanceof Error) throw refusal;
    if (refusal) throw new IntegrationsRefusal(refusal);
  };
  const integrations: GatewayWebIntegrations = {
    status: () => Promise.resolve({ connected: false, connectWith: "oauth" }),
    set: () =>
      Promise.reject(new IntegrationsRefusal("integration_sign_in_required")),
    clear: () => Promise.resolve(),
    connect: async (userId, request) => {
      calls.push({ op: "connect", userId, request });
      fail();
      return { connected: true, kind: "oauth", connectWith: "oauth" };
    },
    slackStatus: async (userId) => {
      calls.push({ op: "slackStatus", userId });
      fail();
      return status;
    },
    connectSlack: async (userId, request) => {
      calls.push({ op: "connectSlack", userId, request });
      if (holdMs) await new Promise((resolve) => setTimeout(resolve, holdMs));
      fail();
    },
    clearSlack: async (userId) => {
      calls.push({ op: "clearSlack", userId });
      fail();
    },
    githubStatus: () => Promise.reject(new Error("unused")),
    connectGithub: () => Promise.reject(new Error("unused")),
    clearGithub: () => Promise.reject(new Error("unused")),
    checkGithub: () => Promise.reject(new Error("unused")),
  };
  return {
    integrations,
    calls,
    ops: (op: string) => calls.filter((call) => call.op === op),
    refuse: (code: IntegrationsRefusalCode | Error | undefined) =>
      (refusal = code),
    hold: (ms: number) => (holdMs = ms),
    answer: (next: Omit<GatewayUiSlack, "offered">) => (status = next),
  };
}

async function startUi(
  options: {
    slack?: SlackPreset | null;
    atlassian?: AtlassianPreset;
    now?: () => number;
    testIdleMs?: { idle: number; integration: number; connect?: number };
  } = {},
) {
  const fake = fakeIntegrations();
  const slack =
    options.slack === undefined
      ? { clientId: FAKE_SLACK_CLIENT.clientId, userScopes: R6_SCOPES }
      : options.slack;
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
      ...(slack ? { slack } : {}),
      ...(options.atlassian ? { atlassian: options.atlassian } : {}),
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
    requests: { since: () => ({ epoch: "", requests: [] }) },
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
  // Neither code, the provider's text nor an unsafe name reached an answer
  // or a line.
  const secrets = [FAKE_SLACK_CODE, FAKE_CODE, PROVIDER_TEXT, UNSAFE_NAME_PART];
  for (const answer of answers)
    for (const secret of secrets)
      assert.ok(
        !answer.body.includes(secret) &&
          !JSON.stringify(answer.headers).includes(secret),
        `an answer leaked: ${answer.path}`,
      );
  for (const line of logs)
    for (const secret of [...secrets, "Fake Workspace"])
      assert.ok(!line.includes(secret), `a log line leaked: ${line}`);
});

// --- without slack.clientId -------------------------------------------------

test("without slack.clientId the Slack routes are 404 and status answers offered:false without the adapter", async () => {
  for (const slack of [null, { userScopes: R6_SCOPES, teamId: TEAM_ID }]) {
    const { port, fake } = await startUi({ slack });
    const session = await signIn(port);
    const status = await request(port, "/api/integrations/slack", {
      headers: { cookie: session },
    });
    assert.equal(status.status, 200);
    assert.deepEqual(JSON.parse(status.body), {
      offered: false,
      connected: false,
    });
    const none = await start(port, session);
    assert.equal(none.status, 404);
    assert.equal(setCookie(none, SLACK_COOKIE), undefined);
    assert.equal(
      (await post(port, "/api/integrations/slack/clear", session)).status,
      404,
    );
    const back = await callback(port, { code: FAKE_SLACK_CODE, state: "x" }, [
      session,
    ]);
    assert.equal(back.status, 404);
    assert.equal(back.headers.location, undefined);
    assert.deepEqual(fake.calls, []);
  }
});

// --- the start --------------------------------------------------------------

test("the start needs Origin, the header and a session, and is 404 by GET", async () => {
  const { port } = await startUi();
  const session = await signIn(port);
  for (const headers of [
    { "x-gateway-ui": "1" },
    { origin: "https://evil.test", "x-gateway-ui": "1" },
    { origin: PUBLIC_ORIGIN },
  ]) {
    const refused = await start(port, session, headers);
    assert.equal(refused.status, 403);
    assert.equal(setCookie(refused, SLACK_COOKIE), undefined);
  }
  const signedOut = await start(port, undefined);
  assert.equal(signedOut.status, 401);
  assert.equal(setCookie(signedOut, SLACK_COOKIE), undefined);
  const byGet = await request(port, "/api/integrations/slack/connect", {
    headers: { cookie: session },
  });
  assert.equal(byGet.status, 404);
  assert.equal(setCookie(byGet, SLACK_COOKIE), undefined);
  for (const path of [
    "/api/integrations/slack",
    "/api/integrations/slack/clear",
  ])
    assert.equal(
      (await request(port, path, { headers: { cookie: "x=1" } })).status,
      401,
    );
});

test("the start answers Slack's authorize URL with user_scope only, no team without teamId, and sets the pending cookie", async () => {
  const { port } = await startUi();
  const session = await signIn(port);
  const first = await started(port, session);
  assert.equal(first.answer.headers["cache-control"], "no-store");
  assert.equal(
    `${first.url.origin}${first.url.pathname}`,
    "https://slack.com/oauth/v2/authorize",
  );
  assert.deepEqual([...first.url.searchParams.keys()].sort(), [
    "client_id",
    "redirect_uri",
    "state",
    "user_scope",
  ]);
  assert.equal(first.url.searchParams.get("scope"), null);
  assert.equal(
    first.url.searchParams.get("client_id"),
    FAKE_SLACK_CLIENT.clientId,
  );
  assert.equal(first.url.searchParams.get("user_scope"), R6_SCOPES.join(","));
  assert.equal(first.url.searchParams.get("redirect_uri"), CALLBACK);
  // 32 random bytes, base64url.
  assert.match(first.state, /^[A-Za-z0-9_-]{43}$/);
  assert.match(
    setCookie(first.answer, SLACK_COOKIE)!,
    /^__Host-pgw_slack=[A-Za-z0-9_-]{43}; Path=\/; Secure; HttpOnly; SameSite=Lax; Max-Age=600$/,
  );
  assert.ok(!setCookie(first.answer, SLACK_COOKIE)!.includes("Domain"));
  assert.notEqual(first.value, first.state);
  const second = await started(port, session);
  assert.notEqual(second.state, first.state);
  assert.notEqual(second.value, first.value);
  assert.ok(logs.includes("ui slack connect: started user=u1"));
  for (const line of logs)
    for (const value of [first.state, second.state, first.value, second.value])
      assert.ok(!line.includes(value), line);
});

test("with slack.teamId the authorize URL carries it as team", async () => {
  const { port } = await startUi({
    slack: {
      clientId: FAKE_SLACK_CLIENT.clientId,
      teamId: TEAM_ID,
      userScopes: ["search:read", "files:read"],
    },
  });
  const session = await signIn(port);
  const { url } = await started(port, session);
  assert.deepEqual([...url.searchParams.keys()].sort(), [
    "client_id",
    "redirect_uri",
    "state",
    "team",
    "user_scope",
  ]);
  assert.equal(url.searchParams.get("team"), TEAM_ID);
  assert.equal(url.searchParams.get("user_scope"), "search:read,files:read");
});

test("a full pending table refuses the start with 503 and no cookie", async () => {
  const { port } = await startUi();
  const session = await signIn(port);
  for (let i = 0; i < 256; i++) await started(port, session);
  const full = await start(port, session);
  assert.equal(full.status, 503);
  assert.deepEqual(JSON.parse(full.body), { error: "unavailable" });
  assert.equal(setCookie(full, SLACK_COOKIE), undefined);
  assert.ok(logs.includes("ui slack connect: refused, busy user=u1"));
});

// --- the callback -----------------------------------------------------------

test("the callback connects with exactly the code and the public-origin redirect URI, then goes to / once", async () => {
  const { port, fake } = await startUi();
  const session = await signIn(port);
  const { state, pending } = await started(port, session);
  const done = await callback(port, { code: FAKE_SLACK_CODE, state }, [
    session,
    pending,
  ]);
  assert.equal(redirected(done), "/");
  assert.deepEqual(fake.calls, [
    {
      op: "connectSlack",
      userId: "u1",
      request: { code: FAKE_SLACK_CODE, redirectUri: CALLBACK },
    },
  ]);
  assert.ok(logs.includes("ui slack connect: ok user=u1"));
  const replay = await callback(port, { code: FAKE_SLACK_CODE, state }, [
    session,
    pending,
  ]);
  assert.equal(redirected(replay), "/?slack=failed");
  assert.equal(fake.calls.length, 1);
});

test("with slack.teamId the connect passes it as team; the redirect URI never comes from the Host header", async () => {
  const { port, fake } = await startUi({
    slack: {
      clientId: FAKE_SLACK_CLIENT.clientId,
      teamId: TEAM_ID,
      userScopes: R6_SCOPES,
    },
  });
  const session = await signIn(port);
  const { state, pending } = await started(port, session);
  const answer = await request(
    port,
    `/auth/slack/callback?${new URLSearchParams({ code: FAKE_SLACK_CODE, state })}`,
    { headers: { cookie: `${session}; ${pending}`, host: "evil.test" } },
  );
  assert.equal(redirected(answer), "/");
  assert.deepEqual(fake.ops("connectSlack"), [
    {
      op: "connectSlack",
      userId: "u1",
      request: { code: FAKE_SLACK_CODE, redirectUri: CALLBACK, team: TEAM_ID },
    },
  ]);
});

test("the state is bound to its cookie and its user: another start's cookie, no cookie or another user fails without a connect", async () => {
  const { port, fake } = await startUi();
  const session = await signIn(port);
  const other = await signIn(port, "subject-2");
  const a = await started(port, session);
  const b = await started(port, session);
  assert.equal(
    redirected(
      await callback(port, { code: FAKE_SLACK_CODE, state: a.state }, [
        session,
        b.pending,
      ]),
    ),
    "/?slack=failed",
  );
  // The state is spent.
  assert.equal(
    redirected(
      await callback(port, { code: FAKE_SLACK_CODE, state: a.state }, [
        session,
        a.pending,
      ]),
    ),
    "/?slack=failed",
  );
  // No cookie: expired.
  assert.equal(
    redirected(
      await callback(port, { code: FAKE_SLACK_CODE, state: b.state }, [
        session,
      ]),
    ),
    "/?slack=expired",
  );
  const d = await started(port, session);
  assert.equal(
    redirected(
      await callback(port, { code: FAKE_SLACK_CODE, state: d.state }, [
        other,
        d.pending,
      ]),
    ),
    "/?slack=failed",
  );
  assert.deepEqual(fake.calls, []);
  assert.ok(logs.includes("ui slack connect: failed (state) user=u2"));
});

test("signed out, the callback answers signed_out and still spends the state", async () => {
  const { port, fake } = await startUi();
  const session = await signIn(port);
  const { state, pending } = await started(port, session);
  assert.equal(
    redirected(
      await callback(port, { code: FAKE_SLACK_CODE, state }, [pending]),
    ),
    "/?slack=signed_out",
  );
  assert.equal(
    redirected(
      await callback(port, { code: FAKE_SLACK_CODE, state }, [
        session,
        pending,
      ]),
    ),
    "/?slack=failed",
  );
  assert.deepEqual(fake.calls, []);
  assert.ok(logs.includes("ui slack connect: failed (signed_out)"));
});

test("a start older than ten minutes is expired", async () => {
  let skew = 0;
  const { port, fake } = await startUi({ now: () => Date.now() + skew });
  const session = await signIn(port);
  const { state, pending } = await started(port, session);
  skew = PENDING_TTL_MS;
  assert.equal(
    redirected(
      await callback(port, { code: FAKE_SLACK_CODE, state }, [
        session,
        pending,
      ]),
    ),
    "/?slack=expired",
  );
  assert.deepEqual(fake.calls, []);
});

test("Slack's error answers denied or failed and its text goes nowhere; a missing or malformed code fails", async () => {
  const { port, fake } = await startUi();
  const session = await signIn(port);
  const cases: [Record<string, string>, string][] = [
    [{ error: "access_denied" }, "/?slack=denied"],
    [{ error: PROVIDER_TEXT }, "/?slack=failed"],
    [
      {
        error: PROVIDER_TEXT,
        error_description: PROVIDER_TEXT,
        code: FAKE_SLACK_CODE,
      },
      "/?slack=failed",
    ],
    [{}, "/?slack=failed"],
    [{ code: "" }, "/?slack=failed"],
    [{ code: `${FAKE_SLACK_CODE} x` }, "/?slack=failed"],
    [{ code: `${FAKE_SLACK_CODE}é` }, "/?slack=failed"],
    [{ code: "x".repeat(8_193) }, "/?slack=failed"],
  ];
  for (const [query, location] of cases) {
    const { state, pending } = await started(port, session);
    assert.equal(
      redirected(await callback(port, { ...query, state }, [session, pending])),
      location,
      JSON.stringify(query),
    );
  }
  // 8,192 printable characters are still a code.
  const { state, pending } = await started(port, session);
  assert.equal(
    redirected(
      await callback(port, { code: "x".repeat(8_192), state }, [
        session,
        pending,
      ]),
    ),
    "/",
  );
  assert.equal(fake.calls.length, 1);
  assert.ok(logs.includes("ui slack connect: failed (denied) user=u1"));
});

test("each connect refusal maps to its fixed code; anything else thrown is failed", async () => {
  const { port, fake } = await startUi();
  const session = await signIn(port);
  const cases: [IntegrationsRefusalCode | Error, string][] = [
    ["integration_rejected", "rejected"],
    ["integration_unreachable", "unreachable"],
    ["integration_team_mismatch", "team_mismatch"],
    ["integration_not_configured", "not_configured"],
    ["vault_locked", "vault_locked"],
    ["vault_unavailable", "vault_unavailable"],
    ["integration_busy", "busy"],
    ["tools_unavailable", "tools_unavailable"],
    ["integration_site_missing", "failed"],
    ["integration_invalid", "failed"],
    [new Error(PROVIDER_TEXT), "failed"],
  ];
  for (const [refusal, code] of cases) {
    fake.refuse(refusal);
    const { state, pending } = await started(port, session);
    assert.equal(
      redirected(
        await callback(port, { code: FAKE_SLACK_CODE, state }, [
          session,
          pending,
        ]),
      ),
      `/?slack=${code}`,
    );
    assert.ok(
      logs.includes(`ui slack connect: failed (${code}) user=u1`),
      code,
    );
  }
  assert.equal(fake.calls.length, cases.length);
});

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
  const answer = await callback(port, { code: FAKE_SLACK_CODE, state }, [
    session,
    pending,
  ]);
  assert.equal(redirected(answer), "/");
  assert.deepEqual(bounds.slice(-2), [3_000, 300]);
});

// --- provider separation (O1) -----------------------------------------------

const ATLASSIAN: AtlassianPreset = {
  emailFromSignIn: false,
  clientId: FAKE_CLIENT.clientId,
  scopes: ["read:jira-work", "offline_access"],
};

test("an Atlassian state never completes on the Slack callback, and the Atlassian flow still completes", async () => {
  const { port, fake } = await startUi({ atlassian: ATLASSIAN });
  const session = await signIn(port);
  // (i) With its own cookie on the Slack callback: no Slack pending cookie.
  const a = await started(port, session, "atlassian");
  assert.equal(
    redirected(
      await callback(port, { code: FAKE_SLACK_CODE, state: a.state }, [
        session,
        a.pending,
      ]),
    ),
    "/?slack=expired",
  );
  // (ii) With its cookie value under the Slack cookie's name.
  assert.equal(
    redirected(
      await callback(port, { code: FAKE_SLACK_CODE, state: a.state }, [
        session,
        `${SLACK_COOKIE}=${a.value}`,
      ]),
    ),
    "/?slack=failed",
  );
  assert.deepEqual(fake.calls, []);
  // Its state was never in the Slack table: the Atlassian flow completes.
  assert.equal(
    redirected(
      await callback(
        port,
        { code: FAKE_CODE, state: a.state },
        [session, a.pending],
        "atlassian",
      ),
      "atlassian",
    ),
    "/",
  );
  assert.deepEqual(fake.calls, [
    {
      op: "connect",
      userId: "u1",
      request: { code: FAKE_CODE, redirectUri: ATLASSIAN_CALLBACK },
    },
  ]);
});

test("a Slack state never completes on the Atlassian callback, and the Slack flow still completes", async () => {
  const { port, fake } = await startUi({ atlassian: ATLASSIAN });
  const session = await signIn(port);
  const s = await started(port, session, "slack");
  assert.equal(
    redirected(
      await callback(
        port,
        { code: FAKE_CODE, state: s.state },
        [session, s.pending],
        "atlassian",
      ),
      "atlassian",
    ),
    "/?atlassian=expired",
  );
  assert.equal(
    redirected(
      await callback(
        port,
        { code: FAKE_CODE, state: s.state },
        [session, `${ATLASSIAN_COOKIE}=${s.value}`],
        "atlassian",
      ),
      "atlassian",
    ),
    "/?atlassian=failed",
  );
  assert.deepEqual(fake.calls, []);
  assert.equal(
    redirected(
      await callback(port, { code: FAKE_SLACK_CODE, state: s.state }, [
        session,
        s.pending,
      ]),
    ),
    "/",
  );
  assert.deepEqual(fake.calls, [
    {
      op: "connectSlack",
      userId: "u1",
      request: { code: FAKE_SLACK_CODE, redirectUri: CALLBACK },
    },
  ]);
});

// --- status and clear -------------------------------------------------------

test("status passes connected, teamName and problem through for the session's user", async () => {
  const { port, fake } = await startUi();
  const session = await signIn(port);
  const read = async () => {
    const answer = await request(port, "/api/integrations/slack", {
      headers: { cookie: session },
    });
    assert.equal(answer.status, 200);
    assert.equal(answer.headers["cache-control"], "no-store");
    return JSON.parse(answer.body) as unknown;
  };
  assert.deepEqual(await read(), { offered: true, connected: false });
  fake.answer({ connected: true, teamName: "Fake Workspace" });
  assert.deepEqual(await read(), {
    offered: true,
    connected: true,
    teamName: "Fake Workspace",
  });
  for (const problem of [
    "vault_locked",
    "vault_unavailable",
    "invalid",
    "rejected",
  ] as const) {
    fake.answer({ connected: false, problem });
    assert.deepEqual(await read(), {
      offered: true,
      connected: false,
      problem,
    });
  }
  assert.ok(fake.calls.every((call) => call.userId === "u1"));
  fake.refuse("vault_locked");
  const refused = await request(port, "/api/integrations/slack", {
    headers: { cookie: session },
  });
  assert.equal(refused.status, 503);
  assert.deepEqual(JSON.parse(refused.body), { error: "vault_locked" });
});

test("F004: a workspace name the page could not show safely is dropped from the status", async () => {
  const { port, fake } = await startUi();
  const session = await signIn(port);
  for (const teamName of [UNSAFE_TEAM_NAME, "", "   ", "x".repeat(257)]) {
    fake.answer({ connected: true, teamName });
    const answer = await request(port, "/api/integrations/slack", {
      headers: { cookie: session },
    });
    assert.deepEqual(JSON.parse(answer.body), {
      offered: true,
      connected: true,
    });
  }
});

test("clear answers 204 behind the gate and logs the fixed line; a busy slot is 409", async () => {
  const { port, fake } = await startUi();
  const session = await signIn(port);
  const forbidden = await post(port, "/api/integrations/slack/clear", session, {
    "x-gateway-ui": "1",
  });
  assert.equal(forbidden.status, 403);
  assert.deepEqual(fake.calls, []);
  const cleared = await post(port, "/api/integrations/slack/clear", session);
  assert.equal(cleared.status, 204);
  assert.deepEqual(fake.calls, [{ op: "clearSlack", userId: "u1" }]);
  assert.ok(logs.includes("ui integration slack: cleared user=u1"));
  fake.refuse("integration_busy");
  const busy = await post(port, "/api/integrations/slack/clear", session);
  assert.equal(busy.status, 409);
  assert.deepEqual(JSON.parse(busy.body), { error: "integration_busy" });
  // Other methods and paths under the Slack prefix are 404.
  assert.equal(
    (await post(port, "/api/integrations/slack", session)).status,
    404,
  );
  assert.equal(
    (
      await request(port, "/api/integrations/slack/clear", {
        headers: { cookie: session },
      })
    ).status,
    404,
  );
});

test("the state appears only in its start's authorize URL: in no other answer, header, redirect or log line", async () => {
  const { port, fake } = await startUi();
  const session = await signIn(port);
  const from = answers.length;
  const fromLog = logs.length;
  const states: string[] = [];
  const ok = await started(port, session);
  states.push(ok.state);
  await callback(port, { code: FAKE_SLACK_CODE, state: ok.state }, [
    session,
    ok.pending,
  ]);
  await callback(port, { code: FAKE_SLACK_CODE, state: ok.state }, [
    session,
    ok.pending,
  ]);
  fake.refuse("integration_team_mismatch");
  const refused = await started(port, session);
  states.push(refused.state);
  await callback(port, { code: FAKE_SLACK_CODE, state: refused.state }, [
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
