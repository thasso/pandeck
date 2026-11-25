/**
 * "Connect GitHub" on the gateway page (Task-1445): the connect start,
 * `/auth/github/callback`, the status, the clear and the repository check
 * over a fake `GatewayWebIntegrations`. The start's gate and its authorize URL
 * (exactly `client_id`, `redirect_uri` and `state`), the callback's one-use
 * state bound to its cookie and its user, every fixed `?github=` code, the
 * separation from the Atlassian and Slack sign-ins in both directions, the
 * login display rule, the check's strict body and its outcome table, and that
 * the state, code, cookies, token, provider text and checked names reach
 * nowhere else (AC7). Every value is fake.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type http from "node:http";
import https from "node:https";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, test, vi } from "vitest";
import {
  GITHUB_AUTHORIZE_URL,
  type GatewayUiGithub,
} from "@assistant/shared/gatewayUi";
import { edgeTlsFor } from "../gateway/x509.ts";
import { FAKE_CLIENT, FAKE_CODE } from "../test/atlassianFake.ts";
import { FAKE_GITHUB_CLIENT, FAKE_GITHUB_CODE } from "../test/githubFake.ts";
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
import type { GatewayWebConfig } from "./config.ts";
import {
  IntegrationsRefusal,
  type GatewayWebIntegrations,
  type IntegrationsRefusalCode,
} from "./integrations.ts";
import { PENDING_TTL_MS } from "./sessions.ts";
import { startGatewayWeb } from "./server.ts";

const GITHUB_COOKIE = "__Host-pgw_github";
const CALLBACK = `${PUBLIC_ORIGIN}/auth/github/callback`;
const CONNECT_PATH = "/api/integrations/github/connect";
const STATUS_PATH = "/api/integrations/github";
const CLEAR_PATH = "/api/integrations/github/clear";
const CHECK_PATH = "/api/integrations/github/check";
const PROVIDER_TEXT = "FAKE_GITHUB_PROVIDER_TEXT_SENTINEL";
const INSTALL_SENTINEL = "fake-t1445-install-sentinel";
/** The names a check sends: only its own 200 answer may hold them. */
const OWNER = "fake-owner-t1445";
const REPO = "fake-repo-t1445";
const EXPIRES_AT = 1_900_000_000_000;

const edgeTls = edgeTlsFor(["localhost", "127.0.0.1"], undefined);
const agent = new https.Agent({ ca: edgeTls.caCertPem, keepAlive: true });
let issuer: FakeIssuer;
let distDir: string;
const logs: string[] = [];
const answers: Answer[] = [];
const open: { close(): Promise<void> | void }[] = [];
/** Every state and cookie value this file saw issued. */
const states: string[] = [];
const cookieValues: string[] = [];

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
            // The path without its query: a callback's query is the request's.
            path: path.split("?")[0]!,
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
  cookieValues.push(session);
  return `__Host-pgw_session=${session}`;
}

const MUTATION = { origin: PUBLIC_ORIGIN, "x-gateway-ui": "1" };

type Provider = "github" | "slack" | "atlassian";
const COOKIE: Record<Provider, string> = {
  github: GITHUB_COOKIE,
  slack: "__Host-pgw_slack",
  atlassian: "__Host-pgw_atlassian",
};

function post(
  port: number,
  path: string,
  session: string | undefined,
  options: { headers?: Record<string, string>; body?: string } = {},
): Promise<Answer> {
  return request(port, path, {
    method: "POST",
    headers: {
      ...(options.headers ?? MUTATION),
      ...(session ? { cookie: session } : {}),
      "content-type": "application/json",
    },
    body: options.body ?? "{}",
  });
}

/** A started connect: the state, the browser's pending cookie pair. */
async function started(
  port: number,
  session: string,
  provider: Provider = "github",
) {
  const answer = await post(
    port,
    `/api/integrations/${provider}/connect`,
    session,
  );
  assert.equal(answer.status, 200);
  const url = new URL(
    (JSON.parse(answer.body) as { authorizeUrl: string }).authorizeUrl,
  );
  const state = url.searchParams.get("state")!;
  const value = cookieValue(answer, COOKIE[provider])!;
  states.push(state);
  cookieValues.push(value);
  const pending = `${COOKIE[provider]}=${value}`;
  return { answer, url, state, value, pending };
}

function callback(
  port: number,
  query: Record<string, string>,
  cookies: (string | undefined)[],
  provider: Provider = "github",
): Promise<Answer> {
  const cookie = cookies.filter((c) => c !== undefined).join("; ");
  return request(
    port,
    `/auth/${provider}/callback?${new URLSearchParams(query).toString()}`,
    cookie === "" ? {} : { headers: { cookie } },
  );
}

/** The callback's 303: its location, and that it cleared its cookie. */
function redirected(answer: Answer, provider: Provider = "github"): string {
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

function check(
  port: number,
  session: string | undefined,
  body: unknown = { owner: OWNER, repo: REPO },
): Promise<Answer> {
  return post(port, CHECK_PATH, session, {
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
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

interface Call {
  op: string;
  userId: string;
  request?: unknown;
}

/** A fake seam: every call recorded, answered as told, a call held. */
function fakeIntegrations() {
  const calls: Call[] = [];
  let refusal: IntegrationsRefusalCode | Error | undefined;
  let holdMs = 0;
  let status: Omit<GatewayUiGithub, "offered"> = { connected: false };
  const fail = () => {
    if (refusal instanceof Error) throw refusal;
    if (refusal) throw new IntegrationsRefusal(refusal);
  };
  const held = async () => {
    if (holdMs) await new Promise((resolve) => setTimeout(resolve, holdMs));
  };
  const integrations: GatewayWebIntegrations = {
    status: () => Promise.resolve({ connected: false, connectWith: "oauth" }),
    set: () =>
      Promise.reject(new IntegrationsRefusal("integration_sign_in_required")),
    clear: () => Promise.resolve(),
    connect: async (userId, request) => {
      calls.push({ op: "connect", userId, request });
      return { connected: true, kind: "oauth", connectWith: "oauth" };
    },
    slackStatus: () => Promise.resolve({ connected: false }),
    connectSlack: async (userId, request) => {
      calls.push({ op: "connectSlack", userId, request });
    },
    clearSlack: () => Promise.resolve(),
    githubStatus: async (userId) => {
      calls.push({ op: "githubStatus", userId });
      fail();
      return status;
    },
    connectGithub: async (userId, request) => {
      calls.push({ op: "connectGithub", userId, request });
      await held();
      fail();
    },
    clearGithub: async (userId) => {
      calls.push({ op: "clearGithub", userId });
      fail();
    },
    checkGithub: async (userId, request) => {
      calls.push({ op: "checkGithub", userId, request });
      await held();
      fail();
      // As the edge does: the expiry only, never the token.
      return { expiresAt: EXPIRES_AT };
    },
  };
  return {
    integrations,
    calls,
    ops: (op: string) => calls.filter((call) => call.op === op),
    refuse: (code: IntegrationsRefusalCode | Error | undefined) =>
      (refusal = code),
    hold: (ms: number) => (holdMs = ms),
    answer: (next: Omit<GatewayUiGithub, "offered">) => (status = next),
  };
}

async function startUi(
  options: {
    github?: GatewayWebConfig["github"] | null;
    others?: boolean;
    now?: () => number;
    testIdleMs?: { idle: number; integration: number; connect?: number };
  } = {},
) {
  const fake = fakeIntegrations();
  const github =
    options.github === undefined
      ? { clientId: FAKE_GITHUB_CLIENT.clientId }
      : options.github;
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
      ...(github ? { github } : {}),
      ...(options.others
        ? {
            atlassian: {
              emailFromSignIn: false,
              clientId: FAKE_CLIENT.clientId,
              scopes: ["read:jira-work", "offline_access"],
            },
            slack: {
              clientId: FAKE_SLACK_CLIENT.clientId,
              userScopes: ["search:read"],
            },
          }
        : {}),
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
  assertRedacted();
});

/**
 * AC7 over everything this file saw. No log line holds a code, state,
 * `state=`, cookie value, the token, provider text or a checked name. No
 * answer holds the code, the token or provider text. A state and `state=`
 * appear only in a connect start's `authorizeUrl`; the checked names only in
 * the check's 200 `repository`; a cookie value only in its own `Set-Cookie`.
 */
function assertRedacted(): void {
  assert.ok(states.length > 0 && cookieValues.length > 0);
  const never = [
    FAKE_GITHUB_CODE,
    FAKE_SLACK_CODE,
    FAKE_CODE,
    INSTALL_SENTINEL,
    PROVIDER_TEXT,
  ];
  for (const line of logs)
    for (const value of [
      ...never,
      ...states,
      ...cookieValues,
      "state=",
      "code=",
      OWNER,
      REPO,
    ])
      assert.ok(!line.includes(value), `a log line leaked: ${line}`);
  const connectPaths = new Set(
    (["github", "slack", "atlassian"] as const).map(
      (provider) => `/api/integrations/${provider}/connect`,
    ),
  );
  for (const answer of answers) {
    const { "set-cookie": cookies, ...headers } = answer.headers;
    const head = JSON.stringify(headers);
    for (const value of never)
      assert.ok(
        !answer.body.includes(value) &&
          !head.includes(value) &&
          !JSON.stringify(cookies ?? []).includes(value),
        `an answer leaked: ${answer.path}`,
      );
    // Cookie values only in Set-Cookie, never a body or another header.
    for (const value of cookieValues)
      assert.ok(
        !answer.body.includes(value) && !head.includes(value),
        `a cookie value leaked: ${answer.path}`,
      );
    // The state only inside a start's authorizeUrl.
    const start = connectPaths.has(answer.path) && answer.status === 200;
    // The OIDC sign-in's own redirect to its provider carries its state.
    const providerRedirect = answer.path === "/auth/login";
    for (const value of [...states, "state="]) {
      if (!providerRedirect)
        assert.ok(
          !head.includes(value),
          `a header leaked a state: ${answer.path}`,
        );
      if (!start)
        assert.ok(
          !answer.body.includes(value),
          `a body leaked a state: ${answer.path}`,
        );
    }
    if (start)
      assert.deepEqual(Object.keys(JSON.parse(answer.body) as object), [
        "authorizeUrl",
      ]);
    // The checked names only in the check's 200 repository.
    const checked = answer.path === CHECK_PATH && answer.status === 200;
    for (const value of [OWNER, REPO]) {
      assert.ok(
        !head.includes(value),
        `a header leaked a name: ${answer.path}`,
      );
      if (!checked)
        assert.ok(
          !answer.body.includes(value),
          `a body leaked a name: ${answer.path}`,
        );
    }
    if (checked)
      assert.deepEqual(JSON.parse(answer.body), {
        repository: `${OWNER}/${REPO}`,
        expiresAt: EXPIRES_AT,
      });
  }
}

// --- without github.clientId ------------------------------------------------

test("without github.clientId every GitHub route is 404 and status answers offered:false with no adapter call", async () => {
  const { port, fake } = await startUi({ github: null });
  const session = await signIn(port);
  const status = await request(port, STATUS_PATH, {
    headers: { cookie: session },
  });
  assert.equal(status.status, 200);
  assert.deepEqual(JSON.parse(status.body), {
    offered: false,
    connected: false,
  });
  const none = await post(port, CONNECT_PATH, session);
  assert.equal(none.status, 404);
  assert.equal(setCookie(none, GITHUB_COOKIE), undefined);
  assert.equal((await post(port, CLEAR_PATH, session)).status, 404);
  assert.equal((await check(port, session)).status, 404);
  const back = await callback(port, { code: FAKE_GITHUB_CODE, state: "x" }, [
    session,
  ]);
  assert.equal(back.status, 404);
  assert.equal(back.headers.location, undefined);
  assert.deepEqual(fake.calls, []);
});

// --- the start --------------------------------------------------------------

test("the start needs Origin, the header and a session, and is 404 by GET", async () => {
  const { port, fake } = await startUi();
  const session = await signIn(port);
  for (const headers of [
    { "x-gateway-ui": "1" },
    { origin: "https://evil.test", "x-gateway-ui": "1" },
    { origin: PUBLIC_ORIGIN },
  ]) {
    for (const path of [CONNECT_PATH, CLEAR_PATH, CHECK_PATH]) {
      const refused = await post(port, path, session, { headers });
      assert.equal(refused.status, 403, path);
      assert.deepEqual(JSON.parse(refused.body), { error: "forbidden" });
      assert.equal(setCookie(refused, GITHUB_COOKIE), undefined);
    }
  }
  const signedOut = await post(port, CONNECT_PATH, undefined);
  assert.equal(signedOut.status, 401);
  assert.equal(setCookie(signedOut, GITHUB_COOKIE), undefined);
  const byGet = await request(port, CONNECT_PATH, {
    headers: { cookie: session },
  });
  assert.equal(byGet.status, 404);
  for (const path of [STATUS_PATH, CLEAR_PATH, CHECK_PATH])
    assert.equal(
      (await request(port, path, { headers: { cookie: "x=1" } })).status,
      401,
    );
  assert.equal((await check(port, undefined)).status, 401);
  assert.deepEqual(fake.calls, []);
});

test("the start answers GitHub's authorize URL with exactly client_id, redirect_uri and state, and sets the pending cookie", async () => {
  const { port } = await startUi();
  const session = await signIn(port);
  const first = await started(port, session);
  assert.equal(first.answer.headers["cache-control"], "no-store");
  assert.equal(
    `${first.url.origin}${first.url.pathname}`,
    GITHUB_AUTHORIZE_URL,
  );
  assert.equal(first.url.username, "");
  assert.equal(first.url.hash, "");
  assert.deepEqual([...first.url.searchParams.keys()].sort(), [
    "client_id",
    "redirect_uri",
    "state",
  ]);
  assert.equal(
    first.url.searchParams.get("client_id"),
    FAKE_GITHUB_CLIENT.clientId,
  );
  assert.equal(first.url.searchParams.get("redirect_uri"), CALLBACK);
  // 32 random bytes, base64url.
  assert.match(first.state, /^[A-Za-z0-9_-]{43}$/);
  assert.match(
    setCookie(first.answer, GITHUB_COOKIE)!,
    /^__Host-pgw_github=[A-Za-z0-9_-]{43}; Path=\/; Secure; HttpOnly; SameSite=Lax; Max-Age=600$/,
  );
  assert.ok(!setCookie(first.answer, GITHUB_COOKIE)!.includes("Domain"));
  assert.notEqual(first.value, first.state);
  const second = await started(port, session);
  assert.notEqual(second.state, first.state);
  assert.notEqual(second.value, first.value);
  assert.ok(logs.includes("ui github connect: started user=u1"));
});

// --- the callback -----------------------------------------------------------

test("the callback connects with exactly the code and the public-origin redirect URI, then goes to / once", async () => {
  const { port, fake } = await startUi();
  const session = await signIn(port);
  const { state, pending } = await started(port, session);
  assert.equal(
    redirected(
      await callback(port, { code: FAKE_GITHUB_CODE, state }, [
        session,
        pending,
      ]),
    ),
    "/",
  );
  assert.deepEqual(fake.calls, [
    {
      op: "connectGithub",
      userId: "u1",
      request: { code: FAKE_GITHUB_CODE, redirectUri: CALLBACK },
    },
  ]);
  assert.ok(logs.includes("ui github connect: ok user=u1"));
  // Reused: the state is spent.
  assert.equal(
    redirected(
      await callback(port, { code: FAKE_GITHUB_CODE, state }, [
        session,
        pending,
      ]),
    ),
    "/?github=failed",
  );
  assert.equal(fake.ops("connectGithub").length, 1);
});

test("the state is bound to its cookie and its user: another start's cookie, no cookie or another user fails without a connect", async () => {
  const { port, fake } = await startUi();
  const session = await signIn(port);
  const other = await signIn(port, "subject-2");
  const a = await started(port, session);
  const b = await started(port, session);
  assert.equal(
    redirected(
      await callback(port, { code: FAKE_GITHUB_CODE, state: a.state }, [
        session,
        b.pending,
      ]),
    ),
    "/?github=failed",
  );
  assert.equal(
    redirected(
      await callback(port, { code: FAKE_GITHUB_CODE, state: b.state }, [
        session,
      ]),
    ),
    "/?github=expired",
  );
  const d = await started(port, session);
  assert.equal(
    redirected(
      await callback(port, { code: FAKE_GITHUB_CODE, state: d.state }, [
        other,
        d.pending,
      ]),
    ),
    "/?github=failed",
  );
  assert.deepEqual(fake.calls, []);
  assert.ok(logs.includes("ui github connect: failed (state) user=u2"));
});

test("signed out, the callback answers signed_out and still spends the state", async () => {
  const { port, fake } = await startUi();
  const session = await signIn(port);
  const { state, pending } = await started(port, session);
  assert.equal(
    redirected(
      await callback(port, { code: FAKE_GITHUB_CODE, state }, [pending]),
    ),
    "/?github=signed_out",
  );
  assert.equal(
    redirected(
      await callback(port, { code: FAKE_GITHUB_CODE, state }, [
        session,
        pending,
      ]),
    ),
    "/?github=failed",
  );
  assert.deepEqual(fake.calls, []);
  assert.ok(logs.includes("ui github connect: failed (signed_out)"));
});

test("a start older than ten minutes is expired", async () => {
  let skew = 0;
  const { port, fake } = await startUi({ now: () => Date.now() + skew });
  const session = await signIn(port);
  const { state, pending } = await started(port, session);
  skew = PENDING_TTL_MS;
  assert.equal(
    redirected(
      await callback(port, { code: FAKE_GITHUB_CODE, state }, [
        session,
        pending,
      ]),
    ),
    "/?github=expired",
  );
  assert.deepEqual(fake.calls, []);
});

test("GitHub's error answers denied or failed and its text goes nowhere; a missing or malformed code fails", async () => {
  const { port, fake } = await startUi();
  const session = await signIn(port);
  const cases: [Record<string, string>, string][] = [
    [{ error: "access_denied" }, "/?github=denied"],
    [
      {
        error: "access_denied",
        error_description: PROVIDER_TEXT,
        error_uri: PROVIDER_TEXT,
      },
      "/?github=denied",
    ],
    [{ error: PROVIDER_TEXT }, "/?github=failed"],
    [
      {
        error: "redirect_uri_mismatch",
        error_description: PROVIDER_TEXT,
        code: FAKE_GITHUB_CODE,
      },
      "/?github=failed",
    ],
    [{}, "/?github=failed"],
    [{ code: "" }, "/?github=failed"],
    [{ code: `${FAKE_GITHUB_CODE} x` }, "/?github=failed"],
    [{ code: `${FAKE_GITHUB_CODE}é` }, "/?github=failed"],
    [{ code: "x".repeat(8_193) }, "/?github=failed"],
  ];
  for (const [query, location] of cases) {
    const { state, pending } = await started(port, session);
    assert.equal(
      redirected(await callback(port, { ...query, state }, [session, pending])),
      location,
      JSON.stringify(query),
    );
  }
  assert.deepEqual(fake.calls, []);
  assert.ok(logs.includes("ui github connect: failed (denied) user=u1"));
});

test("each connect refusal maps to its fixed ?github= code; anything else thrown is failed", async () => {
  const { port, fake } = await startUi();
  const session = await signIn(port);
  const cases: [IntegrationsRefusalCode | Error, string][] = [
    ["integration_rejected", "rejected"],
    ["integration_unreachable", "unreachable"],
    ["integration_not_configured", "not_configured"],
    ["vault_locked", "vault_locked"],
    ["vault_unavailable", "vault_unavailable"],
    ["integration_busy", "busy"],
    // Not GitHub's codes: failed.
    ["integration_team_mismatch", "failed"],
    ["tools_unavailable", "failed"],
    ["integration_denied", "failed"],
    ["integration_invalid", "failed"],
    [new Error(PROVIDER_TEXT), "failed"],
    [new Error(INSTALL_SENTINEL), "failed"],
  ];
  for (const [refusal, code] of cases) {
    fake.refuse(refusal);
    const { state, pending } = await started(port, session);
    assert.equal(
      redirected(
        await callback(port, { code: FAKE_GITHUB_CODE, state }, [
          session,
          pending,
        ]),
      ),
      `/?github=${code}`,
    );
    assert.ok(
      logs.includes(`ui github connect: failed (${code}) user=u1`),
      code,
    );
  }
  assert.equal(fake.ops("connectGithub").length, cases.length);
});

// --- provider separation ----------------------------------------------------

test("a GitHub state never completes on the Atlassian or Slack callback, and the GitHub flow still completes", async () => {
  const { port, fake } = await startUi({ others: true });
  const session = await signIn(port);
  const g = await started(port, session, "github");
  for (const provider of ["atlassian", "slack"] as const) {
    // With its own cookie: no pending cookie of that provider.
    assert.equal(
      redirected(
        await callback(
          port,
          { code: FAKE_GITHUB_CODE, state: g.state },
          [session, g.pending],
          provider,
        ),
        provider,
      ),
      `/?${provider}=expired`,
    );
    // With its cookie value under that provider's cookie name.
    assert.equal(
      redirected(
        await callback(
          port,
          { code: FAKE_GITHUB_CODE, state: g.state },
          [session, `${COOKIE[provider]}=${g.value}`],
          provider,
        ),
        provider,
      ),
      `/?${provider}=failed`,
    );
  }
  assert.deepEqual(fake.calls, []);
  assert.equal(
    redirected(
      await callback(port, { code: FAKE_GITHUB_CODE, state: g.state }, [
        session,
        g.pending,
      ]),
    ),
    "/",
  );
  assert.deepEqual(fake.ops("connectGithub").length, 1);
});

test("an Atlassian or Slack state never completes on the GitHub callback, and their flows still complete", async () => {
  const { port, fake } = await startUi({ others: true });
  const session = await signIn(port);
  for (const provider of ["atlassian", "slack"] as const) {
    const s = await started(port, session, provider);
    assert.equal(
      redirected(
        await callback(port, { code: FAKE_GITHUB_CODE, state: s.state }, [
          session,
          s.pending,
        ]),
      ),
      "/?github=expired",
    );
    assert.equal(
      redirected(
        await callback(port, { code: FAKE_GITHUB_CODE, state: s.state }, [
          session,
          `${GITHUB_COOKIE}=${s.value}`,
        ]),
      ),
      "/?github=failed",
    );
    assert.equal(
      redirected(
        await callback(
          port,
          {
            code: provider === "slack" ? FAKE_SLACK_CODE : FAKE_CODE,
            state: s.state,
          },
          [session, s.pending],
          provider,
        ),
        provider,
      ),
      "/",
    );
  }
  assert.deepEqual(
    fake.calls.map((call) => call.op),
    ["connect", "connectSlack"],
  );
});

// --- status and clear -------------------------------------------------------

test("status passes connected, a safe login and the problem through for the session's user", async () => {
  const { port, fake } = await startUi();
  const session = await signIn(port);
  const read = async () => {
    const answer = await request(port, STATUS_PATH, {
      headers: { cookie: session },
    });
    assert.equal(answer.status, 200);
    assert.equal(answer.headers["cache-control"], "no-store");
    return JSON.parse(answer.body) as unknown;
  };
  assert.deepEqual(await read(), { offered: true, connected: false });
  fake.answer({ connected: true, login: "fake-user" });
  assert.deepEqual(await read(), {
    offered: true,
    connected: true,
    login: "fake-user",
  });
  // A login the page could not show safely is dropped.
  for (const login of ["fake\u001b[2Juser", "a".repeat(40), "", "a b"]) {
    fake.answer({ connected: true, login });
    assert.deepEqual(await read(), { offered: true, connected: true });
  }
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
  const refused = await request(port, STATUS_PATH, {
    headers: { cookie: session },
  });
  assert.equal(refused.status, 503);
  assert.deepEqual(JSON.parse(refused.body), { error: "vault_locked" });
});

test("clear answers 204 and logs the fixed line; a busy slot is 409; other paths under the prefix are 404", async () => {
  const { port, fake } = await startUi();
  const session = await signIn(port);
  const cleared = await post(port, CLEAR_PATH, session);
  assert.equal(cleared.status, 204);
  assert.deepEqual(fake.calls, [{ op: "clearGithub", userId: "u1" }]);
  assert.ok(logs.includes("ui integration github: cleared user=u1"));
  fake.refuse("integration_busy");
  const busy = await post(port, CLEAR_PATH, session);
  assert.equal(busy.status, 409);
  assert.deepEqual(JSON.parse(busy.body), { error: "integration_busy" });
  fake.refuse(undefined);
  assert.equal((await post(port, STATUS_PATH, session)).status, 404);
  for (const path of [CLEAR_PATH, CHECK_PATH, `${STATUS_PATH}/other`])
    assert.equal(
      (await request(port, path, { headers: { cookie: session } })).status,
      404,
      path,
    );
  assert.equal((await post(port, `${STATUS_PATH}/other`, session)).status, 404);
  assert.equal(fake.ops("clearGithub").length, 2);
});

// --- the check --------------------------------------------------------------

test("a check answers exactly repository and expiresAt for the session's user, and logs only the fixed line", async () => {
  const { port, fake } = await startUi();
  const session = await signIn(port);
  const from = logs.length;
  const answer = await check(port, session);
  assert.equal(answer.status, 200);
  assert.equal(answer.headers["cache-control"], "no-store");
  const body = JSON.parse(answer.body) as Record<string, unknown>;
  assert.deepEqual(Object.keys(body).sort(), ["expiresAt", "repository"]);
  assert.deepEqual(body, {
    repository: `${OWNER}/${REPO}`,
    expiresAt: EXPIRES_AT,
  });
  assert.deepEqual(fake.calls, [
    {
      op: "checkGithub",
      userId: "u1",
      request: { owner: OWNER, repo: REPO },
    },
  ]);
  assert.deepEqual(logs.slice(from), [
    "ui integration github: check ok user=u1",
  ]);
});

test("each check refusal answers its status and fixed code; anything else thrown is 503 unavailable", async () => {
  const { port, fake } = await startUi();
  const session = await signIn(port);
  const cases: [IntegrationsRefusalCode, number][] = [
    ["integration_sign_in_required", 409],
    ["integration_denied", 403],
    ["integration_rejected", 422],
    ["integration_invalid", 400],
    ["vault_locked", 503],
    ["vault_unavailable", 503],
    ["integration_busy", 409],
  ];
  for (const [code, status] of cases) {
    fake.refuse(code);
    const from = logs.length;
    const answer = await check(port, session);
    assert.equal(answer.status, status, code);
    assert.deepEqual(JSON.parse(answer.body), { error: code });
    assert.deepEqual(logs.slice(from), [
      `ui integration github: check refused (${code}) user=u1`,
    ]);
  }
  for (const thrown of [
    new Error(INSTALL_SENTINEL),
    new Error(PROVIDER_TEXT),
  ]) {
    fake.refuse(thrown);
    const from = logs.length;
    const answer = await check(port, session);
    assert.equal(answer.status, 503);
    assert.deepEqual(JSON.parse(answer.body), { error: "unavailable" });
    assert.deepEqual(logs.slice(from), [
      "ui integration github: check failed user=u1",
    ]);
  }
  assert.equal(fake.ops("checkGithub").length, cases.length + 2);
});

test("a check body that is not exactly {owner, repo} GitHub names is 400 bad_request without a check; an oversize body is 413", async () => {
  const { port, fake } = await startUi();
  const session = await signIn(port);
  const bad: unknown[] = [
    { owner: OWNER, repo: REPO, access: "write" },
    { owner: OWNER, repo: REPO, token: INSTALL_SENTINEL },
    { owner: OWNER, repo: REPO, userId: "u2" },
    { owner: OWNER },
    { repo: REPO },
    { owner: OWNER, repo: 7 },
    { owner: 7, repo: REPO },
    { owner: OWNER, repo: ".." },
    { owner: OWNER, repo: "." },
    { owner: "a".repeat(40), repo: REPO },
    { owner: OWNER, repo: "a/b" },
    { owner: OWNER, repo: "r".repeat(101) },
    [OWNER, REPO],
    `${OWNER}/${REPO}`,
    "not json",
    "null",
  ];
  for (const body of bad) {
    const from = logs.length;
    const answer = await check(
      port,
      session,
      typeof body === "string" ? body : body,
    );
    assert.equal(answer.status, 400, JSON.stringify(body));
    assert.deepEqual(JSON.parse(answer.body), { error: "bad_request" });
    assert.deepEqual(logs.slice(from), []);
  }
  // Over the listener's body bound: refused before any route runs.
  const oversize = await check(port, session, {
    owner: OWNER,
    repo: REPO,
    pad: "x".repeat(2_000),
  });
  assert.equal(oversize.status, 413);
  assert.deepEqual(fake.calls, []);
});

test("a check runs under the connect bound and gets its answer past the integration bound", async () => {
  const { port, fake } = await startUi({
    testIdleMs: { idle: 300, integration: 600, connect: 3_000 },
  });
  const session = await signIn(port);
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
  const answer = await check(port, session);
  assert.equal(answer.status, 200);
  // The connect bound while the check runs, then the baseline (the HTTP
  // server may re-arm its own keep-alive timeout after the answer).
  const raised = (): number[] => {
    const at = bounds.indexOf(3_000);
    return at < 0 ? bounds : bounds.slice(at, at + 2);
  };
  assert.deepEqual(raised(), [3_000, 300]);
  // A refused check restores the baseline too.
  fake.hold(0);
  fake.refuse("integration_denied");
  bounds.length = 0;
  assert.equal((await check(port, session)).status, 403);
  assert.deepEqual(raised(), [3_000, 300]);
});
