/**
 * "Connect GitHub" and the page's repository check end to end (Task-1445,
 * AC8): a vault process holding the GitHub App's client and talking to the
 * loopback GitHub fake (S1a-shaped), and `startEdge` linked to it with a UI
 * config naming `github.clientId`. A signed-in browser connects through the
 * callback, reads the status (which may refresh in the vault), checks
 * repositories (the edge's only `github.token` caller, which drops the token)
 * and disconnects.
 *
 * Every case builds its own fake, vault and edge (`setUp`) and shares
 * nothing: the vault's installation-token cache, keyed
 * `<installationId>/<repositoryId>` and reused while more than ten minutes
 * remain, lives as long as the vault process and survives a clear and a
 * reconnect, so on a shared vault every later check would reuse one case's
 * token and never reach `mint`. `afterEach` checks that case's answers,
 * edge and vault lines and both state dirs for secrets (AC7) before it
 * closes the fixture, and closes it even when that check fails. Every value
 * is fake.
 */
import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
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
  FAKE_GITHUB_CLIENT,
  FAKE_GITHUB_CODE,
  FAKE_GITHUB_OTHER,
  fakeGithubApp,
  githubJson,
  githubTime,
  startGithubFake,
  type FakeGithubUser,
  type GithubFake,
} from "./test/githubFake.ts";

const EDGE_ISSUER = "https://issuer.test";
const CALLBACK = `${PUBLIC_ORIGIN}/auth/github/callback`;
const MUTATION = { origin: PUBLIC_ORIGIN, "x-gateway-ui": "1" };
const CHECK_PATH = "/api/integrations/github/check";
const CONNECT_PATH = "/api/integrations/github/connect";
const OWNER = "castlabs";
const S1 = "pandeck-gateway-s1";
const S1_NOAPP = "pandeck-gateway-s1-noapp";
const S1_PRIVATE = "pandeck-gateway-s1-private";
const S1_ID = 9_001;

const edgeTls = edgeTlsFor(["localhost", "127.0.0.1"], undefined);
const agent = new https.Agent({ ca: edgeTls.caCertPem, keepAlive: true });
let distDir: string;

interface Answer {
  path: string;
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}

type Fixture = Awaited<ReturnType<typeof setUp>>;
/** This case's closers, last opened first closed, and its fixture. */
const open: { close(): unknown }[] = [];
let current: Fixture | undefined;

beforeAll(() => {
  distDir = mkdtempSync(join(tmpdir(), "gateway-dist-"));
  writeFileSync(
    join(distDir, "gateway.html"),
    "<!doctype html><title>g</title>",
  );
});

afterEach(async () => {
  try {
    if (current) assertRedacted(current);
  } finally {
    current = undefined;
    vi.restoreAllMocks();
    while (open.length) await open.pop()!.close();
  }
});

afterAll(() => {
  agent.destroy();
  rmSync(distDir, { recursive: true, force: true });
});

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Every regular file under `dir`, with its text. */
function filesUnder(dir: string): { path: string; text: string }[] {
  const files: { path: string; text: string }[] = [];
  for (const entry of readdirSync(dir, {
    withFileTypes: true,
    recursive: true,
  })) {
    if (!entry.isFile()) continue;
    const path = join(entry.parentPath, entry.name);
    files.push({ path, text: readFileSync(path, "latin1") });
  }
  return files;
}

/**
 * A GitHub fake with S1a's three scratch repositories, a vault holding the
 * App's client (unless `githubApp` is false) and that fake, an edge linked to
 * it whose UI config names `github.clientId`, and a browser signed in to its
 * page. `expiresInS` and `identity` apply to this fake before any connect.
 */
async function setUp(
  options: {
    expiresInS?: number;
    identity?: FakeGithubUser;
    githubApp?: boolean;
  } = {},
) {
  const fake: GithubFake = await startGithubFake();
  open.push({ close: () => fake.close() });
  if (options.expiresInS !== undefined) fake.expiresInS = options.expiresInS;
  if (options.identity !== undefined) fake.identity = options.identity;
  fake.addRepository(`${OWNER}/${S1}`, S1_ID, ["fake-user"]);
  fake.addRepository(`${OWNER}/${S1_NOAPP}`, 9_002, ["fake-user"]);
  fake.repositories.get(`${OWNER}/${S1_NOAPP}`)!.noApp = true;
  fake.addRepository(`${OWNER}/${S1_PRIVATE}`, 9_003, []);

  const vaultId = selfSignedIdentity("pandeck-gateway-vault", "server", [
    "localhost",
    "127.0.0.1",
  ]);
  const edgeId = selfSignedIdentity("pandeck-gateway-edge", "client");
  mkdirSync(DATA_DIR, { recursive: true });
  const vaultStateDir = mkdtempSync(join(DATA_DIR, "gateway-github-vault-"));
  open.push({
    close: () => rmSync(vaultStateDir, { recursive: true, force: true }),
  });
  const vaultLines: string[] = [];
  const vault = await startVaultServer({
    stateDir: vaultStateDir,
    port: 0,
    tls: {
      keyPem: vaultId.keyPem,
      certPem: vaultId.certPem,
      peerCertPem: edgeId.certPem,
    },
    controlSocket: join(vaultStateDir, "control.sock"),
    log: (line) => vaultLines.push(line),
    integrationClients:
      options.githubApp === false ? {} : { github: fakeGithubApp().client },
    githubEndpoint: fake.endpoint,
  });
  open.push(vault);

  const issuer: FakeIssuer = await startFakeIssuer({
    advertised: EDGE_ISSUER,
    now: () => Date.now(),
  });
  open.push({ close: () => issuer.close() });
  const dir = mkdtempSync(join(DATA_DIR, "gateway-github-edge-"));
  open.push({ close: () => rmSync(dir, { recursive: true, force: true }) });
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
      github: { clientId: FAKE_GITHUB_CLIENT.clientId },
    }),
    { mode: 0o600 },
  );
  const edgeStateDir = join(dir, "state");
  mkdirSync(edgeStateDir, { mode: 0o700 });
  edgeVaultLinkFile(edgeStateDir).write({
    v: 1,
    keyPem: edgeId.keyPem,
    certPem: edgeId.certPem,
    vaultCertPem: vaultId.certPem,
  });
  // Every line the edge writes, its own and the console's.
  const edgeLines: string[] = [];
  vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    edgeLines.push(args.map(String).join(" "));
  });
  const edge = await startEdge(
    {
      stateDir: edgeStateDir,
      port: 0,
      modelPort: 0,
      clientPort: 0,
      enrollPort: 0,
      uiConfig,
      vault: { host: "127.0.0.1", port: vault.port },
    },
    {
      log: (line) => edgeLines.push(line),
      oidcTestOptions: {
        fetch: (url, init) =>
          fetch(url.replace(EDGE_ISSUER, issuer.listening), init),
      },
    },
  );
  open.push(edge);
  const port = edge.uiPort!;

  const answers: Answer[] = [];
  const states: string[] = [];
  const request = (
    path: string,
    init: {
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
          method: init.method ?? "GET",
          headers: {
            ...init.headers,
            ...(init.body === undefined
              ? {}
              : { "content-length": String(Buffer.byteLength(init.body)) }),
          },
          agent,
        },
        (res) => {
          let body = "";
          res.setEncoding("utf8");
          res.on("data", (chunk: string) => (body += chunk));
          res.on("end", () => {
            const answer = {
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
      req.end(init.body);
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
  const sessionValue = cookieValue(signedIn, "__Host-pgw_session")!;
  const session = `__Host-pgw_session=${sessionValue}`;
  const cookieValues = [sessionValue];

  const post = (path: string, body: unknown = {}) =>
    request(path, {
      method: "POST",
      headers: {
        ...MUTATION,
        cookie: session,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });
  const status = async () =>
    JSON.parse(
      (
        await request("/api/integrations/github", {
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

  /** A start, and the browser coming back from GitHub with `query`. */
  const callback = async (query: (state: string) => Record<string, string>) => {
    const started = await post(CONNECT_PATH);
    assert.equal(started.status, 200);
    const authorize = new URL(
      (JSON.parse(started.body) as { authorizeUrl: string }).authorizeUrl,
    );
    const state = authorize.searchParams.get("state")!;
    states.push(state);
    const pendingValue = cookieValue(started, "__Host-pgw_github")!;
    cookieValues.push(pendingValue);
    const back = await request(
      `/auth/github/callback?${new URLSearchParams(query(state))}`,
      { headers: { cookie: `${session}; __Host-pgw_github=${pendingValue}` } },
    );
    assert.equal(back.status, 303);
    return back.headers.location;
  };
  /** Start, then come back from GitHub with the code. */
  const connect = () =>
    callback((state) => ({ code: FAKE_GITHUB_CODE, state }));
  const check = async (repo: string) => {
    const answer = await post(CHECK_PATH, { owner: OWNER, repo });
    return {
      status: answer.status,
      body: JSON.parse(answer.body) as Record<string, unknown>,
    };
  };
  const clear = async () =>
    (await post("/api/integrations/github/clear")).status;

  const fixture = {
    fake,
    edgeLines,
    vaultLines,
    answers,
    states,
    cookieValues,
    edgeStateDir,
    vaultStateDir,
    status,
    callback,
    connect,
    check,
    clear,
  };
  current = fixture;
  return fixture;
}

/**
 * AC7 (V4.13) over one case's own collections, before its fixture closes.
 */
function assertRedacted(f: Fixture): void {
  const { fake } = f;
  const tokens = [...fake.issuedAccess, ...fake.issuedRefresh, ...fake.minted];
  const secrets = [
    FAKE_GITHUB_CODE,
    FAKE_GITHUB_CLIENT.clientSecret,
    ...tokens,
  ];
  // Edge and vault log lines.
  for (const line of [...f.edgeLines, ...f.vaultLines])
    for (const value of [
      ...secrets,
      ...f.states,
      ...f.cookieValues,
      "state=",
      "code=",
      "BEGIN",
      "PRIVATE",
      "eyJ",
      "pandeck-gateway-s1",
    ])
      assert.ok(!line.includes(value), `a log line leaked: ${line}`);
  // Edge answers: bodies and headers (Location included).
  for (const answer of f.answers) {
    const { "set-cookie": cookies, ...rest } = answer.headers;
    const head = JSON.stringify(rest);
    const all = `${answer.body}\n${head}\n${JSON.stringify(cookies ?? [])}`;
    for (const value of [...secrets, "BEGIN", "PRIVATE", "eyJ"])
      assert.ok(!all.includes(value), `an answer leaked: ${answer.path}`);
    for (const value of f.cookieValues)
      assert.ok(
        !answer.body.includes(value) && !head.includes(value),
        `a cookie value leaked: ${answer.path}`,
      );
    // The OIDC sign-in's own redirect to its provider carries its state.
    if (answer.path !== "/auth/login")
      assert.ok(!head.includes("state="), `a header: ${answer.path}`);
    const start = answer.path === CONNECT_PATH && answer.status === 200;
    for (const value of f.states)
      assert.ok(!head.includes(value), `a header leaked: ${answer.path}`);
    for (const value of [...f.states, "state="]) {
      if (!start)
        assert.ok(!answer.body.includes(value), `a body: ${answer.path}`);
    }
    if (start)
      assert.deepEqual(Object.keys(JSON.parse(answer.body) as object), [
        "authorizeUrl",
      ]);
    const checked = answer.path === CHECK_PATH && answer.status === 200;
    assert.ok(!head.includes("pandeck-gateway-s1"), answer.path);
    if (checked) {
      const body = JSON.parse(answer.body) as Record<string, unknown>;
      assert.deepEqual(Object.keys(body).sort(), ["expiresAt", "repository"]);
    } else
      assert.ok(
        !answer.body.includes("pandeck-gateway-s1"),
        `a refusal named the repository: ${answer.path}`,
      );
  }
  // The edge's state dir: registry and request log, no token or state. No
  // PEM check: it holds the edge's TLS keys by contract.
  for (const file of filesUnder(f.edgeStateDir)) {
    for (const value of [...secrets, ...f.states])
      assert.ok(
        !file.text.includes(value),
        `the edge state leaked: ${file.path}`,
      );
    assert.ok(!/gh[sour]_|github_pat_/.test(file.text), file.path);
  }
  // The vault's state dir: installation and access tokens are memory-only.
  for (const file of filesUnder(f.vaultStateDir))
    for (const value of [...fake.minted, ...fake.issuedAccess])
      assert.ok(
        !file.text.includes(value),
        `the vault state leaked: ${file.path}`,
      );
}

/** The fake's refresh requests' refresh tokens, in order. */
const refreshesSeen = (fake: GithubFake) =>
  fake
    .on("token")
    .filter((seen) => seen.form.grant_type === "refresh_token")
    .map((seen) => seen.form.refresh_token);

/** A refresh posted straight to the fake, as a replay would arrive. */
function postToFake(fake: GithubFake, form: Record<string, string>) {
  return new Promise<Record<string, unknown>>((resolve, reject) => {
    const body = new URLSearchParams(form).toString();
    const req = https.request(
      {
        host: fake.endpoint.connect.host,
        port: fake.endpoint.connect.port,
        servername: "github.com",
        ca: fake.endpoint.ca,
        method: "POST",
        path: "/login/oauth/access_token",
        headers: {
          host: "github.com",
          accept: "application/json",
          "content-type": "application/x-www-form-urlencoded",
          "content-length": String(Buffer.byteLength(body)),
        },
      },
      (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => (text += chunk));
        res.on("end", () =>
          resolve(JSON.parse(text) as Record<string, unknown>),
        );
      },
    );
    req.on("error", reject);
    req.end(body);
  });
}

test("1. connect: the vault exchanges the code with the App's client and the edge's callback, then reads the user", async () => {
  const f = await setUp();
  assert.equal(await f.connect(), "/");
  const tokenRequests = f.fake.on("token");
  assert.equal(tokenRequests.length, 1);
  const form = tokenRequests[0]!.form;
  assert.equal(form.code, FAKE_GITHUB_CODE);
  assert.equal(form.client_id, FAKE_GITHUB_CLIENT.clientId);
  assert.equal(form.client_secret, FAKE_GITHUB_CLIENT.clientSecret);
  assert.equal(form.redirect_uri, CALLBACK);
  assert.deepEqual(
    f.fake.seen.map((seen) => seen.route),
    ["token", "user"],
  );
  assert.deepEqual(await f.status(), {
    offered: true,
    connected: true,
    login: "fake-user",
  });
  assert.ok(
    f.edgeLines.some((line) =>
      line.includes("ui github connect: started user="),
    ),
  );
  assert.ok(
    f.edgeLines.some((line) => line.includes("ui github connect: ok user=")),
  );
});

test("2. refresh rotation: two status reads inside the refresh margin each rotate the refresh token", async () => {
  const f = await setUp({ expiresInS: 300 });
  assert.equal(await f.connect(), "/");
  for (let i = 0; i < 2; i++)
    assert.deepEqual(await f.status(), {
      offered: true,
      connected: true,
      login: "fake-user",
    });
  assert.deepEqual(refreshesSeen(f.fake), [
    f.fake.issuedRefresh[0],
    f.fake.issuedRefresh[1],
  ]);
  // The rotated-out refresh token no longer works at the fake.
  const replay = await postToFake(f.fake, {
    grant_type: "refresh_token",
    refresh_token: f.fake.issuedRefresh[0]!,
    client_id: FAKE_GITHUB_CLIENT.clientId,
    client_secret: FAKE_GITHUB_CLIENT.clientSecret,
  });
  assert.equal(replay.error, "bad_refresh_token");
});

test("3. revoked grant: a refused refresh shows rejected and the check is 422; a fresh connect recovers", async () => {
  const f = await setUp({ expiresInS: 300 });
  assert.equal(await f.connect(), "/");
  f.fake.script.token = githubJson(200, {
    error: "bad_refresh_token",
    error_description: "The refresh token passed is incorrect.",
  });
  assert.deepEqual(await f.status(), {
    offered: true,
    connected: false,
    problem: "rejected",
  });
  assert.deepEqual(await f.check(S1), {
    status: 422,
    body: { error: "integration_rejected" },
  });
  assert.equal(f.fake.minted.length, 0);
  delete f.fake.script.token;
  assert.equal(await f.connect(), "/");
  assert.deepEqual(await f.status(), {
    offered: true,
    connected: true,
    login: "fake-user",
  });
});

test("4. a user check that answers 401 for every token: one refresh, then the second 401 is vault_unavailable (Task-1508 O1)", async () => {
  const f = await setUp();
  assert.equal(await f.connect(), "/");
  f.fake.script.repo = githubJson(401, { message: "Bad credentials" });
  assert.deepEqual(await f.check(S1), {
    status: 503,
    body: { error: "vault_unavailable" },
  });
  assert.equal(
    f.fake
      .on("token")
      .filter((seen) => seen.form.grant_type === "refresh_token").length,
    1,
  );
  assert.equal(f.fake.on("repo").length, 2);
  assert.equal(f.fake.minted.length, 0);
});

test("5. first mint: a narrowed read token is proven and dropped; the second check reuses the vault's caches", async () => {
  const f = await setUp();
  assert.equal(await f.connect(), "/");
  const expiresAt = Math.floor((Date.now() + 3_600_000) / 1000) * 1000;
  f.fake.script.mint = f.fake.mintWith({ expires_at: githubTime(expiresAt) });
  const first = await f.check(S1);
  assert.deepEqual(first, {
    status: 200,
    body: { repository: `${OWNER}/${S1}`, expiresAt },
  });
  const [repo] = f.fake.on("repo");
  assert.equal(repo!.bearer, f.fake.issuedAccess[0]);
  const [installation] = f.fake.on("installation");
  assert.match(installation!.bearer ?? "", /^eyJ/);
  const mints = f.fake.on("mint");
  assert.equal(mints.length, 1);
  assert.deepEqual(JSON.parse(mints[0]!.body), {
    repository_ids: [S1_ID],
    permissions: { contents: "read", metadata: "read" },
  });
  assert.equal(f.fake.minted.length, 1);
  assert.ok(
    f.edgeLines.some((line) =>
      line.includes("ui integration github: check ok user="),
    ),
  );

  const second = await f.check(S1);
  assert.equal(second.status, 200);
  assert.equal(f.fake.on("repo").length, 2);
  assert.equal(f.fake.on("installation").length, 1);
  assert.equal(f.fake.on("mint").length, 1);
});

test("6. an uninstalled repository and one the user cannot pull are denied without a mint", async () => {
  const f = await setUp();
  assert.equal(await f.connect(), "/");
  assert.deepEqual(await f.check(S1_NOAPP), {
    status: 403,
    body: { error: "integration_denied" },
  });
  assert.equal(f.fake.on("installation").length, 1);
  assert.equal(f.fake.on("mint").length, 0);
  assert.deepEqual(await f.check(S1_PRIVATE), {
    status: 403,
    body: { error: "integration_denied" },
  });
  assert.equal(f.fake.on("installation").length, 1);
  assert.equal(f.fake.on("mint").length, 0);
  assert.ok(
    f.edgeLines.some((line) =>
      line.includes(
        "ui integration github: check refused (integration_denied) user=",
      ),
    ),
  );
});

test("7. bad proof: a mint granting more is revoked and answered unavailable; nothing is cached", async () => {
  const f = await setUp();
  assert.equal(await f.connect(), "/");
  f.fake.script.mint = f.fake.mintWith({
    permissions: { contents: "read", metadata: "read", issues: "read" },
  });
  assert.deepEqual(await f.check(S1), {
    status: 503,
    body: { error: "vault_unavailable" },
  });
  assert.deepEqual(
    f.fake.on("revoke").map((seen) => seen.bearer),
    [f.fake.minted[0]],
  );
  delete f.fake.script.mint;
  assert.equal((await f.check(S1)).status, 200);
  assert.equal(f.fake.minted.length, 2);
});

test("8. disconnect mid-mint: the clear is not busy, the fenced token is dropped uncached, and a reconnect mints afresh", async () => {
  const f = await setUp();
  assert.equal(await f.connect(), "/");
  const held = f.fake.hold("mint");
  const checking = f.check(S1);
  await held.arrived;
  assert.equal(await f.clear(), 204);
  held.release();
  assert.deepEqual(await checking, {
    status: 503,
    body: { error: "vault_unavailable" },
  });
  assert.deepEqual(await f.check(S1), {
    status: 409,
    body: { error: "integration_sign_in_required" },
  });
  assert.equal(await f.connect(), "/");
  assert.equal((await f.check(S1)).status, 200);
  assert.equal(f.fake.minted.length, 2);
  assert.ok(
    f.edgeLines.some((line) =>
      line.includes("ui integration github: cleared user="),
    ),
  );
});

test("9. identity switch mid-mint: the reconnect is not busy, the held token is dropped, and the other user is denied", async () => {
  const f = await setUp();
  assert.equal(await f.connect(), "/");
  const held = f.fake.hold("mint");
  const checking = f.check(S1);
  await held.arrived;
  f.fake.identity = FAKE_GITHUB_OTHER;
  assert.equal(await f.connect(), "/");
  assert.deepEqual(await f.status(), {
    offered: true,
    connected: true,
    login: FAKE_GITHUB_OTHER.login,
  });
  held.release();
  assert.deepEqual(await checking, {
    status: 503,
    body: { error: "vault_unavailable" },
  });
  assert.deepEqual(await f.check(S1), {
    status: 403,
    body: { error: "integration_denied" },
  });
  assert.equal(f.fake.minted.length, 1);
});

test("10. denied at GitHub: the callback answers denied and the vault exchanges nothing", async () => {
  const f = await setUp();
  assert.equal(
    await f.callback((state) => ({
      error: "access_denied",
      error_description: "The user has denied your application access.",
      state,
    })),
    "/?github=denied",
  );
  assert.deepEqual(f.fake.on("token"), []);
});

test("11. an exchange GitHub refuses ends rejected and stores nothing", async () => {
  const f = await setUp();
  f.fake.script.token = githubJson(200, {
    error: "bad_verification_code",
    error_description: "The code passed is incorrect or expired.",
  });
  assert.equal(await f.connect(), "/?github=rejected");
  assert.deepEqual(await f.status(), { offered: true, connected: false });
});

test("12. a vault without the App's client: connect is not_configured and the check unavailable", async () => {
  const f = await setUp({ githubApp: false });
  assert.equal(await f.connect(), "/?github=not_configured");
  assert.deepEqual(f.fake.seen, []);
  assert.deepEqual(await f.check(S1), {
    status: 503,
    body: { error: "vault_unavailable" },
  });
});
