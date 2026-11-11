/**
 * The edge's Atlassian credential (`atlassian.ts`, Task-1397): the site is a
 * bare `*.atlassian.net` host (SSRF guard), the stored form round-trips, and
 * a check answers a problem code, never upstream text. Every value is fake.
 */
import assert from "node:assert/strict";
import { afterEach, test, vi } from "vitest";
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

test("describe names the site and email, never the token", () => {
  const { atlassian } = createEdgeTools({ log: () => {} }).integrations;
  const parsed = atlassian.parse({ ...base, site: "x.atlassian.net" });
  assert.ok(parsed.ok);
  assert.deepEqual(atlassian.describe(parsed.credential), {
    site: "x.atlassian.net",
    email: base.email,
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
