/**
 * "Sign in with Slack" end to end (Task-1453, AC9): a vault process holding
 * the Slack OAuth client and talking to the loopback Slack fake, and
 * `startEdge` linked to it with a UI config naming `slack.clientId` (and
 * `slack.teamId` where a case says so). A signed-in browser starts the
 * connect, comes back through the callback with the code, and the vault
 * exchanges it with the same redirect URI the authorize URL named; the page
 * then reads the status, which refreshes in the vault, and clears. A foreign
 * workspace, a grant without a refresh token and an unsafe workspace name
 * each end as the page expects, and the code, client secret, tokens, state
 * and name reach no edge answer or log line beyond the state's own authorize
 * URL. Every value is fake.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type http from "node:http";
import https from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, test, vi } from "vitest";
import { DATA_DIR } from "./config.ts";
import { edgeVaultLinkFile } from "./gateway/vaultMethods.ts";
import { startVaultServer } from "./gateway/vaultServer.ts";
import { edgeTlsFor, selfSignedIdentity } from "./gateway/x509.ts";
import { startEdge } from "./gatewayEdge.ts";
import {
  CLIENT_ID,
  CLIENT_PW,
  PUBLIC_ORIGIN,
  startFakeIssuer,
  type FakeIssuer,
} from "./test/gatewayUiIssuer.ts";
import {
  FAKE_SLACK_CLIENT,
  FAKE_SLACK_CODE,
  FAKE_TEAM_ID,
  FAKE_TEAM_NAME,
  startSlackFake,
  type SlackFake,
  type SlackResponder,
} from "./test/slackFake.ts";

const EDGE_ISSUER = "https://issuer.test";
/** Not `FAKE_SLACK_REDIRECT`: the edge's own public origin names it. */
const CALLBACK = `${PUBLIC_ORIGIN}/auth/slack/callback`;
const MUTATION = { origin: PUBLIC_ORIGIN, "x-gateway-ui": "1" };
const UNSAFE_TEAM_NAME = "Fake\u001b[2JWork\u202espace";

const edgeTls = edgeTlsFor(["localhost", "127.0.0.1"], undefined);
const agent = new https.Agent({ ca: edgeTls.caCertPem, keepAlive: true });
const open: { close(): unknown }[] = [];
let distDir: string;

interface Answer {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}

beforeAll(() => {
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

afterAll(() => {
  agent.destroy();
  rmSync(distDir, { recursive: true, force: true });
});

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** The fake's answer to the code exchange, changed by `change`. */
function exchangeAs(
  slack: SlackFake,
  change: (body: Record<string, unknown>) => Record<string, unknown>,
): SlackResponder {
  const original = slack.access;
  return (seen, res) =>
    original(seen, {
      raw: res.raw,
      status: (code, body) =>
        res.status(
          code,
          seen.form.grant_type === "refresh_token"
            ? body
            : change(body as Record<string, unknown>),
        ),
    });
}

/**
 * A vault with the Slack client and fake, an edge linked to it whose UI
 * config names `slack` as given, and a browser signed in to its page.
 */
async function setUp(slackPreset: Record<string, unknown>) {
  const slack = await startSlackFake();
  open.push({ close: () => slack.close() });
  const vaultId = selfSignedIdentity("pandeck-gateway-vault", "server", [
    "localhost",
    "127.0.0.1",
  ]);
  const edgeId = selfSignedIdentity("pandeck-gateway-edge", "client");
  mkdirSync(DATA_DIR, { recursive: true });
  const vaultDir = mkdtempSync(join(DATA_DIR, "gateway-slack-vault-"));
  const vaultLines: string[] = [];
  const vault = await startVaultServer({
    stateDir: vaultDir,
    port: 0,
    tls: {
      keyPem: vaultId.keyPem,
      certPem: vaultId.certPem,
      peerCertPem: edgeId.certPem,
    },
    controlSocket: join(vaultDir, "control.sock"),
    log: (line) => vaultLines.push(line),
    integrationClients: { slack: FAKE_SLACK_CLIENT },
    slackEndpoint: slack.endpoint,
  });
  open.push(vault);

  const issuer: FakeIssuer = await startFakeIssuer({
    advertised: EDGE_ISSUER,
    now: () => Date.now(),
  });
  open.push({ close: () => issuer.close() });
  const dir = mkdtempSync(join(DATA_DIR, "gateway-slack-edge-"));
  writeFileSync(join(dir, "cert.pem"), edgeTls.serverCertPem);
  writeFileSync(join(dir, "key.pem"), edgeTls.serverKeyPem, { mode: 0o600 });
  const uiConfig = join(dir, "ui.json");
  writeFileSync(
    uiConfig,
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
      slack: slackPreset,
    }),
    { mode: 0o600 },
  );
  const stateDir = join(dir, "state");
  mkdirSync(stateDir, { mode: 0o700 });
  edgeVaultLinkFile(stateDir).write({
    v: 1,
    keyPem: edgeId.keyPem,
    certPem: edgeId.certPem,
    vaultCertPem: vaultId.certPem,
  });
  // Every line the edge writes, its own and the console's.
  const lines: string[] = [];
  vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  });
  const edge = await startEdge(
    {
      stateDir,
      port: 0,
      modelPort: 0,
      clientPort: 0,
      enrollPort: 0,
      uiConfig,
      vault: { host: "127.0.0.1", port: vault.port },
    },
    {
      log: (line) => lines.push(line),
      oidcTestOptions: {
        fetch: (url, init) =>
          fetch(url.replace(EDGE_ISSUER, issuer.listening), init),
      },
    },
  );
  open.push(edge);
  const port = edge.uiPort!;

  const answers: Answer[] = [];
  const request = (
    path: string,
    options: {
      method?: string;
      headers?: Record<string, string>;
      body?: string;
    } = {},
  ): Promise<Answer> =>
    new Promise((resolve, reject) => {
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
      req.on("error", reject);
      req.end(options.body);
    });
  const cookieValue = (answer: Answer, name: string) =>
    (answer.headers["set-cookie"] ?? [])
      .find((line) => line.startsWith(`${name}=`))
      ?.slice(name.length + 1)
      .split(";")[0];

  const login = await request("/auth/login");
  const provider = new URL(login.headers.location!);
  const signedIn = await request(
    `/auth/callback?${new URLSearchParams({
      code: issuer.authorize(provider),
      state: provider.searchParams.get("state")!,
    })}`,
    {
      headers: {
        cookie: `__Host-pgw_signin=${cookieValue(login, "__Host-pgw_signin")!}`,
      },
    },
  );
  const session = `__Host-pgw_session=${cookieValue(signedIn, "__Host-pgw_session")!}`;

  const status = async () =>
    JSON.parse(
      (
        await request("/api/integrations/slack", {
          headers: { cookie: session },
        })
      ).body,
    ) as Record<string, unknown>;
  // The vault link comes up after the edge starts.
  let before: Record<string, unknown> = {};
  for (let i = 0; i < 200; i++) {
    before = await status();
    if (before.problem !== "vault_unavailable") break;
    await delay(25);
  }
  assert.deepEqual(before, { offered: true, connected: false });

  /** Start, then come back from Slack with the code. */
  const signInWithSlack = async () => {
    const started = await request("/api/integrations/slack/connect", {
      method: "POST",
      headers: {
        ...MUTATION,
        cookie: session,
        "content-type": "application/json",
      },
      body: "{}",
    });
    assert.equal(started.status, 200);
    const authorize = new URL(
      (JSON.parse(started.body) as { authorizeUrl: string }).authorizeUrl,
    );
    const state = authorize.searchParams.get("state")!;
    const pending = `__Host-pgw_slack=${cookieValue(started, "__Host-pgw_slack")!}`;
    const back = await request(
      `/auth/slack/callback?${new URLSearchParams({ code: FAKE_SLACK_CODE, state })}`,
      { headers: { cookie: `${session}; ${pending}` } },
    );
    assert.equal(back.status, 303);
    return { started, authorize, state, location: back.headers.location };
  };

  /** No edge answer or edge/vault line holds a secret; the state only once. */
  const nothingLeaked = (states: { state: string; started: Answer }[]) => {
    for (const { state, started } of states) {
      const carrying = answers.filter(
        (answer) =>
          answer.body.includes(state) ||
          JSON.stringify(answer.headers).includes(state),
      );
      assert.deepEqual(carrying, [started]);
      for (const line of [...lines, ...vaultLines])
        assert.ok(!line.includes(state), line);
    }
    const seen = [
      ...answers.map((answer) => answer.body + JSON.stringify(answer.headers)),
      ...lines,
      ...vaultLines,
    ].join("\n");
    for (const secret of [
      FAKE_SLACK_CODE,
      FAKE_SLACK_CLIENT.clientSecret,
      ...slack.issuedRefresh,
      ...slack.issuedAccess,
    ])
      assert.ok(!seen.includes(secret), "an edge answer or line leaked");
    for (const line of [...lines, ...vaultLines])
      assert.ok(
        !line.includes(FAKE_TEAM_NAME) && !line.includes("Work\u202espace"),
        line,
      );
  };

  return {
    slack,
    vaultLines,
    lines,
    request,
    session,
    status,
    signInWithSlack,
    nothingLeaked,
  };
}

test("(a, e, f, g) sign in, the status refreshes twice in the vault, clear; nothing secret reaches an edge answer or line", async () => {
  const ui = await setUp({ clientId: FAKE_SLACK_CLIENT.clientId });
  // Every get refreshes from here (the token expires within the margin).
  ui.slack.expiresInS = 60;
  const signedIn = await ui.signInWithSlack();
  assert.equal(signedIn.location, "/");
  assert.equal(signedIn.authorize.searchParams.get("team"), null);
  assert.equal(signedIn.authorize.searchParams.get("redirect_uri"), CALLBACK);
  // The vault exchanged the code with the authorize URL's redirect URI.
  const exchanges = ui.slack
    .on("access")
    .filter((seen) => seen.form.grant_type !== "refresh_token");
  assert.equal(exchanges.length, 1);
  assert.equal(exchanges[0]!.form.code, FAKE_SLACK_CODE);
  assert.equal(exchanges[0]!.form.redirect_uri, CALLBACK);

  // (e) Two status reads, each a chained refresh.
  const connected = {
    offered: true,
    connected: true,
    teamName: FAKE_TEAM_NAME,
  };
  assert.deepEqual(await ui.status(), connected);
  assert.deepEqual(await ui.status(), connected);
  assert.deepEqual(ui.slack.refreshesSent(), [
    ui.slack.issuedRefresh[0],
    ui.slack.issuedRefresh[1],
  ]);
  assert.ok(
    !ui.vaultLines.some((line) =>
      line.includes("Slack refresh answer unusable"),
    ),
  );

  // (f) Clear.
  const cleared = await ui.request("/api/integrations/slack/clear", {
    method: "POST",
    headers: {
      ...MUTATION,
      cookie: ui.session,
      "content-type": "application/json",
    },
    body: "{}",
  });
  assert.equal(cleared.status, 204);
  assert.deepEqual(await ui.status(), { offered: true, connected: false });
  assert.ok(
    ui.lines.some((line) =>
      line.includes("ui integration slack: cleared user="),
    ),
  );

  // (g)
  ui.nothingLeaked([signedIn]);
});

test("(b) with teamId the URL carries it and the connect succeeds; another workspace is team_mismatch", async () => {
  const same = await setUp({
    clientId: FAKE_SLACK_CLIENT.clientId,
    teamId: FAKE_TEAM_ID,
  });
  const ok = await same.signInWithSlack();
  assert.equal(ok.authorize.searchParams.get("team"), FAKE_TEAM_ID);
  assert.equal(ok.location, "/");
  assert.equal((await same.status()).connected, true);
  same.nothingLeaked([ok]);
  while (open.length) await open.pop()!.close();
  vi.restoreAllMocks();

  const other = await setUp({
    clientId: FAKE_SLACK_CLIENT.clientId,
    teamId: "TOTHER0001",
  });
  const refused = await other.signInWithSlack();
  assert.equal(refused.authorize.searchParams.get("team"), "TOTHER0001");
  assert.equal(refused.location, "/?slack=team_mismatch");
  assert.deepEqual(await other.status(), { offered: true, connected: false });
  assert.ok(
    other.vaultLines.some((line) =>
      line.includes("Slack granted another workspace"),
    ),
  );
  // The identity check never ran.
  assert.deepEqual(other.slack.on("authTest"), []);
  other.nothingLeaked([refused]);
});

test("(c) a grant without a refresh token is rejected", async () => {
  const ui = await setUp({ clientId: FAKE_SLACK_CLIENT.clientId });
  ui.slack.access = exchangeAs(ui.slack, (body) => {
    const { refresh_token: _refresh, ...user } = body.authed_user as Record<
      string,
      unknown
    >;
    return { ...body, authed_user: user };
  });
  const refused = await ui.signInWithSlack();
  assert.equal(refused.location, "/?slack=rejected");
  assert.deepEqual(await ui.status(), { offered: true, connected: false });
  assert.ok(
    ui.vaultLines.some((line) =>
      line.includes("Slack granted no refresh token"),
    ),
  );
  ui.nothingLeaked([refused]);
});

test("(d) F004: a workspace name the page could not show is connected without it, and in no line", async () => {
  const ui = await setUp({ clientId: FAKE_SLACK_CLIENT.clientId });
  ui.slack.access = exchangeAs(ui.slack, (body) => ({
    ...body,
    team: { id: FAKE_TEAM_ID, name: UNSAFE_TEAM_NAME },
  }));
  const signedIn = await ui.signInWithSlack();
  assert.equal(signedIn.location, "/");
  const status = await ui.request("/api/integrations/slack", {
    headers: { cookie: ui.session },
  });
  assert.deepEqual(JSON.parse(status.body), { offered: true, connected: true });
  assert.ok(!status.body.includes("Work"));
  ui.nothingLeaked([signedIn]);
});
