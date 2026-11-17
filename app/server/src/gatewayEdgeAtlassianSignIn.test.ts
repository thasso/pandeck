/**
 * "Sign in with Atlassian" end to end (Task-1411 PR2, AC11): a vault process
 * holding the Atlassian OAuth client and talking to the loopback Atlassian
 * fake, and `startEdge` linked to it with a UI config naming only
 * `atlassian.clientId`. A signed-in browser starts the connect, comes back
 * through the callback with the code, and the vault exchanges it with the
 * same redirect URI the authorize URL named. The page then refuses a new API
 * token, and the state, code, client secret and refresh tokens reach no edge
 * answer or log line beyond the state's own authorize URL. Every value is
 * fake.
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
  FAKE_CLIENT,
  FAKE_CODE,
  FAKE_SITE,
  jsonResponder,
  startAtlassianFake,
} from "./test/atlassianFake.ts";
import {
  CLIENT_ID,
  CLIENT_PW,
  PUBLIC_ORIGIN,
  startFakeIssuer,
  type FakeIssuer,
} from "./test/gatewayUiIssuer.ts";

const EDGE_ISSUER = "https://issuer.test";
const CALLBACK = `${PUBLIC_ORIGIN}/auth/atlassian/callback`;
const MUTATION = { origin: PUBLIC_ORIGIN, "x-gateway-ui": "1" };

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

test("AC11: sign in, connect through the callback, and the vault stores the OAuth record; nothing secret reaches an edge answer or line", async () => {
  // Atlassian and the vault holding the client.
  const atl = await startAtlassianFake();
  open.push({ close: () => atl.close() });
  const vaultId = selfSignedIdentity("pandeck-gateway-vault", "server", [
    "localhost",
    "127.0.0.1",
  ]);
  const edgeId = selfSignedIdentity("pandeck-gateway-edge", "client");
  mkdirSync(DATA_DIR, { recursive: true });
  const vaultDir = mkdtempSync(join(DATA_DIR, "gateway-signin-vault-"));
  const vault = await startVaultServer({
    stateDir: vaultDir,
    port: 0,
    tls: {
      keyPem: vaultId.keyPem,
      certPem: vaultId.certPem,
      peerCertPem: edgeId.certPem,
    },
    controlSocket: join(vaultDir, "control.sock"),
    log: () => {},
    integrationClients: { atlassian: FAKE_CLIENT },
    atlassianEndpoint: atl.endpoint,
  });
  open.push(vault);

  // The edge: a UI config naming only the client id, linked to the vault.
  const issuer: FakeIssuer = await startFakeIssuer({
    advertised: EDGE_ISSUER,
    now: () => Date.now(),
  });
  open.push({ close: () => issuer.close() });
  const dir = mkdtempSync(join(DATA_DIR, "gateway-signin-edge-"));
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
      atlassian: { clientId: FAKE_CLIENT.clientId },
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

  // Every answer the edge gives the browser.
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

  // Sign in to the page.
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
        await request("/api/integrations/atlassian", {
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
  assert.deepEqual(before, { connected: false, connectWith: "oauth" });

  // Start, then come back from Atlassian with the code.
  const started = await request("/api/integrations/atlassian/connect", {
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
  assert.equal(authorize.searchParams.get("client_id"), FAKE_CLIENT.clientId);
  assert.equal(authorize.searchParams.get("redirect_uri"), CALLBACK);
  assert.match(authorize.searchParams.get("scope")!, /\boffline_access\b/);
  const state = authorize.searchParams.get("state")!;
  const pending = `__Host-pgw_atlassian=${cookieValue(started, "__Host-pgw_atlassian")!}`;
  // Every get refreshes from here (the token expires within the margin).
  atl.expiresInS = 60;
  const back = await request(
    `/auth/atlassian/callback?${new URLSearchParams({ code: FAKE_CODE, state })}`,
    { headers: { cookie: `${session}; ${pending}` } },
  );
  assert.equal(back.status, 303);
  assert.equal(back.headers.location, "/");

  // The vault exchanged the code with the authorize URL's redirect URI.
  const exchanges = atl
    .on("token")
    .map((seen) => JSON.parse(seen.body) as Record<string, string>)
    .filter((body) => body.grant_type === "authorization_code");
  assert.equal(exchanges.length, 1);
  assert.equal(exchanges[0]!.code, FAKE_CODE);
  assert.equal(
    exchanges[0]!.redirect_uri,
    authorize.searchParams.get("redirect_uri"),
  );

  assert.deepEqual(await status(), {
    connected: true,
    kind: "oauth",
    site: FAKE_SITE,
    connectWith: "oauth",
  });
  // D2: a new API token is refused on this gateway's page.
  const set = await request("/api/integrations/atlassian/set", {
    method: "POST",
    headers: {
      ...MUTATION,
      cookie: session,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      site: FAKE_SITE,
      email: "person@example.org",
      token: "FAKE-API-TOKEN-REFUSED",
    }),
  });
  assert.equal(set.status, 409);
  assert.deepEqual(JSON.parse(set.body), {
    error: "integration_sign_in_required",
  });
  // A refused refresh: the OAuth record's problem, on the page too.
  atl.token = jsonResponder(400, { error: "invalid_grant" });
  assert.deepEqual(await status(), {
    connected: false,
    kind: "oauth",
    problem: "rejected",
    connectWith: "oauth",
  });

  // The state is in exactly one edge answer, its start's authorize URL.
  const carrying = answers.filter(
    (answer) =>
      answer.body.includes(state) ||
      JSON.stringify(answer.headers).includes(state),
  );
  assert.deepEqual(carrying, [started]);
  assert.ok(!JSON.stringify(started.headers).includes(state));
  for (const line of lines) assert.ok(!line.includes(state), line);
  // The code, the client secret and every refresh token: nowhere at all.
  assert.ok(atl.issuedRefresh.length >= 2, "the fake issued refresh tokens");
  const seen = [
    ...answers.map((answer) => answer.body + JSON.stringify(answer.headers)),
    ...lines,
  ].join("\n");
  for (const secret of [
    FAKE_CODE,
    FAKE_CLIENT.clientSecret,
    "FAKE-API-TOKEN-REFUSED",
    ...atl.issuedRefresh,
  ])
    assert.ok(!seen.includes(secret), "an edge answer or line leaked");
});
