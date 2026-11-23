/**
 * The vault's GitHub App client (Task-1444, Task-1440 plan v06 PR1) against
 * a loopback GitHub fake carrying spike S1a's answer shapes: the OAuth code
 * exchange, refresh with rotation and `GET /user` (AC2, AC3, AC6). Every
 * value is fake.
 */
import assert from "node:assert/strict";
import { afterAll, afterEach, beforeAll, test } from "vitest";
import {
  FAKE_GITHUB_CLIENT,
  FAKE_GITHUB_CODE,
  FAKE_GITHUB_REDIRECT,
  FAKE_GITHUB_USER,
  githubJson,
  githubTokenAnswer,
  startGithubFake,
  type GithubFake,
} from "../test/githubFake.ts";
import {
  exchangeGithubCode,
  githubUser,
  refreshGithub,
} from "./vaultGithub.ts";

let github: GithubFake;
beforeAll(async () => {
  github = await startGithubFake();
});
afterEach(() => github.reset());
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
    accessToken: github.issuedAccess[0],
    refreshToken: github.issuedRefresh[0],
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
