/**
 * The vault's Atlassian OAuth client and the connect that uses it
 * (Task-1411, AC2): the exact requests on the wire (TLS name, `Host`, body,
 * Bearer), no redirect followed, each failure's outcome, the site choice, and
 * that a connect stores the refresh token but answers and persists no access
 * token. Against a loopback fake (`test/atlassianFake.ts`); every value fake.
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, test } from "vitest";
import {
  FAKE_ACCESS,
  FAKE_CLIENT,
  FAKE_CLOUD_ID,
  FAKE_CODE,
  FAKE_REDIRECT,
  FAKE_SITE,
  FAKE_STORED_REFRESH,
  ONE_SITE,
  jsonResponder,
  startAtlassianFake,
  type AtlassianFake,
} from "../test/atlassianFake.ts";
import type { IntegrationClients } from "./integrationClients.ts";
import {
  atlassianResources,
  exchangeAtlassianCode,
  refreshAtlassian,
  selectAtlassianSite,
} from "./vaultAtlassian.ts";
import { createVaultIntegrations } from "./vaultIntegrations.ts";
import { INTEGRATION_FILE, integrationDirId } from "./vaultMethods.ts";

const root = mkdtempSync(join(tmpdir(), "vault-atl-"));
let fake: AtlassianFake;
let defaults: Pick<AtlassianFake, "token" | "resources">;

beforeAll(async () => {
  fake = await startAtlassianFake();
  defaults = { token: fake.token, resources: fake.resources };
});
afterEach(() => {
  fake.seen.length = 0;
  fake.token = defaults.token;
  fake.resources = defaults.resources;
});
afterAll(async () => {
  await fake.close();
  rmSync(root, { recursive: true, force: true });
});

const OTHER_ID = "00000000-0000-4000-8000-00000000fa4f";
const site = (host: string, id: string) => ({
  id,
  name: host,
  url: `https://${host}`,
  scopes: [],
});

test("the code exchange posts the documented JSON grant to auth.atlassian.com only", async () => {
  const result = await exchangeAtlassianCode(
    FAKE_CLIENT,
    { code: FAKE_CODE, redirectUri: FAKE_REDIRECT },
    fake.endpoint,
  );
  assert.equal(result.kind, "ok");
  const [request] = fake.seen;
  assert.equal(fake.seen.length, 1);
  assert.equal(request!.route, "token");
  assert.equal(request!.method, "POST");
  assert.equal(request!.path, "/oauth/token");
  assert.equal(request!.servername, "auth.atlassian.com");
  assert.equal(request!.headers.host, "auth.atlassian.com");
  assert.equal(request!.headers["content-type"], "application/json");
  assert.deepEqual(JSON.parse(request!.body), {
    grant_type: "authorization_code",
    client_id: FAKE_CLIENT.clientId,
    client_secret: FAKE_CLIENT.clientSecret,
    code: FAKE_CODE,
    redirect_uri: FAKE_REDIRECT,
  });
});

test("a refresh posts the refresh_token grant", async () => {
  const result = await refreshAtlassian(
    FAKE_CLIENT,
    FAKE_STORED_REFRESH,
    fake.endpoint,
  );
  assert.equal(result.kind, "ok");
  assert.deepEqual(JSON.parse(fake.seen[0]!.body), {
    grant_type: "refresh_token",
    client_id: FAKE_CLIENT.clientId,
    client_secret: FAKE_CLIENT.clientSecret,
    refresh_token: FAKE_STORED_REFRESH,
  });
});

test("the site list goes to api.atlassian.com with the Bearer token", async () => {
  const result = await atlassianResources(FAKE_ACCESS, fake.endpoint);
  assert.deepEqual(result, { kind: "ok", resources: ONE_SITE });
  const [request] = fake.seen;
  assert.equal(request!.method, "GET");
  assert.equal(request!.path, "/oauth/token/accessible-resources");
  assert.equal(request!.servername, "api.atlassian.com");
  assert.equal(request!.headers.host, "api.atlassian.com");
  assert.equal(request!.headers.authorization, `Bearer ${FAKE_ACCESS}`);
});

test("a redirect from either host is not followed and is unreachable", async () => {
  const redirect = (
    _: unknown,
    res: { raw: import("node:http").ServerResponse },
  ) => {
    res.raw.writeHead(302, { location: "https://evil.example.test/steal" });
    res.raw.end();
  };
  fake.token = redirect;
  fake.resources = redirect;
  assert.deepEqual(
    await exchangeAtlassianCode(
      FAKE_CLIENT,
      { code: FAKE_CODE, redirectUri: FAKE_REDIRECT },
      fake.endpoint,
    ),
    { kind: "unreachable", code: "redirect" },
  );
  assert.deepEqual(await atlassianResources(FAKE_ACCESS, fake.endpoint), {
    kind: "unreachable",
    code: "redirect",
  });
  // One request each: nothing went to the location.
  assert.deepEqual(
    fake.seen.map((request) => request.route),
    ["token", "resources"],
  );
});

test("each token-endpoint failure maps to rejected or unreachable", async () => {
  const exchange = () =>
    exchangeAtlassianCode(
      FAKE_CLIENT,
      { code: FAKE_CODE, redirectUri: FAKE_REDIRECT },
      fake.endpoint,
    );
  for (const status of [400, 401, 403]) {
    fake.token = jsonResponder(status, { error: "invalid_grant" });
    assert.deepEqual(await exchange(), { kind: "rejected" }, String(status));
  }
  for (const status of [429, 500, 503]) {
    fake.token = jsonResponder(status, { error: "busy" });
    assert.deepEqual(
      await exchange(),
      { kind: "unreachable", code: String(status) },
      String(status),
    );
  }
  fake.token = jsonResponder(200, "not json");
  assert.deepEqual(await exchange(), {
    kind: "unreachable",
    code: "bad_response",
  });
  fake.token = jsonResponder(200, { access_token: "x".repeat(70_000) });
  assert.deepEqual(await exchange(), { kind: "unreachable", code: "oversize" });
  // No refresh token: offline_access was not granted.
  fake.token = jsonResponder(200, {
    access_token: FAKE_ACCESS,
    expires_in: 3600,
  });
  assert.deepEqual(await exchange(), { kind: "rejected" });
  // Timeout: the fake never answers within the deadline.
  const held = fake.hold("token");
  assert.deepEqual(
    await exchangeAtlassianCode(
      FAKE_CLIENT,
      { code: FAKE_CODE, redirectUri: FAKE_REDIRECT },
      { ...fake.endpoint, timeoutMs: 100 },
    ),
    { kind: "unreachable", code: "timeout" },
  );
  held.release();
  // Nothing listening.
  const closed = await startAtlassianFake();
  await closed.close();
  assert.deepEqual(
    await exchangeAtlassianCode(
      FAKE_CLIENT,
      { code: FAKE_CODE, redirectUri: FAKE_REDIRECT },
      closed.endpoint,
    ),
    { kind: "unreachable", code: "ECONNREFUSED" },
  );
});

test("exchange refusals and refresh service errors have separate status mappings", async () => {
  for (const status of [
    400, 401, 403, 404, 405, 408, 409, 410, 422, 429, 500, 503,
  ]) {
    fake.token = jsonResponder(status, {});
    const exchange = await exchangeAtlassianCode(
      FAKE_CLIENT,
      { code: FAKE_CODE, redirectUri: FAKE_REDIRECT },
      fake.endpoint,
    );
    const refreshed = await refreshAtlassian(
      FAKE_CLIENT,
      FAKE_STORED_REFRESH,
      fake.endpoint,
    );
    const unreachable = { kind: "unreachable", code: String(status) };
    assert.deepEqual(
      exchange,
      status < 500 && status !== 408 && status !== 429
        ? { kind: "rejected" }
        : unreachable,
      `exchange ${status}`,
    );
    assert.deepEqual(
      refreshed,
      [400, 401, 403].includes(status) ? { kind: "rejected" } : unreachable,
      `refresh ${status}`,
    );
  }
  for (const status of [400, 401, 403, 404, 408, 429, 500, 503]) {
    fake.resources = jsonResponder(status, {});
    assert.deepEqual(
      await atlassianResources(FAKE_ACCESS, fake.endpoint),
      status === 401 || status === 403
        ? { kind: "rejected" }
        : { kind: "unreachable", code: String(status) },
      `resources ${status}`,
    );
  }
});

test("the site choice groups by host and counts sites, not entries", () => {
  // Jira and Confluence entries of one site, no preset: that site.
  assert.deepEqual(selectAtlassianSite(ONE_SITE, undefined), {
    ok: true,
    site: FAKE_SITE,
    cloudId: FAKE_CLOUD_ID,
  });
  const two = [
    ...ONE_SITE,
    site("other-fake.atlassian.net", OTHER_ID),
    site("other-fake.atlassian.net", OTHER_ID),
  ];
  assert.deepEqual(selectAtlassianSite(two, undefined), {
    ok: false,
    site: "ambiguous",
  });
  // With a preset: that site's id, case-insensitively.
  assert.deepEqual(selectAtlassianSite(two, "Other-Fake.atlassian.net"), {
    ok: true,
    site: "other-fake.atlassian.net",
    cloudId: OTHER_ID,
  });
  assert.deepEqual(selectAtlassianSite(two, "absent-fake.atlassian.net"), {
    ok: false,
    site: "missing",
  });
  // One host naming two ids: ambiguous, with or without a preset.
  const split = [site(FAKE_SITE, FAKE_CLOUD_ID), site(FAKE_SITE, OTHER_ID)];
  assert.deepEqual(selectAtlassianSite(split, undefined), {
    ok: false,
    site: "ambiguous",
  });
  assert.deepEqual(selectAtlassianSite(split, FAKE_SITE), {
    ok: false,
    site: "ambiguous",
  });
  // Not an Atlassian Cloud host, not https, or not a UUID: ignored.
  assert.deepEqual(
    selectAtlassianSite(
      [
        site("jira.example.test", OTHER_ID),
        { id: OTHER_ID, url: "http://plain-fake.atlassian.net" },
        site("bad-id-fake.atlassian.net", "not-a-uuid"),
        ...ONE_SITE,
      ],
      undefined,
    ),
    { ok: true, site: FAKE_SITE, cloudId: FAKE_CLOUD_ID },
  );
  assert.deepEqual(selectAtlassianSite([], undefined), {
    ok: false,
    site: "missing",
  });
});

function integrations(
  dir: string,
  clients: IntegrationClients = { atlassian: FAKE_CLIENT },
) {
  const lines: string[] = [];
  const port = createVaultIntegrations(
    { stateDir: dir, clients, atlassianEndpoint: fake.endpoint },
    (line) => lines.push(line),
  );
  return Object.assign(port, { lines });
}

const connect = (
  port: ReturnType<typeof integrations>,
  site?: string,
): ReturnType<typeof port.integrationConnect> =>
  port.integrationConnect("u1", "atlassian", {
    code: FAKE_CODE,
    redirectUri: FAKE_REDIRECT,
    site,
  });

test("a connect stores the refresh token, answers site and cloud id, and keeps the access token in memory only", async () => {
  const dir = mkdtempSync(join(root, "connect-"));
  const port = integrations(dir);
  const answer = await connect(port);
  assert.deepEqual(answer, {
    ok: true,
    site: FAKE_SITE,
    cloudId: FAKE_CLOUD_ID,
  });
  assert.doesNotMatch(JSON.stringify(answer), /fake-atl-/);
  const file = join(
    dir,
    "accounts",
    integrationDirId("u1", "atlassian"),
    INTEGRATION_FILE,
  );
  const stored = JSON.parse(readFileSync(file, "utf8"));
  assert.deepEqual(stored, {
    kind: "atlassian-oauth",
    v: 1,
    site: FAKE_SITE,
    cloudId: FAKE_CLOUD_ID,
    refreshToken: fake.issuedRefresh.at(-1),
    scope: "read:jira-work offline_access",
  });
  assert.doesNotMatch(readFileSync(file, "utf8"), /fake-atl-access/);
  // The resources call used the exchange's access token.
  const [token, resources] = fake.seen;
  assert.equal(token!.route, "token");
  assert.match(
    String(resources!.headers.authorization),
    /^Bearer fake-atl-access-\d+$/,
  );
  for (const line of port.lines)
    assert.doesNotMatch(line, /fake-atl-|fake-atlassian-/);
  await port.close();
});

test("a connect's failures and site outcomes", async () => {
  const dir = mkdtempSync(join(root, "connect-fail-"));
  const port = integrations(dir);
  const file = join(
    dir,
    "accounts",
    integrationDirId("u1", "atlassian"),
    INTEGRATION_FILE,
  );
  fake.token = jsonResponder(400, { error: "invalid_grant" });
  assert.deepEqual(await connect(port), { ok: false, rejected: true });
  fake.token = jsonResponder(502, {});
  assert.deepEqual(await connect(port), { ok: false, unreachable: true });
  fake.token = defaults.token;
  fake.resources = jsonResponder(500, {});
  assert.deepEqual(await connect(port), { ok: false, unreachable: true });
  fake.resources = jsonResponder(200, { not: "a list" });
  assert.deepEqual(await connect(port), { ok: false, unreachable: true });
  fake.resources = jsonResponder(200, [
    ...ONE_SITE,
    site("other-fake.atlassian.net", OTHER_ID),
  ]);
  assert.deepEqual(await connect(port), { ok: false, site: "ambiguous" });
  assert.deepEqual(await connect(port, "absent-fake.atlassian.net"), {
    ok: false,
    site: "missing",
  });
  fake.resources = jsonResponder(200, []);
  assert.deepEqual(await connect(port), { ok: false, site: "missing" });
  // Nothing was stored by any of them.
  assert.throws(() => readFileSync(file), { code: "ENOENT" });
  // A mixed list with the preset picks the preset's id.
  fake.resources = jsonResponder(200, [
    ...ONE_SITE,
    site("other-fake.atlassian.net", OTHER_ID),
  ]);
  assert.deepEqual(await connect(port, "other-fake.atlassian.net"), {
    ok: true,
    site: "other-fake.atlassian.net",
    cloudId: OTHER_ID,
  });
  for (const line of port.lines)
    assert.doesNotMatch(line, /fake-atl-|fake-atlassian-/);
  await port.close();
});

test("without an Atlassian client a connect is not configured and sends nothing", async () => {
  const port = integrations(mkdtempSync(join(root, "none-")), {});
  assert.deepEqual(await connect(port), { ok: false, notConfigured: true });
  assert.equal(fake.seen.length, 0);
  await port.close();
});
