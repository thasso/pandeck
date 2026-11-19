/**
 * `jira_search_issues` on the edge (Task-1439) through the tool host, with a
 * stubbed `fetch`: the local tool's exact text from the same fixtures, both
 * credential kinds, no cache, its limits, the call's signal on every request,
 * the deadline and a caller's abort between pages, and failure texts that
 * never carry credential material. Only a rejected search (HTTP 400) shows
 * Jira's own reasons, vetted and capped (D4-yes). Every value is fake.
 */
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { afterEach, test, vi } from "vitest";
import { DATA_DIR } from "../config.ts";
import { setRetrySleepForTests } from "../httpRetry.ts";
import { FAKE_ACCESS, FAKE_CLOUD_ID } from "../test/atlassianFake.ts";
import {
  json,
  pendingUntilAbort,
  settle,
  stubJiraFetch,
  type SeenJiraRequest,
} from "../test/jiraEdgeFetch.ts";
import {
  JQL_BIG,
  JQL_FIELDS,
  JQL_PAGED,
  JQL_RENDER,
  PAGED_SEARCH_BODIES,
  fieldsSearchPayload,
  pagedSearchPayload,
  renderSearchPayload,
} from "../test/jiraReadFixtures.ts";
import { encodeAtlassianCredential } from "./atlassian.ts";
import { createToolHost, type ToolCaller } from "./host.ts";
import { EDGE_TOOLS } from "./tools.ts";

const FAKE = {
  site: "acme.atlassian.net",
  email: "me@x.test",
  token: "FAKE-TOKEN-SENTINEL",
};
const BASIC_VALUE = Buffer.from(`${FAKE.email}:${FAKE.token}`).toString(
  "base64",
);
const BASIC = `Basic ${BASIC_VALUE}`;
const SECRETS =
  /FAKE-TOKEN-SENTINEL|fake-atl-access-direct|Basic |Bearer |bWVAeC50ZXN0/;
const D4_NO =
  "Jira refused the search (HTTP 400); check the JQL, and resolve project, user and field names with jira_lookup.";
const REASONS = "Jira refused the search (HTTP 400): ";

afterEach(() => {
  vi.unstubAllGlobals();
  setRetrySleepForTests(null);
});

function tokenCaller(signal?: AbortSignal): ToolCaller {
  return {
    clientId: "client-1",
    credential: () =>
      Promise.resolve({
        ok: true,
        credential: encodeAtlassianCredential(FAKE),
      }),
    ...(signal ? { signal } : {}),
  };
}

function oauthCaller(): ToolCaller {
  return {
    clientId: "client-1",
    credential: () =>
      Promise.resolve({
        ok: true,
        credential: JSON.stringify({
          kind: "atlassian-oauth",
          site: FAKE.site,
          cloudId: FAKE_CLOUD_ID,
          accessToken: FAKE_ACCESS,
          expiresAt: Date.now() + 60_000,
        }),
      }),
  };
}

function host(options: { deadlineMs?: number } = {}) {
  const lines: string[] = [];
  return {
    lines,
    host: createToolHost(EDGE_TOOLS, {
      log: (line) => lines.push(line),
      ...options,
    }),
  };
}

/** Every request carried the call's signal, live when it started. */
function assertSignals(seen: SeenJiraRequest[]): void {
  assert.ok(seen.length > 0);
  for (const request of seen) {
    assert.ok(request.signal, `${request.method} ${request.path}`);
    assert.equal(request.abortedAtStart, false, request.path);
  }
}

test("a compact search answers the local tool's exact text, paging past startAt", async () => {
  const seen = stubJiraFetch();
  const { host: tools } = host();
  const answer = await tools.call(
    "jira_search_issues",
    { jql: JQL_PAGED, maxResults: 3, startAt: 2 },
    tokenCaller(),
  );
  assert.deepEqual(answer, {
    ok: true,
    text: JSON.stringify(pagedSearchPayload(FAKE.site)),
  });
  assert.deepEqual(
    seen.map(
      (request) => `${request.method} ${request.url.origin}${request.path}`,
    ),
    [
      "GET https://acme.atlassian.net/rest/api/3/field",
      "POST https://acme.atlassian.net/rest/api/3/search/jql",
      "POST https://acme.atlassian.net/rest/api/3/search/jql",
    ],
  );
  assert.deepEqual(
    seen.slice(1).map((request) => request.body),
    PAGED_SEARCH_BODIES,
  );
  for (const request of seen) assert.equal(request.auth, BASIC);
  assertSignals(seen);
});

test("a rendered search and named fields answer the local tool's exact text", async () => {
  const seen = stubJiraFetch();
  const { host: tools } = host();
  const rendered = await tools.call(
    "jira_search_issues",
    {
      jql: JQL_RENDER,
      maxResults: 1,
      render: true,
      renderFields: ["key", "summary", "Story Points"],
    },
    tokenCaller(),
  );
  assert.deepEqual(rendered, {
    ok: true,
    text: JSON.stringify(renderSearchPayload(FAKE.site)),
  });
  const named = await tools.call(
    "jira_search_issues",
    {
      jql: JQL_FIELDS,
      maxResults: 1,
      fields: ["summary", "Story Points", "Sprint", "No Such Field"],
    },
    tokenCaller(),
  );
  assert.deepEqual(named, {
    ok: true,
    text: JSON.stringify(fieldsSearchPayload(FAKE.site)),
  });
  assertSignals(seen);
});

test("with OAuth the requests go with Bearer to the API base; links stay on the site", async () => {
  const seen = stubJiraFetch();
  const { host: tools } = host();
  const answer = await tools.call(
    "jira_search_issues",
    { jql: JQL_PAGED, maxResults: 3, startAt: 2 },
    oauthCaller(),
  );
  assert.deepEqual(answer, {
    ok: true,
    text: JSON.stringify(pagedSearchPayload(FAKE.site)),
  });
  for (const request of seen) {
    assert.equal(request.url.origin, "https://api.atlassian.com");
    assert.ok(
      request.url.pathname.startsWith(`/ex/jira/${FAKE_CLOUD_ID}/rest/api/3/`),
      request.url.pathname,
    );
    assert.equal(request.auth, `Bearer ${FAKE_ACCESS}`);
  }
  assertSignals(seen);
});

test("a result above 60,000 characters answers result_too_large (D5)", async () => {
  stubJiraFetch();
  const { host: tools } = host();
  const answer = await tools.call(
    "jira_search_issues",
    { jql: JQL_BIG, maxResults: 1000 },
    tokenCaller(),
  );
  assert.deepEqual(answer, {
    ok: false,
    code: "result_too_large",
    message: "The tool's result is too large.",
  });
});

test("maxResults is clamped to 1000 across the pages", async () => {
  const seen = stubJiraFetch();
  const { host: tools } = host();
  await tools.call(
    "jira_search_issues",
    { jql: JQL_BIG, maxResults: 2000 },
    tokenCaller(),
  );
  const pages = seen.filter((request) => request.method === "POST");
  assert.equal(pages.length, 10);
  assert.equal(
    pages.reduce(
      (sum, request) =>
        sum + Number((request.body as { maxResults: number }).maxResults),
      0,
    ),
    1000,
  );
  assertSignals(seen);
});

test("nothing is cached: each call reads the field list, and no file is written", async () => {
  const seen = stubJiraFetch();
  const { host: tools } = host();
  for (let i = 0; i < 2; i += 1)
    await tools.call(
      "jira_search_issues",
      { jql: JQL_FIELDS, maxResults: 1, fields: ["summary"] },
      tokenCaller(),
    );
  assert.equal(
    seen.filter((request) => request.path === "/rest/api/3/field").length,
    2,
  );
  assert.equal(existsSync(join(DATA_DIR, "cache", "jira")), false);
});

test("the deadline or the caller's abort stops a search between pages", async () => {
  for (const ending of ["deadline", "caller"] as const) {
    const caller = new AbortController();
    const seen = stubJiraFetch((request) => {
      const body = request.body as { nextPageToken?: string } | null;
      if (request.method !== "POST" || !body?.nextPageToken) return undefined;
      if (ending === "caller") setTimeout(() => caller.abort(), 0);
      return pendingUntilAbort(request);
    });
    const { host: tools } = host({ deadlineMs: 200 });
    const answer = await tools.call(
      "jira_search_issues",
      { jql: JQL_PAGED, maxResults: 3, startAt: 2 },
      tokenCaller(caller.signal),
    );
    assert.equal(answer.ok, false, ending);
    assert.equal(
      !answer.ok && answer.code,
      ending === "deadline" ? "timeout" : "cancelled",
    );
    const count = seen.length;
    assert.equal(seen.at(-1)!.signal!.aborted, true);
    await settle();
    assert.equal(seen.length, count, `${ending}: no request after the end`);
    assertSignals(seen);
  }
});

test("HTTP failures answer fixed texts; the token, Basic value and body never come back", async () => {
  setRetrySleepForTests(() => Promise.resolve());
  const cases: [number, ToolCaller, string][] = [
    [
      401,
      tokenCaller(),
      "Atlassian rejected the credential; reconnect Jira in Pandeck's Settings.",
    ],
    [
      403,
      oauthCaller(),
      "Atlassian rejected the credential; sign in with Atlassian again on the gateway's page.",
    ],
    [404, tokenCaller(), "Jira answered HTTP 404."],
    [500, tokenCaller(), "Jira answered HTTP 500."],
  ];
  for (const [status, caller, message] of cases) {
    stubJiraFetch(
      (request) =>
        new Response(
          `echo ${FAKE.token} ${BASIC} Bearer ${FAKE_ACCESS} ${request.url}`,
          { status },
        ),
    );
    const { host: tools, lines } = host();
    const answer = await tools.call(
      "jira_search_issues",
      { jql: "project = SECRETJQL", maxResults: 5 },
      caller,
    );
    assert.deepEqual(answer, { ok: false, code: "tool_error", message });
    assert.doesNotMatch(JSON.stringify(answer), SECRETS);
    assert.doesNotMatch(JSON.stringify(answer), /SECRETJQL/);
    for (const line of lines) assert.doesNotMatch(line, SECRETS);
  }
});

/** A search whose search request Jira answers 400 with `body`. */
async function rejectedSearch(
  body: unknown,
  caller: ToolCaller = tokenCaller(),
): Promise<{ answer: unknown; message: string; lines: string[] }> {
  stubJiraFetch((request) =>
    request.method === "POST"
      ? new Response(typeof body === "string" ? body : JSON.stringify(body), {
          status: 400,
        })
      : undefined,
  );
  const { host: tools, lines } = host();
  const answer = await tools.call(
    "jira_search_issues",
    { jql: "project = SECRETJQL", maxResults: 5 },
    caller,
  );
  assert.ok(!answer.ok && answer.code === "tool_error", JSON.stringify(answer));
  return { answer, message: answer.message, lines };
}

test("a rejected search (HTTP 400) answers Jira's reasons, in order (D4-yes)", async () => {
  const { message } = await rejectedSearch({
    errorMessages: ["SENTINEL-A"],
    errors: { project: "SENTINEL-B" },
  });
  assert.equal(message, `${REASONS}SENTINEL-A; SENTINEL-B`);
  const extra = await rejectedSearch({
    errorMessages: ["x"],
    other: "SENTINEL-C",
  });
  assert.equal(extra.message, `${REASONS}x`);
});

test("only string reasons in their containers pass; without any, the fixed text", async () => {
  const cases: [unknown, string][] = [
    [{ errorMessages: ["ok", 5, null, { a: "b" }] }, `${REASONS}ok`],
    [{ errorMessages: "SENTINEL-A", errors: ["SENTINEL-B"] }, D4_NO],
    [{ errorMessages: [], errors: {} }, D4_NO],
    [{ errorMessages: ["  "] }, D4_NO],
    [{}, D4_NO],
    ["<html>SENTINEL-A</html>", D4_NO],
    ["", D4_NO],
  ];
  for (const [body, expected] of cases)
    assert.equal(
      (await rejectedSearch(body)).message,
      expected,
      JSON.stringify(body),
    );
});

test("control characters become spaces and the text is capped at 500 characters", async () => {
  const controls = await rejectedSearch({
    errorMessages: ["a\u0001b\u0085c\nd\u007fe"],
  });
  assert.equal(controls.message, `${REASONS}a b c d e`);
  const long = await rejectedSearch({ errorMessages: ["y".repeat(2000)] });
  assert.equal(long.message.length, 500);
  assert.ok(long.message.startsWith(`${REASONS}yyy`));
  assert.ok(long.message.endsWith("y…"));
});

test("a reason holding credential material or an auth marker falls back to the fixed text (F6)", async () => {
  const unpadded = BASIC_VALUE.replace(/=+$/, "");
  assert.notEqual(unpadded, BASIC_VALUE);
  const cut = "x".repeat(480);
  // Starts before index 500 of the final text and ends after it.
  const straddle = "x".repeat(500 - REASONS.length - 5);
  assert.ok(REASONS.length + straddle.length < 500);
  assert.ok(
    REASONS.length + straddle.length + FAKE.token.length > 500 &&
      REASONS.length + straddle.length + FAKE_ACCESS.length > 500,
  );
  const cases: [string, unknown, ToolCaller][] = [
    ["token", { errorMessages: [`bad ${FAKE.token}`] }, tokenCaller()],
    ["Basic value", { errors: { jql: `v ${BASIC_VALUE}` } }, tokenCaller()],
    ["unpadded Basic value", { errors: { jql: unpadded } }, tokenCaller()],
    [
      "Authorization header",
      { errors: { jql: `Authorization: Basic ${BASIC_VALUE}` } },
      tokenCaller(),
    ],
    [
      "token across the cut",
      { errorMessages: [cut + FAKE.token] },
      tokenCaller(),
    ],
    [
      "token straddling the cut",
      { errorMessages: [straddle + FAKE.token] },
      tokenCaller(),
    ],
    ["access token", { errorMessages: [`bad ${FAKE_ACCESS}`] }, oauthCaller()],
    [
      "access token straddling the cut",
      { errorMessages: [straddle + FAKE_ACCESS] },
      oauthCaller(),
    ],
    [
      "Bearer value",
      { errorMessages: [`Bearer ${FAKE_ACCESS}`] },
      oauthCaller(),
    ],
    [
      "access token across the cut",
      { errorMessages: [cut + FAKE_ACCESS] },
      oauthCaller(),
    ],
    [
      "a later reason",
      { errorMessages: ["fine"], errors: { jql: FAKE_ACCESS } },
      oauthCaller(),
    ],
    [
      "authorization alone",
      { errorMessages: ["No AUTHORIZATION here"] },
      tokenCaller(),
    ],
    [
      "bearer marker alone",
      { errorMessages: ["a bearer of news"] },
      tokenCaller(),
    ],
    ["basic marker alone", { errorMessages: ["basic search"] }, oauthCaller()],
    ["Bearer then a tab", { errorMessages: ["Bearer\tX"] }, tokenCaller()],
    [
      "basic then a no-break space",
      { errorMessages: ["basic X"] },
      tokenCaller(),
    ],
    [
      "Bearer then a C1 control",
      { errorMessages: ["Bearer\u0085X"] },
      oauthCaller(),
    ],
  ];
  for (const [label, body, caller] of cases) {
    const { answer, message, lines } = await rejectedSearch(body, caller);
    assert.equal(message, D4_NO, label);
    assert.doesNotMatch(JSON.stringify(answer), SECRETS, label);
    assert.doesNotMatch(JSON.stringify(answer), /SECRETJQL/, label);
    for (const line of lines) assert.doesNotMatch(line, SECRETS, label);
  }
});

test("a 400 on the field list is not a rejected search: no reasons pass", async () => {
  stubJiraFetch((request) =>
    request.path === "/rest/api/3/field"
      ? json({ errorMessages: ["SENTINEL-A"] }, 400)
      : undefined,
  );
  const { host: tools } = host();
  const answer = await tools.call(
    "jira_search_issues",
    { jql: JQL_FIELDS, maxResults: 1, fields: ["summary"] },
    tokenCaller(),
  );
  assert.deepEqual(answer, {
    ok: false,
    code: "tool_error",
    message: "Jira answered HTTP 400.",
  });
});

test("a failure that is not Jira's answer is the host's fixed text", async () => {
  setRetrySleepForTests(() => Promise.resolve());
  stubJiraFetch(() => {
    throw new TypeError(`connect failed ${FAKE.token}`);
  });
  const { host: tools } = host();
  const answer = await tools.call(
    "jira_search_issues",
    { jql: "x", maxResults: 5 },
    tokenCaller(),
  );
  assert.deepEqual(answer, {
    ok: false,
    code: "failed",
    message: "jira_search_issues failed.",
  });
});

test("arguments the schema refuses, and an empty JQL, never reach Jira", async () => {
  const seen = stubJiraFetch();
  const { host: tools } = host();
  for (const args of [
    { jql: "x", maxResults: "5" },
    { jql: "x", maxResults: 5, fields: "summary" },
    { jql: "x", maxResults: 5, detailLevel: "bogus" },
    { jql: "x" },
  ]) {
    const answer = await tools.call("jira_search_issues", args, tokenCaller());
    assert.equal(
      !answer.ok && answer.code,
      "invalid_params",
      JSON.stringify(args),
    );
  }
  const empty = await tools.call(
    "jira_search_issues",
    { jql: "   ", maxResults: 5 },
    tokenCaller(),
  );
  assert.deepEqual(empty, {
    ok: false,
    code: "tool_error",
    message: "jql must not be empty.",
  });
  assert.equal(seen.length, 0);
});
