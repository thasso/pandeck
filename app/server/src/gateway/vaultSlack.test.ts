/**
 * The vault's Slack OAuth record in process (Task-1452, plan v03 PR1 AC2,
 * AC3, AC6): the exact requests on the wire (TLS name, `Host`, form body,
 * Bearer), no redirect followed, each answer's classification, every
 * fail-closed shape of the exchange, `auth.test` and the refresh, the stored
 * record and its access view, the mandatory rotation, and Slack beside
 * Atlassian for one user. Against loopback fakes (`test/slackFake.ts`,
 * `test/atlassianFake.ts`); an injected clock; every value fake.
 */
import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
  mkdirSync,
} from "node:fs";
import type net from "node:net";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, afterEach, beforeAll, test } from "vitest";
import {
  FAKE_CLIENT,
  FAKE_CODE,
  FAKE_REDIRECT,
  FAKE_PLANTED_REFRESH,
  FAKE_SITE,
  startAtlassianFake,
  type AtlassianFake,
} from "../test/atlassianFake.ts";
import {
  AUTH_TEST_OK,
  FAKE_SLACK_CLIENT,
  FAKE_SLACK_CODE,
  FAKE_SLACK_REDIRECT,
  FAKE_SLACK_SCOPE,
  FAKE_SLACK_TOKENS,
  FAKE_TEAM_ID,
  FAKE_TEAM_NAME,
  FAKE_USER_ID,
  FAKE_WORKSPACE_HOST,
  slackJson,
  startSlackFake,
  type SlackFake,
  type SlackResponder,
} from "../test/slackFake.ts";
import type { IntegrationClients } from "./integrationClients.ts";
import {
  createVaultIntegrations,
  type VaultIntegrationOptions,
} from "./vaultIntegrations.ts";
import { INTEGRATION_FILE, integrationDirId } from "./vaultMethods.ts";
import type { IntegrationRecord } from "./vaultPort.ts";
import {
  exchangeSlackCode,
  refreshSlack,
  slackAuthTest,
} from "./vaultSlack.ts";

const root = mkdtempSync(join(tmpdir(), "vault-slack-"));
let slack: SlackFake;
let atlassian: AtlassianFake;
let atlassianToken: AtlassianFake["token"];

beforeAll(async () => {
  slack = await startSlackFake();
  atlassian = await startAtlassianFake();
  atlassianToken = atlassian.token;
});
afterEach(() => {
  slack.reset();
  atlassian.seen.length = 0;
  atlassian.token = atlassianToken;
  atlassian.expiresInS = 3600;
});
afterAll(async () => {
  await slack.close();
  await atlassian.close();
  rmSync(root, { recursive: true, force: true });
});

const STORED_REFRESH = FAKE_SLACK_TOKENS.storedRefresh;
const DIRECT_ACCESS = FAKE_SLACK_TOKENS.directAccess;
/** An API-token record as an edge would put one; never valid for Slack. */
const API_TOKEN_TEXT = JSON.stringify({ token: FAKE_SLACK_TOKENS.apiToken });
/** `expires_in` less four minutes: inside the five-minute refresh margin. */
const DUE_MS = (43_200 - 4 * 60) * 1000;

function harness(
  dir = mkdtempSync(join(root, "v-")),
  options: Partial<VaultIntegrationOptions> = {},
) {
  const clock = { now: 1_000_000_000 };
  const lines: string[] = [];
  const clients: IntegrationClients = { slack: FAKE_SLACK_CLIENT };
  const port = createVaultIntegrations(
    {
      stateDir: dir,
      clients,
      slackEndpoint: slack.endpoint,
      ...options,
    },
    (line) => lines.push(line),
    () => clock.now,
  );
  const recordDir = join(dir, "accounts", integrationDirId("u1", "slack"));
  const file = join(recordDir, INTEGRATION_FILE);
  return {
    dir,
    clock,
    lines,
    port,
    file,
    accounts: join(dir, "accounts"),
    bytes: (): string => readFileSync(file, "utf8"),
    stored: (): Record<string, unknown> =>
      JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>,
    connect: (team?: string) =>
      port.integrationConnect("u1", "slack", {
        code: FAKE_SLACK_CODE,
        redirectUri: FAKE_SLACK_REDIRECT,
        ...(team !== undefined ? { team } : {}),
      }),
    get: (signal?: AbortSignal) =>
      port.integrationGet("u1", "slack", signal ? { signal } : {}),
  };
}

/** The access view's fields, from a get's answer. */
function view(record: IntegrationRecord): Record<string, unknown> {
  assert.equal(record.ok, true, JSON.stringify(record));
  return JSON.parse((record as { credential: string }).credential) as Record<
    string,
    unknown
  >;
}

/** No answer or log line holds a fake token, code or secret. */
function assertNoSecrets(text: string): void {
  assert.doesNotMatch(
    text,
    /fake-slack-(access|refresh|client-secret|auth-code)|sentinel/,
  );
}

/** A refresh answer as Slack documents it, with its fields replaced. */
function refreshAnswer(fields: Record<string, unknown>): SlackResponder {
  return slackJson(200, {
    ok: true,
    token_type: "user",
    access_token: FAKE_SLACK_TOKENS.scriptedAccess,
    refresh_token: FAKE_SLACK_TOKENS.scriptedRefresh,
    expires_in: 43_200,
    scope: FAKE_SLACK_SCOPE,
    ...fields,
  });
}

/** An exchange answer as Slack documents it, `authed_user` replaced in part. */
function exchangeAnswer(
  user: Record<string, unknown>,
  top: Record<string, unknown> = {},
): SlackResponder {
  return slackJson(200, {
    ok: true,
    authed_user: {
      id: FAKE_USER_ID,
      scope: FAKE_SLACK_SCOPE,
      access_token: FAKE_SLACK_TOKENS.scriptedAccess,
      expires_in: 43_200,
      refresh_token: FAKE_SLACK_TOKENS.scriptedRefresh,
      token_type: "user",
      ...user,
    },
    team: { id: FAKE_TEAM_ID, name: FAKE_TEAM_NAME },
    ...top,
  });
}

// --- the wire --------------------------------------------------------------

test("the exchange posts the documented form to slack.com only; auth.test carries the new access token", async () => {
  const h = harness();
  assert.deepEqual(await h.connect(), {
    ok: true,
    teamId: FAKE_TEAM_ID,
    teamName: FAKE_TEAM_NAME,
  });
  const [exchange] = slack.on("access");
  assert.ok(exchange);
  assert.equal(exchange.method, "POST");
  assert.equal(exchange.path, "/api/oauth.v2.access");
  assert.equal(exchange.servername, "slack.com");
  assert.equal(exchange.headers.host, "slack.com");
  assert.equal(
    exchange.headers["content-type"],
    "application/x-www-form-urlencoded",
  );
  assert.equal(exchange.headers.authorization, undefined);
  assert.deepEqual(exchange.form, {
    client_id: FAKE_SLACK_CLIENT.clientId,
    client_secret: FAKE_SLACK_CLIENT.clientSecret,
    code: FAKE_SLACK_CODE,
    redirect_uri: FAKE_SLACK_REDIRECT,
  });
  const [identity] = slack.on("authTest");
  assert.ok(identity);
  assert.equal(identity.method, "POST");
  assert.equal(identity.path, "/api/auth.test");
  assert.equal(identity.servername, "slack.com");
  assert.equal(identity.headers.host, "slack.com");
  assert.equal(
    identity.headers.authorization,
    `Bearer ${slack.issuedAccess.at(-1)}`,
  );
  assert.equal(identity.body, "");
  assert.equal(slack.seen.length, 2);
  await h.port.close();
});

test("a refresh posts the refresh_token grant with the client in the body", async () => {
  const result = await refreshSlack(
    FAKE_SLACK_CLIENT,
    STORED_REFRESH,
    slack.endpoint,
  );
  assert.equal(result.kind, "ok");
  const [request] = slack.on("access");
  assert.ok(request);
  assert.equal(request.servername, "slack.com");
  assert.equal(request.headers.host, "slack.com");
  assert.deepEqual(request.form, {
    client_id: FAKE_SLACK_CLIENT.clientId,
    client_secret: FAKE_SLACK_CLIENT.clientSecret,
    grant_type: "refresh_token",
    refresh_token: STORED_REFRESH,
  });
});

test("a redirect from either call is not followed and is unreachable", async () => {
  const redirect: SlackResponder = (_seen, res) => {
    res.raw.writeHead(302, {
      location: `https://127.0.0.1:${slack.endpoint.connect.port}/api/auth.test`,
    });
    res.raw.end();
  };
  slack.access = redirect;
  assert.deepEqual(
    await exchangeSlackCode(
      FAKE_SLACK_CLIENT,
      { code: FAKE_SLACK_CODE, redirectUri: FAKE_SLACK_REDIRECT },
      slack.endpoint,
    ),
    { kind: "unreachable", code: "redirect" },
  );
  assert.equal(slack.seen.length, 1);
  slack.reset();
  slack.authTest = redirect;
  const h = harness();
  assert.deepEqual(await h.connect(), { ok: false, unreachable: true });
  assert.deepEqual(
    slack.seen.map((seen) => seen.route),
    ["access", "authTest"],
  );
  assert.equal(existsSync(h.accounts), false);
  await h.port.close();
});

test("each call classifies Slack's answers alike: transient is unreachable, any other refusal rejected", async () => {
  const calls: [string, (fake: SlackFake) => Promise<unknown>][] = [
    [
      "exchange",
      (fake) =>
        exchangeSlackCode(
          FAKE_SLACK_CLIENT,
          { code: FAKE_SLACK_CODE, redirectUri: FAKE_SLACK_REDIRECT },
          fake.endpoint,
        ),
    ],
    [
      "refresh",
      (fake) => refreshSlack(FAKE_SLACK_CLIENT, STORED_REFRESH, fake.endpoint),
    ],
    ["auth.test", (fake) => slackAuthTest(DIRECT_ACCESS, fake.endpoint)],
  ];
  const cases: [SlackResponder, unknown][] = [
    [
      slackJson(200, { ok: false, error: "invalid_code" }),
      { kind: "rejected" },
    ],
    [
      slackJson(200, { ok: false, error: "invalid_refresh_token" }),
      { kind: "rejected" },
    ],
    [
      slackJson(200, { ok: false, error: "token_revoked" }),
      { kind: "rejected" },
    ],
    [slackJson(200, { ok: false }), { kind: "rejected" }],
    ...(
      [
        "ratelimited",
        "internal_error",
        "fatal_error",
        "service_unavailable",
        "request_timeout",
      ] as const
    ).map((word): [SlackResponder, unknown] => [
      slackJson(200, { ok: false, error: word }),
      { kind: "unreachable", code: word },
    ]),
    [slackJson(429, { ok: false }), { kind: "unreachable", code: "429" }],
    [slackJson(500, "oops"), { kind: "unreachable", code: "500" }],
    [slackJson(503, "oops"), { kind: "unreachable", code: "503" }],
    [slackJson(400, { ok: false }), { kind: "rejected" }],
    [slackJson(401, { ok: false }), { kind: "rejected" }],
    [slackJson(403, "forbidden"), { kind: "rejected" }],
    [slackJson(404, "nope"), { kind: "rejected" }],
    [slackJson(200, "not json"), { kind: "unreachable", code: "bad_response" }],
    [slackJson(200, {}), { kind: "unreachable", code: "bad_response" }],
    [slackJson(200, []), { kind: "unreachable", code: "bad_response" }],
    [
      slackJson(200, { ok: "true" }),
      { kind: "unreachable", code: "bad_response" },
    ],
    [
      slackJson(200, { ok: false, error: "x".repeat(70 * 1024) }),
      { kind: "unreachable", code: "oversize" },
    ],
  ];
  for (const [name, call] of calls) {
    for (const [responder, expected] of cases) {
      slack.access = responder;
      slack.authTest = responder;
      const result = await call(slack);
      assert.deepEqual(
        result,
        expected,
        `${name}: ${JSON.stringify(expected)}`,
      );
      assertNoSecrets(JSON.stringify(result));
    }
  }
});

test("a deadline and a refused connection are unreachable", async () => {
  slack.hold("access");
  assert.deepEqual(
    await refreshSlack(FAKE_SLACK_CLIENT, STORED_REFRESH, {
      ...slack.endpoint,
      timeoutMs: 100,
    }),
    { kind: "unreachable", code: "timeout" },
  );
  const closed = createServer();
  await new Promise<void>((resolve) => closed.listen(0, "127.0.0.1", resolve));
  const port = (closed.address() as net.AddressInfo).port;
  await new Promise<void>((resolve) => closed.close(() => resolve()));
  assert.deepEqual(
    await slackAuthTest(DIRECT_ACCESS, {
      connect: { host: "127.0.0.1", port },
      ca: slack.endpoint.ca,
    }),
    { kind: "unreachable", code: "ECONNREFUSED" },
  );
});

// --- connect (AC2) ---------------------------------------------------------

test("a connect stores the refresh token and whose it is, answers the workspace, and keeps the access token in memory only", async () => {
  const h = harness();
  const answer = await h.connect();
  assert.deepEqual(answer, {
    ok: true,
    teamId: FAKE_TEAM_ID,
    teamName: FAKE_TEAM_NAME,
  });
  assert.deepEqual(h.stored(), {
    kind: "slack-oauth",
    v: 1,
    teamId: FAKE_TEAM_ID,
    teamName: FAKE_TEAM_NAME,
    workspaceHost: FAKE_WORKSPACE_HOST,
    userId: FAKE_USER_ID,
    refreshToken: slack.issuedRefresh.at(-1),
    scope: FAKE_SLACK_SCOPE,
  });
  assert.equal(h.bytes().includes(slack.issuedAccess.at(-1)!), false);
  assertNoSecrets(JSON.stringify(answer));
  assertNoSecrets(h.lines.join("\n"));
  await h.port.close();
});

test("a workspace name that is missing, empty or too long is dropped, not refused", async () => {
  for (const name of [undefined, "", "n".repeat(257), 7]) {
    slack.access = exchangeAnswer(
      {},
      { team: { id: FAKE_TEAM_ID, ...(name !== undefined ? { name } : {}) } },
    );
    const h = harness();
    assert.deepEqual(await h.connect(), { ok: true, teamId: FAKE_TEAM_ID });
    assert.equal("teamName" in h.stored(), false);
    assert.equal("teamName" in view(await h.get()), false);
    await h.port.close();
  }
});

test("an exchange answer outside the documented user-token shape is rejected and stores nothing", async () => {
  const cases: [string, SlackResponder, string][] = [
    [
      "no refresh token (rotation off)",
      exchangeAnswer({ refresh_token: undefined, expires_in: undefined }),
      "Slack granted no refresh token",
    ],
    // Rotation off, as Slack may also say it: PR2's live smoke reads the line.
    [
      "a null refresh token (rotation off)",
      exchangeAnswer({ refresh_token: null, expires_in: undefined }),
      "Slack granted no refresh token",
    ],
    [
      "an empty refresh token (rotation off)",
      exchangeAnswer({ refresh_token: "" }),
      "Slack granted no refresh token",
    ],
    [
      "a non-string refresh token",
      exchangeAnswer({ refresh_token: 7 }),
      "Slack exchange answer unusable",
    ],
    [
      "a bot token_type",
      exchangeAnswer({ token_type: "bot" }),
      "Slack exchange answer unusable",
    ],
    [
      "only a top-level (bot) access token",
      slackJson(200, {
        ok: true,
        access_token: FAKE_SLACK_TOKENS.botAccess,
        token_type: "bot",
        scope: "commands",
        bot_user_id: "UFAKEBOT1",
        team: { id: FAKE_TEAM_ID, name: FAKE_TEAM_NAME },
      }),
      "Slack exchange answer unusable",
    ],
    [
      "a malformed user id",
      exchangeAnswer({ id: "not-a-user" }),
      "Slack exchange answer unusable",
    ],
    [
      "a malformed team id",
      exchangeAnswer({}, { team: { id: "fake-team", name: FAKE_TEAM_NAME } }),
      "Slack exchange answer unusable",
    ],
    [
      "no team",
      exchangeAnswer({}, { team: undefined }),
      "Slack exchange answer unusable",
    ],
    [
      "an access token with a space",
      exchangeAnswer({ access_token: "fake slack access" }),
      "Slack exchange answer unusable",
    ],

    [
      "a fractional expires_in",
      exchangeAnswer({ expires_in: 1.5 }),
      "Slack exchange answer unusable",
    ],
    [
      "a zero expires_in",
      exchangeAnswer({ expires_in: 0 }),
      "Slack exchange answer unusable",
    ],
    [
      "an expires_in over a year",
      exchangeAnswer({ expires_in: 31_536_001 }),
      "Slack exchange answer unusable",
    ],
    [
      "a non-string scope",
      exchangeAnswer({ scope: ["search:read"] }),
      "Slack exchange answer unusable",
    ],
    [
      "a refused code",
      slackJson(200, { ok: false, error: "invalid_code" }),
      "code exchange rejected",
    ],
  ];
  for (const [name, responder, line] of cases) {
    slack.reset();
    slack.access = responder;
    const h = harness();
    const answer = await h.connect();
    assert.deepEqual(answer, { ok: false, rejected: true }, name);
    assert.equal(existsSync(h.accounts), false, name);
    assert.equal(slack.on("authTest").length, 0, name);
    assert.deepEqual(
      h.lines,
      [`integration ${integrationDirId("u1", "slack")}: ${line}`],
      name,
    );
    assert.deepEqual(await h.get(), { ok: false, absent: true }, name);
    await h.port.close();
  }
});

test("a transient exchange failure is unreachable and stores nothing", async () => {
  for (const responder of [
    slackJson(200, { ok: false, error: "ratelimited" }),
    slackJson(503, "busy"),
  ]) {
    slack.access = responder;
    const h = harness();
    assert.deepEqual(await h.connect(), { ok: false, unreachable: true });
    assert.equal(existsSync(h.accounts), false);
    await h.port.close();
  }
});

test("the workspace preset: a match is stored, another workspace is a mismatch and nothing is stored", async () => {
  const matched = harness();
  assert.deepEqual(await matched.connect(FAKE_TEAM_ID), {
    ok: true,
    teamId: FAKE_TEAM_ID,
    teamName: FAKE_TEAM_NAME,
  });
  assert.equal(matched.stored().teamId, FAKE_TEAM_ID);
  await matched.port.close();

  slack.reset();
  const other = harness();
  assert.deepEqual(await other.connect("TOTHER001"), {
    ok: false,
    team: "mismatch",
  });
  assert.equal(existsSync(other.accounts), false);
  assert.equal(slack.on("authTest").length, 0);
  assert.deepEqual(await other.get(), { ok: false, absent: true });
  await other.port.close();
});

test("auth.test naming another user or team, or no Slack workspace URL, is rejected and stores nothing", async () => {
  const cases: [string, SlackResponder, unknown][] = [
    [
      "another user",
      slackJson(200, { ...AUTH_TEST_OK, user_id: "UOTHER001" }),
      { ok: false, rejected: true },
    ],
    [
      "another team",
      slackJson(200, { ...AUTH_TEST_OK, team_id: "TOTHER001" }),
      { ok: false, rejected: true },
    ],
    [
      "a foreign URL",
      slackJson(200, { ...AUTH_TEST_OK, url: "https://evil.example/" }),
      { ok: false, rejected: true },
    ],
    [
      "a lookalike host",
      slackJson(200, { ...AUTH_TEST_OK, url: "https://fake.slack.com.evil/" }),
      { ok: false, rejected: true },
    ],
    [
      "an http URL",
      slackJson(200, {
        ...AUTH_TEST_OK,
        url: `http://${FAKE_WORKSPACE_HOST}/`,
      }),
      { ok: false, rejected: true },
    ],
    [
      "a port",
      slackJson(200, {
        ...AUTH_TEST_OK,
        url: `https://${FAKE_WORKSPACE_HOST}:8443/`,
      }),
      { ok: false, rejected: true },
    ],
    [
      "no URL",
      slackJson(200, { ...AUTH_TEST_OK, url: undefined }),
      { ok: false, rejected: true },
    ],
    [
      "a refused token",
      slackJson(200, { ok: false, error: "invalid_auth" }),
      { ok: false, rejected: true },
    ],
    [
      "a rate limit",
      slackJson(200, { ok: false, error: "ratelimited" }),
      { ok: false, unreachable: true },
    ],
  ];
  for (const [name, responder, expected] of cases) {
    slack.reset();
    slack.authTest = responder;
    const h = harness();
    assert.deepEqual(await h.connect(), expected, name);
    assert.equal(existsSync(h.accounts), false, name);
    assertNoSecrets(h.lines.join("\n"));
    await h.port.close();
  }
});

test("an Enterprise Grid workspace host is accepted", async () => {
  slack.authTest = slackJson(200, {
    ...AUTH_TEST_OK,
    url: "https://fake-org.enterprise.slack.com/",
  });
  const h = harness();
  assert.equal((await h.connect()).ok, true);
  assert.equal(h.stored().workspaceHost, "fake-org.enterprise.slack.com");
  await h.port.close();
});

test("without a Slack client a connect is not configured and sends nothing", async () => {
  const h = harness(undefined, { clients: { atlassian: FAKE_CLIENT } });
  assert.deepEqual(await h.connect(), { ok: false, notConfigured: true });
  assert.equal(slack.seen.length, 0);
  await h.port.close();
});

test("a put cannot write a Slack credential, nor plant a Slack record under Atlassian", async () => {
  const h = harness();
  const planted = JSON.stringify({
    kind: "slack-oauth",
    v: 1,
    teamId: FAKE_TEAM_ID,
    workspaceHost: FAKE_WORKSPACE_HOST,
    userId: FAKE_USER_ID,
    refreshToken: FAKE_SLACK_TOKENS.plantedRefresh,
    scope: "",
  });
  for (const credential of [planted, API_TOKEN_TEXT]) {
    assert.deepEqual(await h.port.integrationPut("u1", "slack", credential), {
      ok: false,
      unavailable: true,
    });
    assert.deepEqual(await h.port.integrationPut("u2", "atlassian", planted), {
      ok: false,
      unavailable: true,
    });
  }
  assert.equal(existsSync(h.accounts), false);
  await h.port.close();
});

test("a Slack record of another kind, or no record at all, is malformed", async () => {
  const h = harness();
  mkdirSync(join(h.file, ".."), { recursive: true });
  for (const text of [
    JSON.stringify({
      kind: "atlassian-oauth",
      v: 1,
      site: FAKE_SITE,
      cloudId: "00000000-0000-4000-8000-00000000fa4e",
      refreshToken: FAKE_PLANTED_REFRESH,
      scope: "",
    }),
    API_TOKEN_TEXT,
    "not json",
    JSON.stringify({ kind: "slack-oauth", v: 2 }),
  ]) {
    writeFileSync(h.file, text);
    assert.deepEqual(await h.get(), { ok: false, unavailable: true }, text);
  }
  assert.equal(slack.seen.length, 0);
  await h.port.close();
});

// --- access reads with rotation (AC3) --------------------------------------

test("(a)-(c) none after connect, one refresh per expiry for five readers, the rotation stored and sent next", async () => {
  const h = harness();
  assert.equal((await h.connect()).ok, true);
  const connectedRefresh = slack.issuedRefresh.at(-1)!;
  const first = view(await h.get());
  assert.deepEqual(Object.keys(first).sort(), [
    "accessToken",
    "expiresAt",
    "kind",
    "scope",
    "teamId",
    "teamName",
    "userId",
    "workspaceHost",
  ]);
  assert.equal(first.kind, "slack-oauth");
  assert.equal(first.teamId, FAKE_TEAM_ID);
  assert.equal(first.teamName, FAKE_TEAM_NAME);
  assert.equal(first.workspaceHost, FAKE_WORKSPACE_HOST);
  assert.equal(first.userId, FAKE_USER_ID);
  assert.equal(first.scope, FAKE_SLACK_SCOPE);
  assert.equal(first.accessToken, slack.issuedAccess.at(-1));
  assert.equal(first.expiresAt, h.clock.now + 43_200_000);
  assert.deepEqual(slack.refreshesSent(), []);

  // (b) Inside the margin: five readers, one refresh, one new token.
  h.clock.now += DUE_MS;
  const views = (
    await Promise.all(Array.from({ length: 5 }, () => h.get()))
  ).map(view);
  assert.deepEqual(slack.refreshesSent(), [connectedRefresh]);
  const rotatedAccess = slack.issuedAccess.at(-1);
  for (const each of views) assert.equal(each.accessToken, rotatedAccess);
  // (c) The record holds the second refresh token; the next refresh sends it.
  const second = slack.issuedRefresh.at(-1)!;
  assert.equal(h.stored().refreshToken, second);
  h.clock.now += DUE_MS;
  view(await h.get());
  assert.deepEqual(slack.refreshesSent(), [connectedRefresh, second]);
  assert.equal(h.stored().refreshToken, slack.issuedRefresh.at(-1));
  await h.port.close();
});

test("(d) a caller's abort during a held refresh answers at once and loses no rotation", async () => {
  const h = harness();
  await h.connect();
  h.clock.now += DUE_MS;
  const held = slack.hold("access");
  const controller = new AbortController();
  const aborted = h.get(controller.signal);
  await held.arrived;
  controller.abort();
  assert.deepEqual(await aborted, { ok: false, unavailable: true });
  held.release();
  // The refresh still ran to its write; the next read joins nothing new.
  const next = view(await h.get());
  assert.equal(h.stored().refreshToken, slack.issuedRefresh.at(-1));
  assert.equal(next.accessToken, slack.issuedAccess.at(-1));
  assert.equal(slack.refreshesSent().length, 1);
  await h.port.close();
});

test("(e) a refused refresh is rejected with the record kept; (f) a transient one retries the same token", async () => {
  const h = harness();
  await h.connect();
  const stored = slack.issuedRefresh.at(-1)!;
  const bytes = h.bytes();
  h.clock.now += DUE_MS;
  slack.access = slackJson(200, { ok: false, error: "invalid_refresh_token" });
  assert.deepEqual(await h.get(), { ok: false, rejected: true });
  assert.equal(h.bytes(), bytes);
  for (const responder of [
    slackJson(200, { ok: false, error: "ratelimited" }),
    slackJson(503, "busy"),
  ]) {
    slack.access = responder;
    assert.deepEqual(await h.get(), { ok: false, unavailable: true });
    assert.equal(h.bytes(), bytes);
  }
  slack.reset();
  view(await h.get());
  assert.deepEqual(slack.refreshesSent(), [stored]);
  await h.port.close();
});

test("(g) a new vault on the same state refreshes on its first read", async () => {
  const h = harness();
  await h.connect();
  await h.port.close();
  const stored = h.stored().refreshToken;
  const again = harness(h.dir);
  view(await again.get());
  assert.deepEqual(slack.refreshesSent(), [stored]);
  await again.port.close();
});

test("(h)-(j) an unusable refresh answer writes, caches and answers nothing, and the next read retries the stored token", async () => {
  const cases: [string, (stored: string) => SlackResponder][] = [
    ["(h) a bot token_type", () => refreshAnswer({ token_type: "bot" })],
    ["(i) no refresh token", () => refreshAnswer({ refresh_token: undefined })],
    ["(i) an empty refresh token", () => refreshAnswer({ refresh_token: "" })],
    [
      "(i) the stored refresh token again",
      (stored) => refreshAnswer({ refresh_token: stored }),
    ],
    [
      "(j) the exchange's nested shape",
      () =>
        slackJson(200, {
          ok: true,
          authed_user: {
            id: FAKE_USER_ID,
            scope: FAKE_SLACK_SCOPE,
            access_token: FAKE_SLACK_TOKENS.nestedAccess,
            expires_in: 43_200,
            refresh_token: FAKE_SLACK_TOKENS.nestedRefresh,
            token_type: "user",
          },
          team: { id: FAKE_TEAM_ID },
        }),
    ],
    [
      "a missing access token",
      () => refreshAnswer({ access_token: undefined }),
    ],
    ["a fractional expires_in", () => refreshAnswer({ expires_in: 60.5 })],
    ["a non-string scope", () => refreshAnswer({ scope: 7 })],
  ];
  for (const [name, responder] of cases) {
    slack.reset();
    const h = harness();
    await h.connect();
    const stored = slack.issuedRefresh.at(-1)!;
    const bytes = h.bytes();
    h.clock.now += DUE_MS;
    slack.access = responder(stored);
    const answer = await h.get();
    assert.deepEqual(answer, { ok: false, unavailable: true }, name);
    assert.equal(h.bytes(), bytes, name);
    assert.equal(
      h.lines.at(-1),
      `integration ${integrationDirId("u1", "slack")}: Slack refresh answer unusable`,
      name,
    );
    assertNoSecrets(h.lines.join("\n"));
    // Nothing cached: the next read refreshes again, with the stored token.
    slack.access = responder(stored);
    assert.deepEqual(await h.get(), { ok: false, unavailable: true }, name);
    assert.deepEqual(slack.refreshesSent(), [stored, stored], name);
    await h.port.close();
  }
});

test("without a Slack client a due read is unavailable and sends nothing", async () => {
  const h = harness();
  await h.connect();
  await h.port.close();
  slack.reset();
  const again = harness(h.dir, { clients: {} });
  assert.deepEqual(await again.get(), { ok: false, unavailable: true });
  assert.equal(slack.seen.length, 0);
  await again.port.close();
});

// --- beside Atlassian (AC6) ------------------------------------------------

test("one user holds Atlassian and Slack: each refreshes with its own provider, and clearing Slack leaves Atlassian", async () => {
  const h = harness(undefined, {
    clients: { atlassian: FAKE_CLIENT, slack: FAKE_SLACK_CLIENT },
    atlassianEndpoint: atlassian.endpoint,
  });
  const connectAtlassian = () =>
    h.port.integrationConnect("u1", "atlassian", {
      code: FAKE_CODE,
      redirectUri: FAKE_REDIRECT,
    });
  const atlassianConnected = await connectAtlassian();
  assert.equal(atlassianConnected.ok, true);
  assert.equal((await h.connect()).ok, true);
  const atlassianRefresh = atlassian.issuedRefresh.at(-1)!;
  const slackRefresh = slack.issuedRefresh.at(-1)!;
  assert.equal(
    view(await h.port.integrationGet("u1", "atlassian")).kind,
    "atlassian-oauth",
  );
  assert.equal(view(await h.get()).kind, "slack-oauth");

  // Both due: each provider sees only its own refresh token.
  h.clock.now += DUE_MS;
  const [atlassianView, slackView] = await Promise.all([
    h.port.integrationGet("u1", "atlassian"),
    h.get(),
  ]);
  assert.equal(view(atlassianView).site, FAKE_SITE);
  assert.equal(view(slackView).teamId, FAKE_TEAM_ID);
  const atlassianSent = atlassian
    .on("token")
    .map((request) => JSON.parse(request.body) as Record<string, string>)
    .filter((body) => body.grant_type === "refresh_token")
    .map((body) => body.refresh_token);
  assert.deepEqual(atlassianSent, [atlassianRefresh]);
  assert.deepEqual(slack.refreshesSent(), [slackRefresh]);

  // Clearing Slack leaves the Atlassian record and its access view.
  assert.deepEqual(await h.port.integrationClear("u1", "slack"), { ok: true });
  assert.deepEqual(await h.get(), { ok: false, absent: true });
  assert.equal(
    view(await h.port.integrationGet("u1", "atlassian")).kind,
    "atlassian-oauth",
  );
  assert.deepEqual(readdirSync(h.accounts), [
    integrationDirId("u1", "atlassian"),
  ]);
  await h.port.close();
});

test("a refreshed record that cannot be saved answers unavailable, caches nothing and holds no token", async () => {
  const h = harness();
  assert.equal((await h.connect()).ok, true);
  const connectedRefresh = h.stored().refreshToken;
  // The record's directory refuses the write once.
  chmodSync(dirname(h.file), 0o500);
  h.clock.now += DUE_MS;
  let answer: IntegrationRecord;
  try {
    answer = await h.get();
  } finally {
    chmodSync(dirname(h.file), 0o700);
  }
  assert.deepEqual(answer, { ok: false, unavailable: true });
  assert.equal(h.stored().refreshToken, connectedRefresh);
  assert.ok(
    h.lines.some((line) => line.endsWith("the refreshed record was not saved")),
  );
  // Nothing was cached: the next get refreshes again.
  const next = view(await h.get());
  assert.deepEqual(slack.refreshesSent(), [connectedRefresh, connectedRefresh]);
  assert.equal(next.accessToken, slack.issuedAccess.at(-1));
  assert.equal(h.stored().refreshToken, slack.issuedRefresh.at(-1));
  assertNoSecrets(JSON.stringify(answer));
  assertNoSecrets(h.lines.join("\n"));
  await h.port.close();
});

test("a connected record that cannot be saved answers unavailable and caches nothing", async () => {
  const h = harness();
  mkdirSync(dirname(h.file), { recursive: true });
  chmodSync(dirname(h.file), 0o500);
  let answer: Awaited<ReturnType<typeof h.connect>>;
  try {
    answer = await h.connect();
  } finally {
    chmodSync(dirname(h.file), 0o700);
  }
  assert.deepEqual(answer, { ok: false, unavailable: true });
  assert.equal(existsSync(h.file), false);
  assert.ok(
    h.lines.some((line) => line.endsWith("the connected record was not saved")),
  );
  assert.deepEqual(await h.get(), { ok: false, absent: true });
  assertNoSecrets(JSON.stringify(answer));
  assertNoSecrets(h.lines.join("\n"));
  await h.port.close();
});
