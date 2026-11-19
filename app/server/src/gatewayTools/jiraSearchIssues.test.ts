/**
 * `jira_search_issues` on the edge (Task-1439) through the tool host, with a
 * stubbed `fetch`: the local tool's exact text from the same fixtures, both
 * credential kinds, no cache, its limits, the call's signal on every request,
 * the deadline and a caller's abort between pages, and fixed failure texts
 * that never carry the token, Jira's body or the JQL. Every value is fake.
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

test("a rejected search (HTTP 400) answers the fixed text, not Jira's reasons (D4-no)", async () => {
  stubJiraFetch((request) =>
    request.method === "POST"
      ? json(
          {
            errorMessages: [`SENTINEL-A ${FAKE.token}`],
            errors: { project: `SENTINEL-B ${BASIC}` },
          },
          400,
        )
      : undefined,
  );
  const { host: tools, lines } = host();
  const answer = await tools.call(
    "jira_search_issues",
    { jql: "project = SECRETJQL", maxResults: 5 },
    tokenCaller(),
  );
  assert.deepEqual(answer, { ok: false, code: "tool_error", message: D4_NO });
  assert.doesNotMatch(JSON.stringify(answer), /SENTINEL|SECRETJQL/);
  assert.doesNotMatch(JSON.stringify(answer), SECRETS);
  for (const line of lines) assert.doesNotMatch(line, SECRETS);
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
