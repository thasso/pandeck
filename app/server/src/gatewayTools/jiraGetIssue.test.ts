/**
 * `jira_get_issue` on the edge (Task-1397) through the tool host, with a
 * stubbed `fetch`: exact site-relative URLs with the user's Basic auth,
 * refused keys never fetched, fixed texts for non-2xx answers whose bodies
 * carry the token, truncation, and the deadline cutting a comments fetch.
 * Every value is fake.
 */
import assert from "node:assert/strict";
import { afterEach, test, vi } from "vitest";
import { setRetrySleepForTests } from "../httpRetry.ts";
import { FAKE_ACCESS } from "../test/atlassianFake.ts";
import { encodeAtlassianCredential } from "./atlassian.ts";
import { createToolHost, type ToolCaller } from "./host.ts";
import { EDGE_TOOLS } from "./tools.ts";

const FAKE = {
  site: "acme.atlassian.net",
  email: "me@x.test",
  token: "FAKE-TOKEN-SENTINEL",
};
const BASIC = `Basic ${Buffer.from(`${FAKE.email}:${FAKE.token}`).toString("base64")}`;

afterEach(() => {
  vi.unstubAllGlobals();
  setRetrySleepForTests(null);
});

const caller: ToolCaller = {
  clientId: "client-1",
  credential: () =>
    Promise.resolve({ ok: true, credential: encodeAtlassianCredential(FAKE) }),
};

function issueBody(description: string) {
  return {
    id: "10073",
    key: "OPS-73",
    fields: {
      summary: "Fix it",
      description: {
        type: "doc",
        version: 1,
        content: [
          { type: "paragraph", content: [{ type: "text", text: description }] },
        ],
      },
    },
  };
}

function stubFetch(answer: (url: URL) => Response | Promise<Response>) {
  const calls: { url: string; auth: string | null }[] = [];
  const fetch = vi.fn(async (url: URL, init?: RequestInit) => {
    calls.push({
      url: String(url),
      auth: new Headers(init?.headers).get("authorization"),
    });
    return answer(url);
  });
  vi.stubGlobal("fetch", fetch);
  return calls;
}

test("reads one issue from the user's site with the user's Basic auth", async () => {
  const calls = stubFetch((url) =>
    url.pathname.endsWith("/comment")
      ? new Response(
          JSON.stringify({
            total: 1,
            comments: [
              {
                id: "1",
                body: {
                  type: "doc",
                  version: 1,
                  content: [
                    {
                      type: "paragraph",
                      content: [{ type: "text", text: "c".repeat(5_000) }],
                    },
                  ],
                },
              },
            ],
          }),
        )
      : new Response(JSON.stringify(issueBody("d".repeat(25_000)))),
  );
  const host = createToolHost(EDGE_TOOLS, { log: () => {} });
  const answer = await host.call(
    "jira_get_issue",
    { issue: "OPS-73", includeComments: true, maxComments: 3 },
    caller,
  );
  assert.ok(answer.ok);
  const url = new URL(calls[0]!.url);
  assert.equal(url.origin, "https://acme.atlassian.net");
  assert.equal(url.pathname, "/rest/api/3/issue/OPS-73");
  assert.match(
    url.searchParams.get("fields")!,
    /^summary,project,.*description$/,
  );
  assert.equal(calls[0]!.auth, BASIC);
  assert.equal(
    calls[1]!.url,
    "https://acme.atlassian.net/rest/api/3/issue/OPS-73/comment?orderBy=-created&maxResults=3",
  );
  const { jiraHost, issue } = JSON.parse(answer.text) as {
    jiraHost: string;
    issue: Record<string, unknown> & {
      comments: { comments: { body: string; truncated?: boolean }[] };
    };
  };
  assert.equal(jiraHost, FAKE.site);
  assert.equal(issue.issueUrl, "https://acme.atlassian.net/browse/OPS-73");
  assert.equal((issue.description as string).length, 20_000);
  assert.equal(issue.truncated, true);
  assert.equal(issue.comments.comments[0]!.body.length, 4_000);
  assert.equal(issue.comments.comments[0]!.truncated, true);
  assert.doesNotMatch(answer.text, /FAKE-TOKEN-SENTINEL/);
});

test("keys that are not issue keys or ids are refused with no fetch", async () => {
  const calls = stubFetch(() => new Response("{}"));
  const host = createToolHost(EDGE_TOOLS, { log: () => {} });
  for (const issue of ["../x", "http://evil", "OPS-73/../../", "OPS-73?x=1"]) {
    const answer = await host.call("jira_get_issue", { issue }, caller);
    assert.ok(!answer.ok && answer.code === "invalid_params", issue);
  }
  assert.equal(calls.length, 0);
});

test("non-2xx answers become fixed texts; the token and Basic header never come back", async () => {
  setRetrySleepForTests(() => Promise.resolve());
  const host = createToolHost(EDGE_TOOLS, { log: () => {} });
  const cases: [number, string][] = [
    [
      401,
      "Atlassian rejected the credential; reconnect Jira in Pandeck's Settings.",
    ],
    [404, "Jira has no such issue, or the user can't see it."],
    [500, "Jira answered HTTP 500."],
  ];
  for (const [status, message] of cases) {
    stubFetch(
      () =>
        new Response(`echo ${FAKE.token} ${BASIC}`, {
          status,
        }),
    );
    const answer = await host.call(
      "jira_get_issue",
      { issue: "OPS-73" },
      caller,
    );
    assert.deepEqual(answer, { ok: false, code: "tool_error", message });
    assert.doesNotMatch(JSON.stringify(answer), /FAKE-TOKEN-SENTINEL|Basic /);
  }
});

test("the deadline cuts a comments fetch: it sees the abort and no retry runs", async () => {
  const sleeps: number[] = [];
  setRetrySleepForTests((ms) => {
    sleeps.push(ms);
    return Promise.resolve();
  });
  let commentSignal: AbortSignal | undefined;
  let commentCalls = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: URL, init?: RequestInit) => {
      if (!url.pathname.endsWith("/comment"))
        return new Response(JSON.stringify(issueBody("short")));
      commentCalls++;
      commentSignal = init?.signal ?? undefined;
      return new Promise<Response>((_resolve, reject) =>
        commentSignal!.addEventListener("abort", () =>
          reject(commentSignal!.reason as Error),
        ),
      );
    }),
  );
  const host = createToolHost(EDGE_TOOLS, { deadlineMs: 50, log: () => {} });
  const answer = await host.call(
    "jira_get_issue",
    { issue: "OPS-73", includeComments: true },
    caller,
  );
  assert.deepEqual(answer, {
    ok: false,
    code: "timeout",
    message: "The tool timed out.",
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(commentSignal?.aborted, true);
  assert.equal(commentCalls, 1);
  assert.deepEqual(sleeps, []);
});

test("with the vault's OAuth view: the fixed Jira base for the cloud id, Bearer, and browse URLs on the site", async () => {
  const cloudId = "00000000-0000-4000-8000-00000000fa4e";
  const FAKE_ACCESS_VIEW = FAKE_ACCESS;
  const view = JSON.stringify({
    kind: "atlassian-oauth",
    site: "castlabs-test.atlassian.net",
    cloudId,
    accessToken: FAKE_ACCESS_VIEW,
    expiresAt: 1_900_000_000_000,
  });
  const calls = stubFetch(
    () => new Response(JSON.stringify({ ...issueBody("d"), key: "OPS-1" })),
  );
  const host = createToolHost(EDGE_TOOLS, { log: () => {} });
  const answer = await host.call(
    "jira_get_issue",
    { issue: "OPS-1" },
    {
      clientId: "client-1",
      credential: () => Promise.resolve({ ok: true, credential: view }),
    },
  );
  assert.ok(answer.ok);
  assert.equal(calls.length, 1);
  const url = new URL(calls[0]!.url);
  assert.equal(
    `${url.origin}${url.pathname}`,
    `https://api.atlassian.com/ex/jira/${cloudId}/rest/api/3/issue/OPS-1`,
  );
  assert.match(url.searchParams.get("fields")!, /^summary,project,/);
  assert.equal(calls[0]!.auth, `Bearer ${FAKE_ACCESS_VIEW}`);
  const { jiraHost, issue } = JSON.parse(answer.text) as {
    jiraHost: string;
    issue: { issueUrl: string };
  };
  assert.equal(jiraHost, "castlabs-test.atlassian.net");
  assert.equal(
    issue.issueUrl,
    "https://castlabs-test.atlassian.net/browse/OPS-1",
  );
  assert.doesNotMatch(answer.text, new RegExp(FAKE_ACCESS_VIEW));
});

test("a 401 or 403 on the vault's OAuth view says to sign in with Atlassian again on the gateway's page; an API token keeps the Settings text", async () => {
  setRetrySleepForTests(() => Promise.resolve());
  const view = JSON.stringify({
    kind: "atlassian-oauth",
    site: "castlabs-test.atlassian.net",
    cloudId: "00000000-0000-4000-8000-00000000fa4e",
    accessToken: FAKE_ACCESS,
    expiresAt: 1_900_000_000_000,
  });
  const host = createToolHost(EDGE_TOOLS, { log: () => {} });
  for (const status of [401, 403]) {
    stubFetch(() => new Response(`echo ${FAKE_ACCESS}`, { status }));
    const oauth = await host.call(
      "jira_get_issue",
      { issue: "OPS-1" },
      {
        clientId: "client-1",
        credential: () => Promise.resolve({ ok: true, credential: view }),
      },
    );
    assert.deepEqual(oauth, {
      ok: false,
      code: "tool_error",
      message:
        "Atlassian rejected the credential; sign in with Atlassian again on the gateway's page.",
    });
    assert.doesNotMatch(JSON.stringify(oauth), new RegExp(FAKE_ACCESS));
    stubFetch(() => new Response("", { status }));
    const token = await host.call("jira_get_issue", { issue: "OPS-1" }, caller);
    assert.deepEqual(token, {
      ok: false,
      code: "tool_error",
      message:
        "Atlassian rejected the credential; reconnect Jira in Pandeck's Settings.",
    });
  }
});
