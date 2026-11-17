/**
 * The edge's Atlassian credential (`atlassian.ts`, Task-1397): the site is a
 * bare `*.atlassian.net` host (SSRF guard), the stored form round-trips, and
 * a check answers a problem code, never upstream text. Every value is fake.
 */
import assert from "node:assert/strict";
import { afterEach, test, vi } from "vitest";
import { FAKE_ACCESS } from "../test/atlassianFake.ts";
import {
  checkAtlassian,
  decodeAtlassianCredential,
  encodeAtlassianCredential,
  parseAtlassianCredential,
} from "./atlassian.ts";
import { createEdgeTools } from "./index.ts";

const base = { email: "me@x.test", token: "fake-token-1" };

afterEach(() => vi.unstubAllGlobals());

test("only a bare atlassian.net host is a site", () => {
  assert.deepEqual(
    parseAtlassianCredential({ ...base, site: "castlabs.atlassian.net" }),
    { ...base, site: "castlabs.atlassian.net" },
  );
  assert.equal(
    parseAtlassianCredential({ ...base, site: "CastLabs.Atlassian.NET" })?.site,
    "castlabs.atlassian.net",
  );
  for (const site of [
    "https://x.atlassian.net",
    "x.atlassian.net:443",
    "evil.com",
    "x.atlassian.net.evil.com",
    "a@x.atlassian.net",
    "x.atlassian.net/",
    "atlassian.net",
  ])
    assert.equal(parseAtlassianCredential({ ...base, site }), undefined, site);
  const site = "x.atlassian.net";
  assert.equal(
    parseAtlassianCredential({ ...base, site, email: "x" }),
    undefined,
  );
  assert.equal(
    parseAtlassianCredential({ ...base, site, token: "" }),
    undefined,
  );
  assert.equal(
    parseAtlassianCredential({ ...base, site, token: "t".repeat(513) }),
    undefined,
  );
});

test("the stored form round-trips and a bad one decodes to nothing", () => {
  const credential = { ...base, site: "x.atlassian.net" };
  assert.deepEqual(
    decodeAtlassianCredential(encodeAtlassianCredential(credential)),
    credential,
  );
  assert.equal(decodeAtlassianCredential("{not json"), undefined);
  assert.equal(
    decodeAtlassianCredential(JSON.stringify({ ...base, site: "evil.com" })),
    undefined,
  );
});

test("a check maps 401 to rejected and a network failure to unreachable, with no upstream text", async () => {
  const credential = { ...base, site: "x.atlassian.net" };
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response("SENTINEL upstream body", { status: 401 })),
  );
  assert.deepEqual(
    await checkAtlassian(credential, new AbortController().signal),
    { ok: false, problem: "rejected" },
  );
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      throw new TypeError("fetch failed");
    }),
  );
  assert.deepEqual(
    await checkAtlassian(credential, new AbortController().signal),
    { ok: false, problem: "unreachable" },
  );
  const seen: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: URL) => {
      seen.push(String(url));
      return new Response(
        JSON.stringify({ displayName: "Ada", accountId: "acc-1" }),
      );
    }),
  );
  assert.deepEqual(
    await checkAtlassian(credential, new AbortController().signal),
    { ok: true, displayName: "Ada", accountId: "acc-1" },
  );
  assert.deepEqual(seen, ["https://x.atlassian.net/rest/api/3/myself"]);
});

test("describe names an API token's kind, site and email, never the token", () => {
  const { atlassian } = createEdgeTools({ log: () => {} }).integrations;
  const parsed = atlassian.parse({ ...base, site: "x.atlassian.net" });
  assert.ok(parsed.ok);
  assert.deepEqual(atlassian.describe(parsed.credential), {
    site: "x.atlassian.net",
    email: base.email,
    kind: "token",
  });
  assert.doesNotMatch(
    JSON.stringify(atlassian.describe(parsed.credential)),
    /fake-token-1/,
  );
  assert.equal(atlassian.describe("{}"), undefined);
  assert.deepEqual(atlassian.parse({ ...base, site: "evil.com" }), {
    ok: false,
  });
});

// --- The vault's OAuth access view (Task-1411) ------------------------------

const CLOUD_ID = "00000000-0000-4000-8000-00000000fa4e";
const FAKE_ACCESS_VIEW = FAKE_ACCESS;
const FAKE_INVALID_ACCESS_HEADER = "line\r\nX-Injected: 1";
const VIEW = {
  kind: "atlassian-oauth",
  site: "castlabs-test.atlassian.net",
  cloudId: CLOUD_ID,
  accessToken: FAKE_ACCESS_VIEW,
  expiresAt: 1_900_000_000_000,
};

test("an OAuth access view decodes to site, cloud id and access token", () => {
  assert.deepEqual(decodeAtlassianCredential(JSON.stringify(VIEW)), {
    site: VIEW.site,
    cloudId: CLOUD_ID,
    accessToken: VIEW.accessToken,
  });
  // `expiresAt` is the vault's; the edge needs none.
  const { expiresAt: _unused, ...noExpiry } = VIEW;
  assert.ok(decodeAtlassianCredential(JSON.stringify(noExpiry)));
  assert.ok(
    decodeAtlassianCredential(
      JSON.stringify({ ...VIEW, accessToken: "a".repeat(8192) }),
    ),
  );
});

test("a bad view, a non-UUID cloud id or an unknown kind decodes to nothing", () => {
  const bad: Record<string, unknown>[] = [
    { ...VIEW, kind: "atlassian-token" },
    { ...VIEW, kind: "" },
    { ...VIEW, kind: 1 },
    { ...VIEW, cloudId: "not-a-uuid" },
    { ...VIEW, cloudId: CLOUD_ID.toUpperCase() },
    { ...VIEW, cloudId: `${CLOUD_ID}/../x` },
    { ...VIEW, cloudId: undefined },
    { ...VIEW, site: "evil.com" },
    { ...VIEW, site: "Castlabs-Test.atlassian.net" },
    { ...VIEW, accessToken: "" },
    { ...VIEW, accessToken: "a".repeat(8193) },
    { ...VIEW, accessToken: "two words" },
    { ...VIEW, accessToken: FAKE_INVALID_ACCESS_HEADER },
    { ...VIEW, accessToken: 7 },
    // An API token's fields under the OAuth kind are not a credential.
    { kind: "atlassian-oauth", ...base, site: "x.atlassian.net" },
  ];
  for (const view of bad)
    assert.equal(
      decodeAtlassianCredential(JSON.stringify(view)),
      undefined,
      JSON.stringify(view),
    );
  assert.equal(decodeAtlassianCredential("null"), undefined);
  assert.equal(decodeAtlassianCredential('"text"'), undefined);
});

test("a check of an OAuth view asks /myself on the fixed Jira base with Bearer", async () => {
  const seen: { url: string; auth: string | null }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: URL, init?: RequestInit) => {
      seen.push({
        url: String(url),
        auth: new Headers(init?.headers).get("authorization"),
      });
      return new Response(JSON.stringify({ displayName: "Ada" }));
    }),
  );
  const view = decodeAtlassianCredential(JSON.stringify(VIEW))!;
  assert.deepEqual(await checkAtlassian(view, new AbortController().signal), {
    ok: true,
    displayName: "Ada",
  });
  assert.deepEqual(seen, [
    {
      url: `https://api.atlassian.com/ex/jira/${CLOUD_ID}/rest/api/3/myself`,
      auth: `Bearer ${FAKE_ACCESS_VIEW}`,
    },
  ]);
});

test("describe names an OAuth view's kind and site only, never its token", () => {
  const { atlassian } = createEdgeTools({ log: () => {} }).integrations;
  const text = JSON.stringify(VIEW);
  assert.deepEqual(atlassian.describe(text), {
    site: VIEW.site,
    kind: "oauth",
  });
  assert.equal(
    atlassian.describe(JSON.stringify({ ...VIEW, kind: "other" })),
    undefined,
  );
});
