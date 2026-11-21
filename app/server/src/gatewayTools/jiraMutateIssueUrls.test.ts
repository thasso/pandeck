/**
 * `jira_mutate_issue`'s link vetting through the tool host (Task-1463 P4b2,
 * A1 (iii) and (v)): links that carry the call's secret raw, percent-encoded
 * once or twice, or only in an intermediate decoding. Real Jira never builds
 * such a link from a valid key, so apply is replaced here by one that sets
 * the link under test on a valid, ordinary key (STAR-135); prepare runs for
 * real over the fake Jira. A benign link of the same shape is kept, so no
 * omission passes because of the key or the link's structure. Every value is
 * fake.
 */
import assert from "node:assert/strict";
import { afterEach, test, vi } from "vitest";
import type { JiraIssueMutationItemDisplay } from "@assistant/shared/jiraMutation";
import { stubJiraFetch } from "../test/jiraEdgeFetch.ts";
import { fakeJiraAnswer } from "../test/jiraMutateFetch.ts";
import { encodeAtlassianCredential } from "./atlassian.ts";
import type { AtlassianTokenCredential } from "./descriptor.ts";
import { createToolHost } from "./host.ts";
import type { ProjectedResult } from "./jiraMutateIssue.ts";
import { EDGE_TOOLS } from "./tools.ts";
import { holdsSecret, secretForms } from "./upstreamText.ts";

const link = vi.hoisted(() => ({ url: "" }));

vi.mock("../jiraMutateApply.ts", () => ({
  applyJiraMutationItems: (
    _config: unknown,
    items: JiraIssueMutationItemDisplay[],
  ) => {
    for (const item of items) item.resultIssueUrl = link.url;
    return Promise.resolve({
      succeeded: items.length,
      resultSummary: `Applied ${items.length} change(s)`,
      resultUrl: link.url,
    });
  },
}));

afterEach(() => vi.unstubAllGlobals());

const SITE = "acme.atlassian.net";
const BROWSE = `https://${SITE}/browse/STAR-135?t=`;
/** `encodeURIComponent` changes its `?` and `>`; its Basic forms hold a `+`. */
const URI_TOKEN: AtlassianTokenCredential = {
  site: SITE,
  email: "me@x.test",
  token: "fake~tok?en>SENTINEL-9",
};

/** The projected result of one edit to STAR-135 whose link is `url`. */
async function projected(
  url: string,
  credential: AtlassianTokenCredential,
): Promise<{ result: ProjectedResult; text: string }> {
  link.url = url;
  stubJiraFetch((request) => fakeJiraAnswer(request));
  const answer = await createToolHost(EDGE_TOOLS, { log: () => {} }).call(
    "jira_mutate_issue",
    { items: [{ issue: "STAR-135", summary: "New summary" }] },
    {
      clientId: "client-1",
      credential: () =>
        Promise.resolve({
          ok: true,
          credential: encodeAtlassianCredential(credential),
        }),
    },
  );
  assert.ok(answer.ok, JSON.stringify(answer));
  const result = JSON.parse(answer.text) as ProjectedResult;
  // The key always passes: only the link is under test.
  assert.equal(result.items[0]!.issueKey, "STAR-135");
  return { result, text: answer.text };
}

function assertKept(
  { result }: { result: ProjectedResult },
  url: string,
): void {
  assert.equal(result.url, url);
  assert.equal(result.items[0]!.url, url);
}

function assertOmitted(
  { result, text }: { result: ProjectedResult; text: string },
  credential: AtlassianTokenCredential,
): void {
  assert.equal(result.url, undefined);
  assert.equal(result.items[0]!.url, undefined);
  for (const form of secretForms(credential)) assert.ok(!text.includes(form));
  assert.ok(!holdsSecret(text, credential));
}

/** `value` and its once- and twice-encoded forms, each differing from the last. */
function encodings(value: string): string[] {
  const once = encodeURIComponent(value);
  const twice = encodeURIComponent(once);
  assert.notEqual(once, value, "the once-encoded form differs from the raw");
  assert.notEqual(twice, once, "the twice-encoded form differs from the once");
  return [value, once, twice];
}

test("A1 (iii): a link holding the API token raw, encoded once or twice, is omitted; the same shape without it is kept", async () => {
  for (const form of encodings(URI_TOKEN.token)) {
    if (form !== URI_TOKEN.token)
      assert.ok(!form.includes(URI_TOKEN.token), "only a decoding reveals it");
    assertOmitted(await projected(BROWSE + form, URI_TOKEN), URI_TOKEN);
  }
  for (const form of encodings("fake~tok?en>CONTROL-9").slice(1))
    assertKept(await projected(BROWSE + form, URI_TOKEN), BROWSE + form);
});

test("A1 (v): a link holding the padded or unpadded Basic value, raw or encoded, is omitted", async () => {
  const [padded, unpadded] = secretForms(URI_TOKEN).slice(1);
  assert.ok(padded!.endsWith("=") && padded!.includes("+"), padded);
  assert.equal(unpadded, padded!.replace(/=+$/, ""));
  for (const basic of [padded!, unpadded!])
    for (const form of encodings(basic))
      assertOmitted(await projected(BROWSE + form, URI_TOKEN), URI_TOKEN);
});

test("A1: a secret only an intermediate decoding shows omits the link, though the raw and final forms are clean", async () => {
  const credential: AtlassianTokenCredential = {
    site: SITE,
    email: "me@x.test",
    token: "SECRET%41-TOKEN-VALUE-0001",
  };
  const url = `${BROWSE}SECRET%2541-TOKEN-VALUE-0001`;
  const intermediate = decodeURIComponent(url);
  const final = decodeURIComponent(intermediate);
  assert.equal(decodeURIComponent(final), final, "the final form is stable");
  assert.ok(!holdsSecret(url, credential), "the raw form is clean");
  assert.ok(!holdsSecret(final, credential), "the final form is clean");
  assert.ok(intermediate.includes(credential.token));
  assertOmitted(await projected(url, credential), credential);
  // The same link under another credential is kept: only the secret omits it.
  assertKept(await projected(url, URI_TOKEN), url);
});

test("A1: a benign link that needs decoding is kept, and one still changing after three decodings is omitted", async () => {
  const benign = `${BROWSE}a%252Fb`;
  assertKept(await projected(benign, URI_TOKEN), benign);
  const plain = `https://${SITE}/browse/STAR-135`;
  assertKept(await projected(plain, URI_TOKEN), plain);
  // Three decodings reach "a/b", the fourth finds it stable: kept.
  const three = `${BROWSE}a%25252Fb`;
  assertKept(await projected(three, URI_TOKEN), three);
  // Three decodings reach "a%41", still changing: omitted, with no decode error.
  const deep = `${BROWSE}a%25252541`;
  assert.equal(
    decodeURIComponent(decodeURIComponent(decodeURIComponent(deep))),
    `${BROWSE}a%41`,
  );
  assertOmitted(await projected(deep, URI_TOKEN), URI_TOKEN);
});
