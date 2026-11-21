/**
 * `confluence_search`, `confluence_get_page` and `confluence_lookup` on the
 * edge (Task-1439 P2) through the tool host, with a stubbed `fetch`: every
 * case of the local tools' frozen baseline answers its compact form, with
 * both credential kinds; unknown arguments, upstream failures and input
 * refusals answer fixed texts holding no caller value, upstream body or
 * credential; the call's signal is on every request and retry, and the
 * deadline or the caller's abort ends a read with nothing after it; a page
 * above the 60,000-character ceiling is `result_too_large` (D5). Every value
 * is fake.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { afterEach, test, vi } from "vitest";
import { setRetrySleepForTests } from "../httpRetry.ts";
import { FAKE_ACCESS, FAKE_CLOUD_ID } from "../test/atlassianFake.ts";
import {
  stubConfluenceFetch,
  type ConfluenceResponder,
  type SeenConfluenceRequest,
} from "../test/confluenceEdgeFetch.ts";
import {
  CONFLUENCE_FIXTURE_SITE,
  HUGE_TEXT,
} from "../test/confluenceReadFixtures.ts";
import { json, pendingUntilAbort, settle } from "../test/jiraEdgeFetch.ts";
import { encodeAtlassianCredential } from "./atlassian.ts";
import { createToolHost, type ToolCaller } from "./host.ts";
import { EDGE_TOOLS } from "./tools.ts";

// The local tools, for their `details`: the same site, an API token.
vi.mock("../confluenceSettings.ts", async (importActual) => ({
  ...(await importActual<typeof import("../confluenceSettings.ts")>()),
  getConfluenceToolConfig: () => ({
    host: CONFLUENCE_FIXTURE_SITE,
    atlassianEmail: "me@x.test",
    atlassianToken: "FAKE-TOKEN-SENTINEL",
  }),
}));

const { confluenceSearchTool, confluenceGetPageTool, confluenceLookupTool } =
  await import("../tools/confluence/confluenceTools.ts");

const FAKE = {
  site: CONFLUENCE_FIXTURE_SITE,
  email: "me@x.test",
  token: "FAKE-TOKEN-SENTINEL",
};
const BASIC = `Basic ${Buffer.from(`${FAKE.email}:${FAKE.token}`).toString("base64")}`;
const SECRETS = /FAKE-TOKEN-SENTINEL|fake-atl-access-direct|Basic |Bearer /;
const SITE_ORIGIN = `https://${CONFLUENCE_FIXTURE_SITE}`;
const API_BASE = `https://api.atlassian.com/ex/confluence/${FAKE_CLOUD_ID}/wiki/`;

const FIXTURE_DIR = new URL(
  "../tools/confluence/__fixtures__/confluenceReadBaseline/",
  import.meta.url,
);

type ToolName =
  "confluence_search" | "confluence_get_page" | "confluence_lookup";

type LocalTool = {
  execute: (
    params: never,
    ctx: never,
  ) => Promise<{ details?: unknown; isError?: boolean }>;
};

const LOCAL: Record<ToolName, LocalTool> = {
  confluence_search: confluenceSearchTool,
  confluence_get_page: confluenceGetPageTool,
  confluence_lookup: confluenceLookupTool,
};

/** The baseline's cases (`confluenceReadBaseline.test.ts`), by tool name. */
const CASES: Array<
  [name: string, tool: ToolName, params: Record<string, unknown>]
> = [
  [
    "search-filters",
    "confluence_search",
    {
      text: "deploy",
      spaceKeys: ["ENG", "OPS"],
      updatedSince: "2026-01-01",
      maxResults: 2,
    },
  ],
  ["search-raw-cql", "confluence_search", { cql: "id = 101" }],
  ["search-empty", "confluence_search", { title: "nothing matches" }],
  [
    "get-page-all-sections",
    "confluence_get_page",
    {
      page: "https://acme.atlassian.net/wiki/spaces/ENG/pages/101/Runbook",
      includeComments: true,
      includeLabels: true,
      includeChildren: true,
      includeAttachments: true,
    },
  ],
  ["get-page-plain", "confluence_get_page", { page: "101" }],
  ["get-page-storage-fallback", "confluence_get_page", { page: "102" }],
  ["get-page-space-unreadable", "confluence_get_page", { page: "103" }],
  [
    "get-page-truncated",
    "confluence_get_page",
    { page: "104", maxChars: 1000 },
  ],
  [
    "lookup-spaces",
    "confluence_lookup",
    { kind: "spaces", query: "eng", cursor: "spc-page-1", maxResults: 3 },
  ],
  [
    "lookup-page-tree-by-page",
    "confluence_lookup",
    { kind: "pageTree", page: "101" },
  ],
  [
    "lookup-page-tree-by-space",
    "confluence_lookup",
    { kind: "pageTree", spaceKey: "ENG" },
  ],
  ["lookup-labels", "confluence_lookup", { kind: "labels", page: "101" }],
  [
    "lookup-attachments",
    "confluence_lookup",
    { kind: "attachments", page: "101", maxResults: 2 },
  ],
  ["lookup-comments", "confluence_lookup", { kind: "comments", page: "101" }],
  [
    "lookup-replies",
    "confluence_lookup",
    { kind: "replies", commentId: "c1", cursor: "rp1" },
  ],
];

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

function call(
  tool: ToolName,
  args: Record<string, unknown>,
  caller: ToolCaller = tokenCaller(),
) {
  return host().host.call(tool, args, caller);
}

/** The local tool's `details` for the same arguments and fixtures. */
async function localDetails(
  tool: ToolName,
  args: Record<string, unknown>,
): Promise<unknown> {
  stubConfluenceFetch();
  const result = await LOCAL[tool].execute(
    args as never,
    { session: { sessionId: "edge-parity" } } as never,
  );
  assert.notEqual(result.isError, true, tool);
  return result.details;
}

function baselineText(name: string): string {
  return readFileSync(new URL(`${name}.txt`, FIXTURE_DIR), "utf8");
}

function assertSignals(seen: SeenConfluenceRequest[]): void {
  assert.ok(seen.length > 0);
  for (const request of seen) {
    assert.ok(request.signal, request.path);
    assert.equal(request.abortedAtStart, false, request.path);
  }
}

test("every baseline case answers the frozen local payload, compact, with an API token", async () => {
  for (const [name, tool, args] of CASES) {
    const seen = stubConfluenceFetch();
    const answer = await call(tool, args);
    // The independent oracle: the text captured before the extraction.
    assert.deepEqual(
      answer,
      { ok: true, text: JSON.stringify(JSON.parse(baselineText(name))) },
      name,
    );
    for (const request of seen) {
      assert.equal(request.url.origin, SITE_ORIGIN, `${name} ${request.path}`);
      assert.ok(request.path.startsWith("/wiki/"), request.path);
      assert.equal(request.auth, BASIC, name);
    }
    assertSignals(seen);
    assert.ok(answer.ok);
    assert.deepEqual(
      JSON.parse(answer.text),
      await localDetails(tool, args),
      `${name}: the local tool's details`,
    );
  }
});

test("with OAuth every request goes with Bearer to the API base; links stay on the site", async () => {
  for (const [name, tool, args] of CASES) {
    const seen = stubConfluenceFetch();
    assert.deepEqual(
      await call(tool, args, oauthCaller()),
      { ok: true, text: JSON.stringify(JSON.parse(baselineText(name))) },
      name,
    );
    for (const request of seen) {
      assert.ok(
        request.url.href.startsWith(API_BASE),
        `${name}: ${request.url.origin}${request.url.pathname}`,
      );
      assert.equal(request.auth, `Bearer ${FAKE_ACCESS}`, name);
    }
    assertSignals(seen);
  }
  // A relative upstream link and the fallback form both resolve to the site.
  stubConfluenceFetch();
  for (const [page, url] of [
    ["101", "https://acme.atlassian.net/wiki/spaces/ENG/pages/101/Runbook"],
    ["102", "https://acme.atlassian.net/wiki/pages/viewpage.action?pageId=102"],
  ] as const) {
    const answer = await call("confluence_get_page", { page }, oauthCaller());
    assert.ok(answer.ok, page);
    const payload = JSON.parse(answer.text) as {
      confluenceHost: string;
      page: { url: string };
    };
    assert.equal(payload.confluenceHost, CONFLUENCE_FIXTURE_SITE);
    assert.equal(payload.page.url, url);
  }
});

test("arguments the schemas refuse never reach Confluence", async () => {
  const seen = stubConfluenceFetch();
  const cases: [ToolName, Record<string, unknown>][] = [
    ["confluence_search", { text: "deploy", bogus: true }],
    ["confluence_search", { text: "deploy", maxResults: "5" }],
    ["confluence_get_page", { page: "101", expand: "body" }],
    ["confluence_get_page", {}],
    ["confluence_lookup", { kind: "spaces", limit: 5 }],
    ["confluence_lookup", { kind: "bogus" }],
  ];
  for (const [tool, args] of cases) {
    const answer = await call(tool, args);
    assert.equal(
      !answer.ok && answer.code,
      "invalid_params",
      `${tool} ${JSON.stringify(args)}`,
    );
  }
  assert.equal(seen.length, 0);
});

test("HTTP failures answer fixed texts with no upstream body, reason or credential", async () => {
  setRetrySleepForTests(() => Promise.resolve());
  const statuses: [number, ToolCaller, string][] = [
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
    [
      404,
      tokenCaller(),
      "Confluence has no such page, space or comment, or the user can't see it.",
    ],
    [
      400,
      tokenCaller(),
      "Confluence refused the request (HTTP 400); check the CQL or filters, and resolve space keys with confluence_lookup kind=spaces.",
    ],
    [500, tokenCaller(), "Confluence answered HTTP 500."],
    [503, oauthCaller(), "Confluence answered HTTP 503."],
  ];
  const calls: [ToolName, Record<string, unknown>][] = [
    ["confluence_search", { text: "SECRETQUERY" }],
    ["confluence_get_page", { page: "101", includeComments: true }],
    ["confluence_lookup", { kind: "spaces", query: "SECRETQUERY" }],
  ];
  for (const [status, caller, message] of statuses)
    for (const [tool, args] of calls) {
      stubConfluenceFetch(() =>
        json(
          {
            message: `BODY_SENTINEL ${FAKE.token} ${BASIC}`,
            errorMessages: [`REASON_SENTINEL Bearer ${FAKE_ACCESS}`],
          },
          status,
        ),
      );
      const { host: tools, lines } = host();
      const answer = await tools.call(tool, args, caller);
      const label = `${tool} HTTP ${status}`;
      assert.deepEqual(
        answer,
        { ok: false, code: "tool_error", message },
        label,
      );
      const shown = JSON.stringify(answer);
      assert.doesNotMatch(shown, SECRETS, label);
      assert.doesNotMatch(shown, /SENTINEL|SECRETQUERY/, label);
      for (const line of lines) assert.doesNotMatch(line, SECRETS);
    }
});

test("input refusals answer fixed texts without the caller's values", async () => {
  const cases: [ToolName, Record<string, unknown>, string, number][] = [
    [
      "confluence_get_page",
      { page: "   " },
      "A Confluence page id or URL is required.",
      0,
    ],
    [
      "confluence_get_page",
      { page: "SENTINEL-PAGE" },
      "Could not read a page id; pass the numeric page id or a Confluence page URL.",
      0,
    ],
    [
      "confluence_lookup",
      { kind: "labels", page: "SENTINEL-PAGE" },
      "Could not read a page id; pass the numeric page id or a Confluence page URL.",
      0,
    ],
    [
      "confluence_search",
      { text: "deploy", updatedSince: "SENTINEL-DATE" },
      "updatedSince must be a YYYY-MM-DD date.",
      0,
    ],
    [
      "confluence_search",
      {},
      "Give at least one of text, title, label, spaceKeys or updatedSince, or pass a raw cql query.",
      0,
    ],
    [
      "confluence_lookup",
      { kind: "pageTree" },
      "kind=pageTree needs either page (children of it) or spaceKey.",
      0,
    ],
    [
      "confluence_lookup",
      { kind: "replies" },
      "kind=replies needs the commentId to read replies of.",
      0,
    ],
    [
      "confluence_lookup",
      { kind: "pageTree", spaceKey: "SENTINEL-SPACE" },
      "That Confluence space was not found, or the Atlassian account cannot see it.",
      1,
    ],
  ];
  for (const [tool, args, message, requests] of cases) {
    const seen = stubConfluenceFetch();
    const answer = await call(tool, args);
    const label = `${tool} ${JSON.stringify(args)}`;
    assert.deepEqual(answer, { ok: false, code: "tool_error", message }, label);
    assert.doesNotMatch(JSON.stringify(answer), /SENTINEL/, label);
    assert.equal(seen.length, requests, label);
  }
});

test("every request and every retry carries the call's signal", async () => {
  setRetrySleepForTests(() => Promise.resolve());
  let throttled = false;
  const seen = stubConfluenceFetch((request) => {
    if (request.path !== "/wiki/api/v2/pages/101" || throttled) return;
    throttled = true;
    return new Response("{}", { status: 429, headers: { "retry-after": "0" } });
  });
  const caller = new AbortController();
  const answer = await host().host.call(
    "confluence_get_page",
    {
      page: "101",
      includeComments: true,
      includeLabels: true,
      includeChildren: true,
      includeAttachments: true,
    },
    tokenCaller(caller.signal),
  );
  assert.deepEqual(answer, {
    ok: true,
    text: JSON.stringify(JSON.parse(baselineText("get-page-all-sections"))),
  });
  assert.equal(
    seen.filter((request) => request.path === "/wiki/api/v2/pages/101").length,
    2,
    "the 429 was retried",
  );
  assertSignals(seen);
  assert.equal(new Set(seen.map((request) => request.signal)).size, 1);
  // It is the call's own: the caller's abort reaches every one.
  caller.abort();
  for (const request of seen)
    assert.equal(request.signal!.aborted, true, request.path);
});

/** Reads held open until the call ends: a reply page, the space read. */
const HELD: [
  string,
  ToolName,
  Record<string, unknown>,
  (request: SeenConfluenceRequest) => boolean,
][] = [
  [
    "get_page's replies loop",
    "confluence_get_page",
    { page: "101", includeComments: true, includeLabels: true },
    (r) => r.path === "/wiki/api/v2/footer-comments/c2/children",
  ],
  [
    "lookup comments' replies loop",
    "confluence_lookup",
    { kind: "comments", page: "101" },
    (r) => r.path === "/wiki/api/v2/footer-comments/c2/children",
  ],
  [
    "get_page's space read",
    "confluence_get_page",
    { page: "101", includeComments: true },
    (r) => r.path === "/wiki/api/v2/spaces/900",
  ],
];

test("the deadline or the caller's abort ends every read, and nothing follows", async () => {
  for (const [what, tool, args, held] of HELD)
    for (const ending of ["deadline", "caller"] as const) {
      const label = `${what}, ${ending}`;
      const caller = new AbortController();
      const answerHeld: ConfluenceResponder = (request) => {
        if (!held(request)) return undefined;
        if (ending === "caller") setTimeout(() => caller.abort(), 0);
        return pendingUntilAbort(request);
      };
      const seen = stubConfluenceFetch(answerHeld);
      const { host: tools } = host({ deadlineMs: 200 });
      const answer = await tools.call(tool, args, tokenCaller(caller.signal));
      assert.deepEqual(
        answer,
        ending === "deadline"
          ? { ok: false, code: "timeout", message: "The tool timed out." }
          : {
              ok: false,
              code: "cancelled",
              message: "The call was cancelled.",
            },
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

test("a page above the edge's ceiling is result_too_large there and whole locally (D5)", async () => {
  const args = { page: "106", maxChars: 100_000 };
  const local = (await localDetails("confluence_get_page", args)) as {
    page: { markdown: string; truncated: boolean; charCount: number };
  };
  assert.equal(local.page.truncated, false);
  assert.equal(local.page.markdown, HUGE_TEXT);
  assert.equal(local.page.charCount, 70_000);

  stubConfluenceFetch();
  assert.deepEqual(await call("confluence_get_page", args), {
    ok: false,
    code: "result_too_large",
    message: "The tool's result is too large.",
  });
  // The default maxChars (12,000) fits.
  const fits = await call("confluence_get_page", { page: "106" });
  assert.ok(fits.ok);
  const payload = JSON.parse(fits.text) as {
    page: { truncated: boolean; charCount: number };
  };
  assert.equal(payload.page.truncated, true);
  assert.equal(payload.page.charCount, 12_000);
});
