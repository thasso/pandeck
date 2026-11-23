/**
 * The vault's GitHub App client (Task-1444, Task-1440 plan v06 PR1) against
 * a loopback GitHub fake carrying spike S1a's answer shapes: the OAuth code
 * exchange, refresh with rotation and `GET /user` (AC2, AC3, AC6), and
 * `github.token` through `createVaultIntegrations` with an injected clock
 * and budget (AC5, AC5b; the wire, lock and stop cases are in
 * `vaultIntegrations.test.ts`). Every value is fake.
 */
import assert from "node:assert/strict";
import { verify } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterAll, afterEach, beforeAll, test } from "vitest";
import {
  FAKE_GITHUB_CLIENT,
  FAKE_GITHUB_CODE,
  FAKE_GITHUB_OTHER,
  FAKE_GITHUB_REDIRECT,
  FAKE_GITHUB_USER,
  FAKE_INSTALLATION_ID,
  fakeGithubApp,
  githubJson,
  githubTime,
  githubTokenAnswer,
  startGithubFake,
  type FakeGithubUser,
  type GithubFake,
} from "../test/githubFake.ts";
import {
  exchangeGithubCode,
  githubUser,
  refreshGithub,
} from "./vaultGithub.ts";
import {
  createVaultIntegrations,
  type VaultIntegrationOptions,
} from "./vaultIntegrations.ts";
import { INTEGRATION_FILE, integrationDirId } from "./vaultMethods.ts";

let github: GithubFake;
const dirs: string[] = [];
beforeAll(async () => {
  github = await startGithubFake();
});
afterEach(() => {
  github.reset();
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});
afterAll(() => github.close());

const grant = { code: FAKE_GITHUB_CODE, redirectUri: FAKE_GITHUB_REDIRECT };

/** What S1a's `a4a`/`a9-old-refresh` answered: HTTP 200 with an error. */
const errorAt = (status: number) =>
  githubJson(status, {
    error: "bad_verification_code",
    error_description: "fake description",
    error_uri: "https://docs.github.com/fake",
  });

test("the code exchange posts the form to github.com with the fixed TLS name, Host and headers", async () => {
  const result = await exchangeGithubCode(
    FAKE_GITHUB_CLIENT,
    grant,
    github.endpoint,
  );
  assert.equal(result.kind, "ok");
  const [seen] = github.on("token");
  assert.ok(seen);
  assert.equal(seen.method, "POST");
  assert.equal(seen.path, "/login/oauth/access_token");
  assert.equal(seen.servername, "github.com");
  assert.equal(seen.host, "github.com");
  assert.equal(seen.headers.accept, "application/json");
  assert.equal(seen.headers["user-agent"], "pandeck-gateway-vault");
  assert.deepEqual(seen.form, {
    client_id: FAKE_GITHUB_CLIENT.clientId,
    client_secret: FAKE_GITHUB_CLIENT.clientSecret,
    code: FAKE_GITHUB_CODE,
    redirect_uri: FAKE_GITHUB_REDIRECT,
  });
  assert.deepEqual(result.kind === "ok" && result.tokens, {
    accessToken: github.issuedAccess.at(-1),
    refreshToken: github.issuedRefresh.at(-1),
    expiresInS: 28_800,
    refreshExpiresInS: 15_638_400,
  });
});

test("an error member is rejected at any status; missing tokens or lifetimes are rejected; a 3xx is not followed", async () => {
  for (const status of [200, 400, 404, 503]) {
    github.script.token = errorAt(status);
    assert.deepEqual(
      await exchangeGithubCode(FAKE_GITHUB_CLIENT, grant, github.endpoint),
      { kind: "rejected" },
      String(status),
    );
  }
  const full = githubTokenAnswer("x");
  for (const missing of [
    "access_token",
    "refresh_token",
    "expires_in",
    "refresh_token_expires_in",
  ]) {
    github.script.token = githubJson(200, { ...full, [missing]: undefined });
    assert.deepEqual(
      await exchangeGithubCode(FAKE_GITHUB_CLIENT, grant, github.endpoint),
      { kind: "rejected" },
      missing,
    );
  }
  github.script.token = githubJson(200, { ...full, expires_in: 0 });
  assert.deepEqual(
    await exchangeGithubCode(FAKE_GITHUB_CLIENT, grant, github.endpoint),
    { kind: "rejected" },
  );
  github.script.token = githubJson(401);
  assert.deepEqual(
    await exchangeGithubCode(FAKE_GITHUB_CLIENT, grant, github.endpoint),
    { kind: "rejected" },
  );
  github.script.token = githubJson(502, "not json");
  assert.deepEqual(
    await exchangeGithubCode(FAKE_GITHUB_CLIENT, grant, github.endpoint),
    { kind: "unreachable", code: "502" },
  );
  github.script.token = githubJson(200, "not json");
  assert.deepEqual(
    await exchangeGithubCode(FAKE_GITHUB_CLIENT, grant, github.endpoint),
    { kind: "unreachable", code: "bad_response" },
  );
  github.script.token = (_seen, res) => {
    res.raw.writeHead(302, { location: "https://github.com/elsewhere" });
    res.raw.end();
  };
  const seen = github.seen.length;
  assert.deepEqual(
    await exchangeGithubCode(FAKE_GITHUB_CLIENT, grant, github.endpoint),
    { kind: "unreachable", code: "redirect" },
  );
  assert.equal(github.seen.length, seen + 1, "the redirect was not followed");
});

test("a refresh rotates: the new pair, the old refresh token then refused; no new refresh token is unusable", async () => {
  const first = await exchangeGithubCode(
    FAKE_GITHUB_CLIENT,
    grant,
    github.endpoint,
  );
  assert.equal(first.kind, "ok");
  const stored = first.kind === "ok" ? first.tokens.refreshToken : "";
  const refreshed = await refreshGithub(
    FAKE_GITHUB_CLIENT,
    stored,
    github.endpoint,
  );
  assert.equal(refreshed.kind, "ok");
  assert.notEqual(
    refreshed.kind === "ok" && refreshed.tokens.refreshToken,
    stored,
  );
  const [, sent] = github.on("token");
  assert.deepEqual(sent?.form, {
    client_id: FAKE_GITHUB_CLIENT.clientId,
    client_secret: FAKE_GITHUB_CLIENT.clientSecret,
    grant_type: "refresh_token",
    refresh_token: stored,
  });
  // S1a a9-old-refresh: a spent refresh token answers 200 bad_refresh_token.
  assert.deepEqual(
    await refreshGithub(FAKE_GITHUB_CLIENT, stored, github.endpoint),
    { kind: "rejected" },
  );
  github.script.token = githubJson(
    200,
    githubTokenAnswer("y", { refresh_token: stored }),
  );
  assert.deepEqual(
    await refreshGithub(FAKE_GITHUB_CLIENT, stored, github.endpoint),
    { kind: "unusable" },
  );
  github.script.token = githubJson(
    200,
    githubTokenAnswer("y", {
      refresh_token: undefined,
      refresh_token_expires_in: undefined,
    }),
  );
  assert.deepEqual(
    await refreshGithub(FAKE_GITHUB_CLIENT, stored, github.endpoint),
    { kind: "unusable" },
  );
  for (const status of [400, 401, 403]) {
    github.script.token = githubJson(status, {});
    assert.deepEqual(
      await refreshGithub(FAKE_GITHUB_CLIENT, stored, github.endpoint),
      { kind: "rejected" },
    );
  }
  github.script.token = githubJson(500, {});
  assert.deepEqual(
    await refreshGithub(FAKE_GITHUB_CLIENT, stored, github.endpoint),
    { kind: "unreachable", code: "500" },
  );
});

test("GET /user goes to api.github.com with the token and REST headers; its login and id are checked", async () => {
  const exchanged = await exchangeGithubCode(
    FAKE_GITHUB_CLIENT,
    grant,
    github.endpoint,
  );
  const access = exchanged.kind === "ok" ? exchanged.tokens.accessToken : "";
  assert.deepEqual(await githubUser(access, github.endpoint), {
    kind: "ok",
    login: FAKE_GITHUB_USER.login,
    githubUserId: FAKE_GITHUB_USER.id,
  });
  const [seen] = github.on("user");
  assert.equal(seen?.servername, "api.github.com");
  assert.equal(seen?.host, "api.github.com");
  assert.equal(seen?.bearer, access);
  assert.equal(seen?.headers.accept, "application/vnd.github+json");
  assert.equal(seen?.headers["x-github-api-version"], "2022-11-28");
  assert.equal(seen?.headers["user-agent"], "pandeck-gateway-vault");
  assert.deepEqual(await githubUser("fake-unknown", github.endpoint), {
    kind: "rejected",
  });
  for (const body of [
    { login: "has space", id: 1 },
    { login: "fake-user", id: 0 },
    { login: "fake-user", id: "1" },
    { login: "x".repeat(40), id: 1 },
  ]) {
    github.script.user = githubJson(200, body);
    assert.deepEqual(await githubUser(access, github.endpoint), {
      kind: "unusable",
    });
  }
  github.script.user = githubJson(503, {});
  assert.deepEqual(await githubUser(access, github.endpoint), {
    kind: "unreachable",
    code: "503",
  });
});

// --- github.token (AC5, AC5b) ----------------------------------------------

const RID = 9001;
const OTHER_RID = 9002;
const REPO = { owner: "fake-owner", repo: "fake-repo" };
const READ = { contents: "read", metadata: "read" };
const UNAVAILABLE = { ok: false, unavailable: true };
const DENIED = { ok: false, denied: true };
const INVALID = { ok: false, invalid: true };

/** No token, secret, code, key, JWT or user id in any line. */
const noSecretsIn = (lines: string[]): void => {
  for (const line of lines)
    assert.doesNotMatch(
      line,
      /fake-gh-|fake-github-|fake-user|fake-other|(?<![A-Za-z0-9])u[12](?![A-Za-z0-9])|BEGIN|PRIVATE|eyJ/,
      line,
    );
};

/** A vault's integrations with the fake App, and `u1` connected as `as`. */
async function tokenVault(
  options: {
    as?: FakeGithubUser;
    now?: () => number;
    extra?: Partial<VaultIntegrationOptions>;
  } = {},
) {
  const dir = mkdtempSync(join(tmpdir(), "vault-github-token-"));
  dirs.push(dir);
  const app = fakeGithubApp();
  const lines: string[] = [];
  const written: string[] = [];
  const v = createVaultIntegrations(
    {
      stateDir: dir,
      clients: { github: app.client },
      githubEndpoint: github.endpoint,
      written: (file) => written.push(file),
      ...options.extra,
    },
    (line) => lines.push(line),
    options.now,
  );
  github.addRepository("fake-owner/fake-repo", RID, [FAKE_GITHUB_USER.login]);
  await connect(v, "u1", options.as ?? FAKE_GITHUB_USER);
  return { v, dir, app, lines, written };
}

async function connect(
  v: ReturnType<typeof createVaultIntegrations>,
  userId: string,
  as: FakeGithubUser,
): Promise<void> {
  github.identity = as;
  assert.deepEqual(await v.integrationConnect(userId, "github", grant), {
    ok: true,
    login: as.login,
  });
}

const count = (route: Parameters<GithubFake["on"]>[0]) =>
  github.on(route).length;

test("github.token: a fresh user check, the App's JWT, the installation and a read mint of exactly one repository", async () => {
  const { v, app, lines } = await tokenVault();
  const before = Date.now();
  const answer = await v.githubToken("u1", REPO);
  assert.deepEqual(answer, {
    ok: true,
    token: github.minted.at(-1),
    expiresAt: (answer as { expiresAt: number }).expiresAt,
  });
  assert.ok((answer as { expiresAt: number }).expiresAt > Date.now());

  const [check] = github.on("repo");
  assert.equal(check?.path, "/repos/fake-owner/fake-repo");
  assert.equal(check?.bearer, github.issuedAccess.at(-1), "the user's token");
  assert.equal(check?.headers["x-github-api-version"], "2022-11-28");

  const [lookup] = github.on("installation");
  assert.equal(lookup?.path, "/repos/fake-owner/fake-repo/installation");
  const jwt = lookup?.bearer ?? "";
  const [header, payload, signature] = jwt.split(".");
  assert.ok(header && payload && signature);
  assert.ok(
    verify(
      "sha256",
      Buffer.from(`${header}.${payload}`),
      app.publicKey,
      Buffer.from(signature, "base64url"),
    ),
    "the JWT verifies with the App's public key",
  );
  assert.deepEqual(JSON.parse(Buffer.from(header, "base64url").toString()), {
    alg: "RS256",
    typ: "JWT",
  });
  const claims = JSON.parse(Buffer.from(payload, "base64url").toString()) as {
    iat: number;
    exp: number;
    iss: string;
  };
  assert.deepEqual(Object.keys(claims).sort(), ["exp", "iat", "iss"]);
  assert.equal(claims.iss, FAKE_GITHUB_CLIENT.clientId);
  assert.equal(claims.exp - claims.iat, 600, "iat a minute back, exp 9 ahead");
  assert.ok(Math.abs(claims.iat - (Math.floor(before / 1000) - 60)) <= 2);

  const [mint] = github.on("mint");
  assert.equal(mint?.method, "POST");
  assert.equal(
    mint?.path,
    `/app/installations/${FAKE_INSTALLATION_ID}/access_tokens`,
  );
  assert.equal(mint?.bearer, jwt, "the JWT is reused");
  assert.equal(
    mint?.body,
    JSON.stringify({ repository_ids: [RID], permissions: READ }),
    "the mint body is exactly one repository id and read permissions",
  );
  assert.equal(count("revoke"), 0);
  assert.equal(count("installationRepos"), 0, "repositories proved it");
  // Only GETs, the mint and the OAuth POSTs: no GitHub write.
  for (const seen of github.seen)
    assert.ok(
      seen.method === "GET" ||
        (seen.method === "POST" && ["token", "mint"].includes(seen.route)),
      `${seen.method} ${seen.path}`,
    );
  noSecretsIn(lines);
});

test("github.token: invalid names, `access` or any other member are invalid before any request", async () => {
  const { v, lines } = await tokenVault();
  const seen = github.seen.length;
  const requests: unknown[] = [
    { owner: "has space", repo: "fake-repo" },
    { owner: "x".repeat(40), repo: "fake-repo" },
    { owner: "", repo: "fake-repo" },
    { owner: "fake-owner", repo: "." },
    { owner: "fake-owner", repo: ".." },
    { owner: "fake-owner", repo: "a/b" },
    { owner: "fake-owner", repo: "x".repeat(101) },
    { owner: "fake-owner" },
    { ...REPO, access: "write" },
    { ...REPO, access: "read" },
    { ...REPO, permissions: READ },
    { ...REPO, repository_ids: [RID] },
    null,
    "fake-owner/fake-repo",
    [REPO.owner, REPO.repo],
  ];
  for (const request of requests)
    assert.deepEqual(
      await v.githubToken("u1", request as typeof REPO),
      INVALID,
      JSON.stringify(request),
    );
  assert.equal(github.seen.length, seen, "no outbound request");
  noSecretsIn(lines);
});

test("github.token: a repository the user cannot see, a redirect, another name, no pull, or no installation is denied without a mint", async () => {
  const { v, lines } = await tokenVault();
  const cases: [string, () => void][] = [
    ["unknown", () => {}],
    [
      "redirect",
      () => {
        github.script.repo = (_seen, res) => {
          res.raw.writeHead(301, { location: "https://api.github.com/x" });
          res.raw.end();
        };
      },
    ],
    ["403", () => (github.script.repo = githubJson(403, {}))],
    [
      "full_name",
      () =>
        (github.script.repo = githubJson(200, {
          id: RID,
          full_name: "fake-owner/fake-repo-2",
          permissions: { pull: true },
        })),
    ],
    [
      "id",
      () =>
        (github.script.repo = githubJson(200, {
          id: "9001",
          full_name: "fake-owner/fake-repo",
          permissions: { pull: true },
        })),
    ],
    [
      "pull false",
      () =>
        github.addRepository("fake-owner/fake-repo", RID, [
          FAKE_GITHUB_OTHER.login,
        ]),
    ],
    [
      "pull missing",
      () =>
        (github.script.repo = githubJson(200, {
          id: RID,
          full_name: "fake-owner/fake-repo",
        })),
    ],
    [
      "no installation",
      () =>
        github.repositories.set("fake-owner/fake-repo", {
          id: RID,
          fullName: "fake-owner/fake-repo",
          pullers: new Set([FAKE_GITHUB_USER.login]),
          noApp: true,
        }),
    ],
  ];
  for (const [name, arrange] of cases) {
    github.repositories.clear();
    for (const route of ["repo"] as const) delete github.script[route];
    if (name !== "unknown")
      github.addRepository("fake-owner/fake-repo", RID, [
        FAKE_GITHUB_USER.login,
      ]);
    arrange();
    assert.deepEqual(await v.githubToken("u1", REPO), DENIED, name);
  }
  assert.equal(count("mint"), 0, "no mint");
  // A full_name in another case is the same repository.
  delete github.script.repo;
  github.repositories.clear();
  github.addRepository("Fake-Owner/Fake-Repo", RID, [FAKE_GITHUB_USER.login]);
  assert.equal((await v.githubToken("u1", REPO)).ok, true);
  // A failing check is unavailable, not denied.
  github.script.repo = githubJson(500, {});
  assert.deepEqual(await v.githubToken("u1", REPO), UNAVAILABLE);
  noSecretsIn(lines);
});

test("github.token: each mint answer that fails its proof yields nothing, caches nothing, and is revoked", async () => {
  const { v, lines } = await tokenVault();
  const past = githubTime(Date.now() - 60_000);
  const fixtures: [string, Record<string, unknown>, (() => void)?][] = [
    ["permissions missing", { permissions: undefined }],
    ["permissions null", { permissions: null }],
    ["permissions empty", { permissions: {} }],
    ["permissions string", { permissions: "read" }],
    ["permissions array", { permissions: ["contents", "metadata"] }],
    ["contents only", { permissions: { contents: "read" } }],
    [
      "contents write",
      { permissions: { contents: "write", metadata: "read" } },
    ],
    ["workflows write", { permissions: { ...READ, workflows: "write" } }],
    ["issues read", { permissions: { ...READ, issues: "read" } }],
    ["two repositories", { repositories: [{ id: RID }, { id: OTHER_RID }] }],
    ["another repository", { repositories: [{ id: OTHER_RID }] }],
    ["no repositories", { repositories: [] }],
    [
      "follow-up another id",
      { repositories: undefined },
      () =>
        (github.script.installationRepos = githubJson(200, {
          total_count: 1,
          repositories: [{ id: OTHER_RID }],
        })),
    ],
    [
      "follow-up two entries",
      { repositories: undefined },
      () =>
        (github.script.installationRepos = githubJson(200, {
          total_count: 2,
          repositories: [{ id: RID }, { id: OTHER_RID }],
        })),
    ],
    [
      "follow-up fails",
      { repositories: undefined },
      () => (github.script.installationRepos = githubJson(500, {})),
    ],
    ["expires_at past", { expires_at: past }],
    ["expires_at malformed", { expires_at: "next hour" }],
    ["expires_at no zone", { expires_at: "2099-01-01T10:00:00" }],
    ["expires_at offset", { expires_at: "2099-01-01T10:00:00+01:00" }],
    ["expires_at no day", { expires_at: "2099-02-30T10:00:00Z" }],
    ["expires_at number", { expires_at: 4_102_444_800 }],
    ["expires_at missing", { expires_at: undefined }],
  ];
  for (const [name, overrides, arrange] of fixtures) {
    delete github.script.installationRepos;
    arrange?.();
    github.script.mint = github.mintWith(overrides);
    const mints = count("mint");
    const revokes = count("revoke");
    assert.deepEqual(await v.githubToken("u1", REPO), UNAVAILABLE, name);
    assert.equal(count("mint"), mints + 1, `${name}: minted, nothing cached`);
    assert.equal(count("revoke"), revokes + 1, `${name}: revoked`);
    assert.equal(
      github.on("revoke").at(-1)?.bearer,
      github.minted.at(-1),
      `${name}: the minted token is the one revoked`,
    );
  }
  noSecretsIn(lines);
});

test("github.token: an answer without a usable token is refused, caches nothing, and sends no revoke (F13)", async () => {
  const { v, lines } = await tokenVault();
  for (const [name, token] of [
    ["missing", undefined],
    ["number", 12_345],
    ["object", { value: "x" }],
    ["empty", ""],
    ["space", "fake has space"],
    ["newline", "fake\nline"],
    ["oversize", "x".repeat(8_193)],
  ] as const) {
    github.script.mint = github.mintWith({ token });
    const mints = count("mint");
    assert.deepEqual(await v.githubToken("u1", REPO), UNAVAILABLE, name);
    assert.equal(count("mint"), mints + 1, `${name}: nothing cached`);
    assert.equal(count("revoke"), 0, `${name}: no revoke`);
  }
  // A refused mint (S1a: 422) has no token to revoke either.
  github.script.mint = githubJson(422, { message: "fake refusal" });
  assert.deepEqual(await v.githubToken("u1", REPO), UNAVAILABLE);
  assert.equal(count("revoke"), 0);
  noSecretsIn(lines);
});

test("github.token: without repositories the token's own listing proves exactly the one id", async () => {
  const { v } = await tokenVault();
  github.script.mint = github.mintWith({ repositories: undefined });
  const answer = await v.githubToken("u1", REPO);
  assert.equal(answer.ok, true, JSON.stringify(answer));
  const [listing] = github.on("installationRepos");
  assert.equal(listing?.bearer, github.minted.at(-1));
  assert.equal(listing?.servername, "api.github.com");
  assert.equal(count("revoke"), 0);
});

test("github.token: expires_at parses with Z, fractional seconds or +00:00 against the vault's clock", async () => {
  const clock = Date.parse("2026-11-23T09:00:00Z");
  for (const form of [
    "2026-11-23T10:00:00Z",
    "2026-11-23T10:00:00.000Z",
    "2026-11-23T10:00:00+00:00",
  ]) {
    const { v } = await tokenVault({ now: () => clock });
    github.script.mint = github.mintWith({ expires_at: form });
    assert.deepEqual(
      await v.githubToken("u1", REPO),
      {
        ok: true,
        token: github.minted.at(-1),
        expiresAt: Date.parse("2026-11-23T10:00:00Z"),
      },
      form,
    );
  }
});

test("github.token: within the cache window a call checks the user again but mints nothing; near expiry it mints anew", async () => {
  let clock = Date.parse("2026-11-23T09:00:00Z");
  const { v } = await tokenVault({ now: () => clock });
  github.script.mint = github.mintWith({ expires_at: "2026-11-23T10:00:00Z" });
  const first = await v.githubToken("u1", REPO);
  assert.equal(first.ok, true);
  clock += 45 * 60_000;
  assert.deepEqual(await v.githubToken("u1", REPO), first);
  assert.equal(count("repo"), 2, "a fresh user check every call");
  assert.equal(count("mint"), 1);
  assert.equal(count("installation"), 1, "the installation is cached");
  clock += 6 * 60_000;
  github.script.mint = github.mintWith({ expires_at: "2026-11-23T11:00:00Z" });
  const third = await v.githubToken("u1", REPO);
  assert.equal(third.ok, true);
  assert.notDeepEqual(third, first, "under 10 minutes left: a new mint");
  assert.equal(count("mint"), 2);
  assert.equal(count("installation"), 1);
  // Past an hour the installation is looked up again, with a new JWT.
  clock += 61 * 60_000;
  github.script.mint = github.mintWith({ expires_at: "2026-11-23T13:00:00Z" });
  assert.equal((await v.githubToken("u1", REPO)).ok, true);
  assert.equal(count("installation"), 2);
  const [firstLookup, secondLookup] = github.on("installation");
  assert.notEqual(firstLookup?.bearer, secondLookup?.bearer, "a fresh JWT");
});

test("github.token: of two users on one repository only the one with pull gets the cached token", async () => {
  const { v } = await tokenVault();
  await connect(v, "u2", FAKE_GITHUB_OTHER);
  const first = await v.githubToken("u1", REPO);
  assert.equal(first.ok, true);
  assert.deepEqual(await v.githubToken("u2", REPO), DENIED);
  assert.equal(count("mint"), 1);
  assert.deepEqual(await v.githubToken("u1", REPO), first);
});

test("github.token: an absent or rejected record passes through; no App is unavailable", async () => {
  const { v } = await tokenVault();
  assert.deepEqual(await v.githubToken("u2", REPO), {
    ok: false,
    absent: true,
  });
  // GitHub refuses the refresh: the record's refresh token is spent.
  const restarted = createVaultIntegrations({
    stateDir: dirs.at(-1),
    clients: { github: fakeGithubApp().client },
    githubEndpoint: github.endpoint,
  });
  github.script.token = githubJson(200, { error: "bad_refresh_token" });
  assert.deepEqual(await restarted.githubToken("u1", REPO), {
    ok: false,
    rejected: true,
  });
  const noApp = createVaultIntegrations({
    stateDir: dirs.at(-1),
    githubEndpoint: github.endpoint,
  });
  const seen = github.seen.length;
  assert.deepEqual(await noApp.githubToken("u1", REPO), UNAVAILABLE);
  assert.equal(github.seen.length, seen);
});

// --- AC5b: the generation fence and the budget ------------------------------

for (const [step, route] of [
  ["user check", "repo"],
  ["mint", "mint"],
] as const)
  test(`github.token: a clear during a held ${step} answers unavailable and caches nothing`, async () => {
    const { v, lines } = await tokenVault();
    const held = github.hold(route);
    const asking = v.githubToken("u1", REPO);
    await held.arrived;
    assert.deepEqual(await v.integrationClear("u1", "github"), { ok: true });
    held.release();
    assert.deepEqual(await asking, UNAVAILABLE);
    await connect(v, "u1", FAKE_GITHUB_USER);
    const mints = count("mint");
    assert.equal((await v.githubToken("u1", REPO)).ok, true);
    assert.equal(count("mint"), mints + 1, "nothing was cached");
    noSecretsIn(lines);
  });

test("github.token: a reconnect as an identity without access during a held check voids the call; the next is denied unminted", async () => {
  const { v } = await tokenVault();
  const held = github.hold("repo");
  const asking = v.githubToken("u1", REPO);
  await held.arrived;
  await connect(v, "u1", FAKE_GITHUB_OTHER);
  held.release();
  assert.deepEqual(await asking, UNAVAILABLE);
  assert.deepEqual(await v.githubToken("u1", REPO), DENIED);
  assert.equal(count("mint"), 0);
});

// F001: the fence comes before any outcome, `denied` included.
for (const [change, route, negative] of [
  ["clear", "repo", () => (github.script.repo = githubJson(403, {}))],
  ["reconnect", "repo", () => (github.script.repo = githubJson(403, {}))],
  [
    "clear",
    "installation",
    () => (github.script.installation = githubJson(404, {})),
  ],
] as const)
  test(`github.token: a ${change} during a held negative ${route} answer voids it: unavailable, not denied, nothing minted or cached`, async () => {
    const { v, lines } = await tokenVault();
    negative();
    const held = github.hold(route);
    const asking = v.githubToken("u1", REPO);
    await held.arrived;
    if (change === "clear")
      assert.deepEqual(await v.integrationClear("u1", "github"), { ok: true });
    else await connect(v, "u1", FAKE_GITHUB_USER);
    held.release();
    assert.deepEqual(await asking, UNAVAILABLE);
    assert.equal(count("mint"), 0);
    delete github.script[route];
    if (change === "clear") await connect(v, "u1", FAKE_GITHUB_USER);
    const lookups = count("installation");
    assert.equal((await v.githubToken("u1", REPO)).ok, true);
    assert.equal(count("mint"), 1, "nothing was cached");
    assert.equal(count("installation"), lookups + 1, "nor the installation");
    noSecretsIn(lines);
  });

test("github.token: a clear while the proof's repository listing is held drops the proven token", async () => {
  const { v } = await tokenVault();
  github.script.mint = github.mintWith({ repositories: undefined });
  const held = github.hold("installationRepos");
  const asking = v.githubToken("u1", REPO);
  await held.arrived;
  assert.deepEqual(await v.integrationClear("u1", "github"), { ok: true });
  held.release();
  assert.deepEqual(await asking, UNAVAILABLE);
  assert.equal(count("revoke"), 0, "dropped, not revoked");
  await connect(v, "u1", FAKE_GITHUB_USER);
  assert.equal((await v.githubToken("u1", REPO)).ok, true);
  assert.equal(count("mint"), 2, "the dropped token was not cached");
});

test("github.token: a reconnect during a held mint drops the proven token", async () => {
  const { v } = await tokenVault();
  const held = github.hold("mint");
  const asking = v.githubToken("u1", REPO);
  await held.arrived;
  await connect(v, "u1", FAKE_GITHUB_USER);
  held.release();
  assert.deepEqual(await asking, UNAVAILABLE);
  assert.equal(count("revoke"), 0, "dropped, not revoked");
  assert.equal((await v.githubToken("u1", REPO)).ok, true);
  assert.equal(count("mint"), 2, "the dropped token was not cached");
});

// F004: after a mint the fence decides delivery and caching, never cleanup.
for (const [change, answer, overrides, revokes] of [
  [
    "clear",
    "an overbroad",
    { permissions: { contents: "write", metadata: "read" } },
    1,
  ],
  [
    "reconnect",
    "an overbroad",
    { permissions: { contents: "write", metadata: "read" } },
    1,
  ],
  ["clear", "a non-token", { token: "fake has space" }, 0],
  ["clear", "a fully valid", {}, 0],
] as const)
  test(`github.token: a ${change} during a held mint, released with ${answer} answer: unavailable, nothing cached, ${revokes} revoke`, async () => {
    const { v, lines } = await tokenVault();
    github.script.mint = github.mintWith(overrides);
    const held = github.hold("mint");
    const asking = v.githubToken("u1", REPO);
    await held.arrived;
    if (change === "clear")
      assert.deepEqual(await v.integrationClear("u1", "github"), { ok: true });
    else await connect(v, "u1", FAKE_GITHUB_USER);
    held.release();
    assert.deepEqual(await asking, UNAVAILABLE);
    assert.equal(count("revoke"), revokes);
    if (revokes > 0)
      assert.equal(github.on("revoke")[0]?.bearer, github.minted.at(-1));
    delete github.script.mint;
    if (change === "clear") await connect(v, "u1", FAKE_GITHUB_USER);
    assert.equal((await v.githubToken("u1", REPO)).ok, true);
    assert.equal(count("mint"), 2, "nothing was cached");
    assert.equal(count("revoke"), revokes);
    noSecretsIn(lines);
  });

// F005: expiry is checked again where delivery is decided.
test("github.token: a token that expires while the proof's listing is held is dropped: unavailable, not cached, the next call mints anew", async () => {
  let clock = Math.floor(Date.now() / 1000) * 1000;
  const { v, lines } = await tokenVault({ now: () => clock });
  github.script.mint = github.mintWith({
    expires_at: githubTime(clock + 2_000),
    repositories: undefined,
  });
  const held = github.hold("installationRepos");
  const asking = v.githubToken("u1", REPO);
  await held.arrived;
  clock += 5_000;
  held.release();
  assert.deepEqual(await asking, UNAVAILABLE);
  assert.equal(count("revoke"), 0, "proven, then stale: dropped");
  assert.ok(lines.some((line) => line.endsWith("proven token dropped")));
  delete github.script.mint;
  const next = await v.githubToken("u1", REPO);
  assert.equal(next.ok, true);
  assert.equal(count("mint"), 2, "the expired token was not cached");
  assert.notEqual((next as { token: string }).token, github.minted[0]);
  noSecretsIn(lines);
});

test("github.token: after an identity switch the cached token is not handed to the new identity", async () => {
  const { v } = await tokenVault();
  assert.equal((await v.githubToken("u1", REPO)).ok, true);
  await connect(v, "u1", FAKE_GITHUB_OTHER);
  assert.deepEqual(await v.githubToken("u1", REPO), DENIED);
  assert.equal(count("mint"), 1);
});

test("github.token: a slow GitHub spends the budget: unavailable within it, the late token never cached", async () => {
  // 25 s and 7 s per step, scaled down a hundredfold.
  const { v, lines } = await tokenVault({
    extra: { githubTokenBudgetMs: 250 },
  });
  github.script.mint = github.mintWith({ repositories: undefined });
  github.delayMs = 70;
  const started = Date.now();
  assert.deepEqual(await v.githubToken("u1", REPO), UNAVAILABLE);
  const took = Date.now() - started;
  assert.ok(took >= 240 && took < 400, `answered after ${took} ms`);
  await delay(200);
  github.delayMs = 0;
  delete github.script.mint;
  const mints = count("mint");
  assert.equal((await v.githubToken("u1", REPO)).ok, true);
  assert.equal(count("mint"), mints + 1, "the late token was not cached");
  noSecretsIn(lines);
});

test("github.token: a waiter abandoned during a held refresh answers at once; the refresh still stores and seals the rotation", async () => {
  const { dir } = await tokenVault();
  const written: string[] = [];
  const restarted = createVaultIntegrations({
    stateDir: dir,
    clients: { github: fakeGithubApp().client },
    githubEndpoint: github.endpoint,
    written: (file) => written.push(file),
  });
  const held = github.hold("token");
  const issued = github.issuedRefresh.length;
  const waiter = new AbortController();
  const asking = restarted.githubToken("u1", REPO, { signal: waiter.signal });
  await held.arrived;
  waiter.abort();
  assert.deepEqual(await asking, UNAVAILABLE);
  held.release();
  for (let i = 0; i < 100 && written.length === 0; i++) await delay(20);
  const file = join(
    dir,
    "accounts",
    integrationDirId("u1", "github"),
    INTEGRATION_FILE,
  );
  assert.deepEqual(written, [file], "the rotation is written and sealed");
  assert.equal(github.issuedRefresh.length, issued + 1);
  assert.equal(
    (JSON.parse(readFileSync(file, "utf8")) as { refreshToken: string })
      .refreshToken,
    github.issuedRefresh.at(-1),
  );
  assert.equal(count("repo"), 0, "the abandoned call went no further");
});
