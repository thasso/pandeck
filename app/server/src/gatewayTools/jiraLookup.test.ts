/**
 * `jira_lookup` on the edge (Task-1439) through the tool host, with a stubbed
 * `fetch`: the local tool's exact text for projects and users, every kind
 * with nonempty answers, both credential kinds, its limits, the call's signal
 * on every request, the deadline and a caller's abort at every read, and
 * fixed failure and refusal texts. Every value is fake.
 */
import assert from "node:assert/strict";
import { afterEach, test, vi } from "vitest";
import { setRetrySleepForTests } from "../httpRetry.ts";
import { FAKE_ACCESS, FAKE_CLOUD_ID } from "../test/atlassianFake.ts";
import {
  json,
  pendingUntilAbort,
  settle,
  stubJiraFetch,
  type JiraResponder,
  type SeenJiraRequest,
} from "../test/jiraEdgeFetch.ts";
import {
  projectsLookupPayload,
  usersLookupPayload,
} from "../test/jiraReadFixtures.ts";
import { encodeAtlassianCredential } from "./atlassian.ts";
import { createToolHost, type ToolCaller } from "./host.ts";
import { EDGE_TOOLS } from "./tools.ts";

const FAKE = {
  site: "acme.atlassian.net",
  email: "me@x.test",
  token: "FAKE-TOKEN-SENTINEL",
};
const BASIC = `Basic ${Buffer.from(`${FAKE.email}:${FAKE.token}`).toString("base64")}`;
const SECRETS = /FAKE-TOKEN-SENTINEL|fake-atl-access-direct|Basic |Bearer /;

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
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

function assertSignals(seen: SeenJiraRequest[]): void {
  assert.ok(seen.length > 0);
  for (const request of seen) {
    assert.ok(request.signal, `${request.method} ${request.path}`);
    assert.equal(request.abortedAtStart, false, request.path);
  }
}

const LINK_TYPES = {
  issueLinkTypes: [
    { id: "1010", name: "Blocks", inward: "is blocked by", outward: "blocks" },
    {
      id: "1000",
      name: "Relates",
      inward: "relates to",
      outward: "relates to",
    },
  ],
};

const SPRINTS = [
  { id: 5, name: "STAR 5", state: "active", originBoardId: 42 },
  { id: 6, name: "STAR 6", state: "future", originBoardId: 42 },
  {
    id: 4,
    name: "STAR 4",
    state: "closed",
    endDate: "2026-10-01T10:00:00.000Z",
    originBoardId: 42,
  },
];

/** Jira Agile: boards 7 (kanban, no sprints) and 42, and board 42's sprints. */
const agile: JiraResponder = (request) => {
  if (request.path === "/rest/agile/1.0/board")
    return json({
      values: [
        { id: 7, name: "Kanban", type: "kanban" },
        { id: 42, name: "Scrum", type: "scrum" },
      ],
      isLast: true,
    });
  if (request.path === "/rest/agile/1.0/board/7/sprint")
    return json({ errorMessages: ["The board does not support sprints"] }, 400);
  if (request.path === "/rest/agile/1.0/board/42/sprint") {
    const states = request.query.state!.split(",");
    return json({
      values: SPRINTS.filter((sprint) => states.includes(sprint.state)),
      isLast: true,
    });
  }
  if (request.path === "/rest/api/3/issueLinkType") return json(LINK_TYPES);
  return undefined;
};

async function lookup(
  args: Record<string, unknown>,
  caller: ToolCaller = tokenCaller(),
) {
  return host().host.call("jira_lookup", args, caller);
}

test("projects and users answer the local tool's exact text", async () => {
  const seen = stubJiraFetch();
  assert.deepEqual(
    await lookup({ kind: "projects", query: "op", maxResults: 2 }),
    { ok: true, text: JSON.stringify(projectsLookupPayload(FAKE.site)) },
  );
  assert.deepEqual(
    await lookup({ kind: "users", query: "ada", maxResults: 2 }),
    { ok: true, text: JSON.stringify(usersLookupPayload(FAKE.site)) },
  );
  assert.deepEqual(
    seen.map((request) => `${request.url.origin}${request.path}`),
    [
      "https://acme.atlassian.net/rest/api/3/project/search",
      "https://acme.atlassian.net/rest/api/3/user/search",
    ],
  );
  for (const request of seen) assert.equal(request.auth, BASIC);
  assertSignals(seen);
});

test("with OAuth the requests go with Bearer to the API base; links stay on the site", async () => {
  const seen = stubJiraFetch();
  assert.deepEqual(
    await lookup(
      { kind: "projects", query: "op", maxResults: 2 },
      oauthCaller(),
    ),
    { ok: true, text: JSON.stringify(projectsLookupPayload(FAKE.site)) },
  );
  assert.equal(
    seen[0]!.url.origin + seen[0]!.url.pathname,
    `https://api.atlassian.com/ex/jira/${FAKE_CLOUD_ID}/rest/api/3/project/search`,
  );
  assert.equal(seen[0]!.auth, `Bearer ${FAKE_ACCESS}`);
  assertSignals(seen);
});

test("fields are read per call and filtered by custom and searchable", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-19T12:00:00.000Z"));
  const seen = stubJiraFetch();
  const answer = await lookup({
    kind: "fields",
    custom: true,
    searchable: true,
  });
  assert.ok(answer.ok);
  assert.deepEqual(JSON.parse(answer.text), {
    kind: "fields",
    jiraHost: FAKE.site,
    custom: true,
    searchable: true,
    returned: 1,
    totalMatched: 1,
    exhausted: true,
    fetchedAt: "2026-11-19T12:00:00.000Z",
    fields: [
      {
        id: "customfield_10016",
        key: "customfield_10016",
        name: "Story Points",
        custom: true,
        orderable: true,
        navigable: true,
        searchable: true,
        clauseNames: ["cf[10016]", "Story Points"],
        schemaType: "number",
        customType: "com.atlassian.jira.plugin.system.customfieldtypes:float",
        customId: 10016,
      },
    ],
  });
  await lookup({ kind: "fields" });
  assert.equal(
    seen.filter((request) => request.path === "/rest/api/3/field").length,
    2,
  );
  assertSignals(seen);
});

test("issue link types are read per call and filtered by query", async () => {
  const seen = stubJiraFetch(agile);
  const answer = await lookup({ kind: "issueLinkTypes", query: "blocked" });
  assert.ok(answer.ok);
  assert.deepEqual(JSON.parse(answer.text), {
    kind: "issueLinkTypes",
    jiraHost: FAKE.site,
    query: "blocked",
    returned: 1,
    totalMatched: 1,
    exhausted: true,
    linkTypes: [
      {
        id: "1010",
        name: "Blocks",
        inward: "is blocked by",
        outward: "blocks",
      },
    ],
  });
  assertSignals(seen);
});

test("sprints of a board, and of a project's boards with a state filter", async () => {
  const seen = stubJiraFetch(agile);
  const byBoard = await lookup({ kind: "sprints", boardId: 42 });
  assert.ok(byBoard.ok);
  assert.deepEqual(JSON.parse(byBoard.text), {
    kind: "sprints",
    jiraHost: FAKE.site,
    boardId: 42,
    states: ["active", "future"],
    returned: 2,
    totalMatched: 2,
    exhausted: true,
    sprints: [
      {
        id: 5,
        name: "STAR 5",
        state: "active",
        startDate: null,
        endDate: null,
        boardId: 42,
      },
      {
        id: 6,
        name: "STAR 6",
        state: "future",
        startDate: null,
        endDate: null,
        boardId: 42,
      },
    ],
  });
  const byProject = await lookup({
    kind: "sprints",
    projectKey: "star",
    sprintStates: ["closed"],
  });
  assert.ok(byProject.ok);
  assert.deepEqual(JSON.parse(byProject.text), {
    kind: "sprints",
    jiraHost: FAKE.site,
    projectKey: "STAR",
    boards: [
      { id: 7, name: "Kanban", type: "kanban" },
      { id: 42, name: "Scrum", type: "scrum" },
    ],
    boardsWithoutSprints: [7],
    states: ["closed"],
    returned: 1,
    totalMatched: 1,
    exhausted: true,
    sprints: [
      {
        id: 4,
        name: "STAR 4",
        state: "closed",
        startDate: null,
        endDate: "2026-10-01T10:00:00.000Z",
        boardId: 42,
      },
    ],
  });
  assert.deepEqual(
    seen.find((request) => request.path === "/rest/agile/1.0/board")!.query,
    { projectKeyOrId: "STAR", maxResults: "10" },
  );
  assertSignals(seen);
});

test("only Jira's own 400 marks a board without sprints: a 403 quoting HTTP 400 is the remedy", async () => {
  // Board 7 (kanban) answers a real 400 and is still skipped; board 42's 403
  // body quotes "HTTP 400" and must not be mistaken for one.
  stubJiraFetch((request) =>
    request.path === "/rest/agile/1.0/board/42/sprint"
      ? json(
          {
            errorMessages: ["Upstream request failed, previously HTTP 400"],
          },
          403,
        )
      : agile(request),
  );
  assert.deepEqual(await lookup({ kind: "sprints", projectKey: "STAR" }), {
    ok: false,
    code: "tool_error",
    message:
      "Atlassian rejected the credential; reconnect Jira in Pandeck's Settings.",
  });
});

test("a failure that is not Jira's answer is not a board without sprints, whatever it says", async () => {
  setRetrySleepForTests(() => Promise.resolve());
  stubJiraFetch((request) => {
    if (request.path === "/rest/agile/1.0/board/42/sprint")
      throw new TypeError("proxy said HTTP 400");
    return agile(request);
  });
  assert.deepEqual(await lookup({ kind: "sprints", projectKey: "STAR" }), {
    ok: false,
    code: "failed",
    message: "jira_lookup failed.",
  });
});

test("users are clamped to 10,000 across the pages", async () => {
  const seen = stubJiraFetch((request) =>
    request.path === "/rest/api/3/user/search"
      ? json(
          Array.from({ length: Number(request.query.maxResults) }, (_, i) => ({
            accountId: `acc-${request.query.startAt}-${i}`,
          })),
        )
      : undefined,
  );
  await lookup({
    kind: "users",
    query: "many",
    maxResults: 20000,
    fields: ["accountId"],
  });
  assert.equal(
    seen.reduce((sum, request) => sum + Number(request.query.maxResults), 0),
    10000,
  );
  assertSignals(seen);
});

test("input refusals answer fixed texts without the caller's values, and fetch nothing they need not", async () => {
  const seen = stubJiraFetch((request) =>
    request.path === "/rest/agile/1.0/board"
      ? json({ values: [], isLast: true })
      : undefined,
  );
  const cases: [Record<string, unknown>, string][] = [
    [
      { kind: "users", assignableOnly: true },
      "projectKey is required when assignableOnly=true.",
    ],
    [{ kind: "sprints" }, "kind=sprints requires boardId or projectKey."],
    [
      { kind: "sprints", boardId: -3 },
      "kind=sprints boardId must be a positive integer.",
    ],
  ];
  for (const [args, message] of cases)
    assert.deepEqual(await lookup(args), {
      ok: false,
      code: "tool_error",
      message,
    });
  assert.equal(seen.length, 0);
  const noBoard = await lookup({ kind: "sprints", projectKey: "SECRETKEY" });
  assert.deepEqual(noBoard, {
    ok: false,
    code: "tool_error",
    message: "No Jira board shows that project.",
  });
});

test("arguments the schema refuses never reach Jira", async () => {
  const seen = stubJiraFetch();
  for (const args of [
    { kind: "bogus" },
    { kind: "projects", fields: "summary" },
    { kind: "sprints", boardId: 42, sprintStates: ["bogus"] },
    { kind: "users", maxResults: "5" },
    { kind: "sprints", boardId: 4.5 },
  ]) {
    const answer = await lookup(args);
    assert.equal(
      !answer.ok && answer.code,
      "invalid_params",
      JSON.stringify(args),
    );
  }
  assert.equal(seen.length, 0);
});

test("a lookup Jira rejects (HTTP 400) shows none of Jira's reasons, clean ones included", async () => {
  stubJiraFetch(() =>
    json(
      { errorMessages: ["SENTINEL-A"], errors: { project: "SENTINEL-B" } },
      400,
    ),
  );
  assert.deepEqual(await lookup({ kind: "projects", query: "op" }), {
    ok: false,
    code: "tool_error",
    message: "Jira answered HTTP 400.",
  });
});

test("HTTP failures answer fixed texts; a 404 or 400 is not an issue's text", async () => {
  setRetrySleepForTests(() => Promise.resolve());
  const cases: [number, ToolCaller, string][] = [
    [
      401,
      tokenCaller(),
      "Atlassian rejected the credential; reconnect Jira in Pandeck's Settings.",
    ],
    [
      401,
      oauthCaller(),
      "Atlassian rejected the credential; sign in with Atlassian again on the gateway's page.",
    ],
    [400, tokenCaller(), "Jira answered HTTP 400."],
    [404, tokenCaller(), "Jira answered HTTP 404."],
    [500, tokenCaller(), "Jira answered HTTP 500."],
  ];
  for (const [status, caller, message] of cases) {
    stubJiraFetch(() =>
      json(
        {
          errorMessages: [`SENTINEL-A ${FAKE.token} ${BASIC}`],
          errors: { project: `Bearer ${FAKE_ACCESS}` },
        },
        status,
      ),
    );
    const { host: tools, lines } = host();
    const answer = await tools.call(
      "jira_lookup",
      { kind: "projects", query: "SECRETQUERY" },
      caller,
    );
    assert.deepEqual(answer, { ok: false, code: "tool_error", message });
    assert.doesNotMatch(JSON.stringify(answer), SECRETS);
    assert.doesNotMatch(JSON.stringify(answer), /SENTINEL|SECRETQUERY/);
    for (const line of lines) assert.doesNotMatch(line, SECRETS);
  }
});

/** Each read a lookup makes, held open until the call ends. */
const HELD: [
  string,
  Record<string, unknown>,
  (r: SeenJiraRequest) => boolean,
][] = [
  ["the field list", { kind: "fields" }, (r) => r.path === "/rest/api/3/field"],
  [
    "the link types",
    { kind: "issueLinkTypes" },
    (r) => r.path === "/rest/api/3/issueLinkType",
  ],
  [
    "a project page after the first",
    { kind: "projects", maxResults: 300 },
    (r) => r.path === "/rest/api/3/project/search" && r.query.startAt !== "0",
  ],
  [
    "the board listing",
    { kind: "sprints", projectKey: "STAR" },
    (r) => r.path === "/rest/agile/1.0/board",
  ],
  [
    "a board's sprint page after the first",
    { kind: "sprints", boardId: 42 },
    (r) =>
      r.path === "/rest/agile/1.0/board/42/sprint" && r.query.startAt !== "0",
  ],
];

/** Full project pages of 300, and board 42 with sprints one page at a time. */
const paged: JiraResponder = (request) => {
  if (request.path === "/rest/api/3/project/search") {
    const startAt = Number(request.query.startAt);
    const size = Number(request.query.maxResults);
    return json({
      values: Array.from({ length: size }, (_, i) => ({
        id: `${startAt + i}`,
        key: `P${startAt + i}`,
      })),
      total: 300,
      startAt,
      isLast: false,
    });
  }
  if (request.path === "/rest/agile/1.0/board/42/sprint")
    return json({
      values: [{ id: Number(request.query.startAt) + 1, state: "active" }],
      isLast: false,
    });
  return agile(request);
};

test("the deadline or the caller's abort ends every read, and nothing follows", async () => {
  for (const [what, args, held] of HELD)
    for (const ending of ["deadline", "caller"] as const) {
      const label = `${what}, ${ending}`;
      const caller = new AbortController();
      const seen = stubJiraFetch((request) => {
        if (!held(request)) return paged(request);
        if (ending === "caller") setTimeout(() => caller.abort(), 0);
        return pendingUntilAbort(request);
      });
      const { host: tools } = host({ deadlineMs: 200 });
      const answer = await tools.call(
        "jira_lookup",
        args,
        tokenCaller(caller.signal),
      );
      assert.equal(
        !answer.ok && answer.code,
        ending === "deadline" ? "timeout" : "cancelled",
        label,
      );
      assert.ok(held(seen.at(-1)!), label);
      assert.equal(seen.at(-1)!.signal!.aborted, true, label);
      const count = seen.length;
      await settle();
      assert.equal(seen.length, count, `${label}: no request after the end`);
      assertSignals(seen);
    }
});
