/**
 * `jira_mutate_issue` on the edge (Task-1463 P4b2) through the tool host,
 * with a stubbed `fetch` (`test/jiraMutateFetch.ts`): one call prepares and
 * applies, sending the same requests as the shared core does for the local
 * tool, each with the call's signal; the prepare budget, the fence before
 * apply and the stop cutoff on a fake clock; D-W2 texts end to end; and a
 * result whose every string, key and link is capped and vetted for the
 * call's secret. Every value is fake.
 */
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type http from "node:http";
import { Readable } from "node:stream";
import { afterEach, test, vi } from "vitest";
import type { JiraIssueMutationItemDisplay } from "@assistant/shared/jiraMutation";
import { errorText } from "../errors.ts";
import { setRetrySleepForTests } from "../httpRetry.ts";
import {
  buildFieldMap,
  fetchJiraFields,
  fetchJiraIssueLinkTypes,
} from "../jiraFields.ts";
import {
  buildJiraMutationItems,
  type JiraMutationParams,
} from "../jiraMutate.ts";
import { applyJiraMutationItems } from "../jiraMutateApply.ts";
import { FAKE_CLOUD_ID } from "../test/atlassianFake.ts";
import {
  json,
  pendingUntilAbort,
  stubJiraFetch,
  type SeenJiraRequest,
} from "../test/jiraEdgeFetch.ts";
import {
  fakeJiraAnswer,
  isWrite,
  type FakeJiraOptions,
} from "../test/jiraMutateFetch.ts";
import { encodeAtlassianCredential, jiraConfigOf } from "./atlassian.ts";
import type {
  AtlassianCredential,
  AtlassianTokenCredential,
} from "./descriptor.ts";
import { createToolHost, type ToolCaller } from "./host.ts";
import { createEdgeTools } from "./index.ts";
import {
  PREPARE_TOO_LONG,
  RESULT_BUDGET,
  STOP_TEXT,
  projectMutationResult,
  type ProjectedResult,
} from "./jiraMutateIssue.ts";
import { EDGE_TOOLS } from "./tools.ts";
import { holdsSecret, secretForms } from "./upstreamText.ts";

const FAKE: AtlassianTokenCredential = {
  site: "acme.atlassian.net",
  email: "me@x.test",
  token: "FAKE-TOKEN-SENTINEL-0123456789",
};
const BODY_SENTINEL = "BODY-SENTINEL-raw-jira-body";
const REASON_SENTINEL = "REASON-SENTINEL summary is too long";
const WRITE_TIMEOUT =
  "The tool timed out; some changes may have been applied, so check before retrying.";
const WRITE_CANCELLED =
  "The call was cancelled; some changes may have been applied, so check before retrying.";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  setRetrySleepForTests(null);
});

function caller(
  options: {
    credential?: string;
    signal?: AbortSignal;
    credentialDelayMs?: number;
  } = {},
): ToolCaller {
  const credential = options.credential ?? encodeAtlassianCredential(FAKE);
  const outcome = { ok: true as const, credential };
  return {
    clientId: "client-1",
    credential: () =>
      options.credentialDelayMs === undefined
        ? Promise.resolve(outcome)
        : new Promise((resolve) =>
            setTimeout(() => resolve(outcome), options.credentialDelayMs),
          ),
    ...(options.signal ? { signal: options.signal } : {}),
  };
}

function oauthCredential(accessToken: string): string {
  return JSON.stringify({
    kind: "atlassian-oauth",
    site: FAKE.site,
    cloudId: FAKE_CLOUD_ID,
    accessToken,
    expiresAt: Date.now() + 600_000,
  });
}

const host = () => createToolHost(EDGE_TOOLS, { log: () => {} });

function mutate(items: unknown[], options: Parameters<typeof caller>[0] = {}) {
  return host().call("jira_mutate_issue", { items }, caller(options));
}

/** Every string in `text`'s JSON, keys included, is free of `credential`'s secret. */
function assertNoSecret(text: string, credential: AtlassianCredential): void {
  for (const form of secretForms(credential))
    assert.ok(!text.includes(form), "the serialized text holds a secret form");
  const visit = (value: unknown): void => {
    if (typeof value === "string")
      assert.ok(
        !holdsSecret(value, credential),
        `a string holds the secret: ${value.slice(0, 80)}`,
      );
    else if (Array.isArray(value)) value.forEach(visit);
    else if (value && typeof value === "object")
      for (const [key, entry] of Object.entries(value)) {
        visit(key);
        visit(entry);
      }
  };
  let parsed: unknown = text;
  try {
    parsed = JSON.parse(text);
  } catch {
    // A plain failure text: checked as one string.
  }
  visit(parsed);
}

const shapeOf = (seen: SeenJiraRequest[]) =>
  seen.map((r) => [r.method, r.path, r.query, r.body]);
const writesIn = (seen: SeenJiraRequest[]) => seen.filter(isWrite);

/** The local tool's core for the same input: no signal, its deps' shape. */
async function referenceRun(
  items: unknown[],
  options: FakeJiraOptions = {},
): Promise<{ seen: SeenJiraRequest[]; outcome: string }> {
  const seen = stubJiraFetch((request) => fakeJiraAnswer(request, options));
  const config = jiraConfigOf(FAKE);
  let map: ReturnType<typeof buildFieldMap> | undefined;
  const fieldMap = async () =>
    (map ??= buildFieldMap({
      fetchedAt: 0,
      fields: await fetchJiraFields(config),
    }));
  try {
    const prepared = await buildJiraMutationItems(
      config,
      items as NonNullable<JiraMutationParams["items"]>,
      {
        fieldMap,
        issueLinkTypes: () => fetchJiraIssueLinkTypes(config),
        describeError: errorText,
        matchesHttpStatus: (err, statuses) =>
          new RegExp(`HTTP (?:${statuses.join("|")})\\b`).test(errorText(err)),
      },
    );
    const applied = await applyJiraMutationItems(config, prepared.items, {
      fieldMap,
      describeError: errorText,
    });
    return { seen, outcome: applied.resultSummary };
  } catch (err) {
    return { seen, outcome: `refused: ${errorText(err)}` };
  } finally {
    vi.unstubAllGlobals();
  }
}

const OPERATIONS: Array<[name: string, item: Record<string, unknown>]> = [
  [
    "edit with fields",
    {
      issue: "STAR-1",
      summary: "New summary",
      description: "# Heading\n\nBody with **bold**.",
      labels: { add: ["x"], remove: ["old"] },
      fields: { "Story Points": 3 },
    },
  ],
  ["transition", { issue: "STAR-1", transitionName: "Done" }],
  [
    "link add and remove",
    {
      issue: "STAR-1",
      linkChanges: [
        { op: "add", type: "Blocks", direction: "outward", issue: "STAR-2" },
        { op: "remove", linkId: "9001" },
      ],
    },
  ],
  [
    "create with parent and description",
    {
      operation: "create",
      projectKey: "STAR",
      issueType: "Task",
      summary: "A new task",
      description: "Some *Markdown*.",
      parentIssue: "STAR-1",
    },
  ],
  [
    "comment",
    { operation: "comment", issue: "STAR-1", commentBody: "Hello **there**." },
  ],
  [
    "rank",
    {
      operation: "rank",
      rankIssues: ["STAR-2", "STAR-3"],
      rankPosition: "before",
      rankTargetIssue: "STAR-1",
    },
  ],
  ["sprint", { operation: "sprint", sprintId: 5, sprintName: "Sprint 5b" }],
];

test("one call prepares and applies each operation, sending the local core's requests with the call's signal", async () => {
  for (const [name, item] of OPERATIONS) {
    const reference = await referenceRun([item]);
    assert.ok(
      !reference.outcome.startsWith("refused"),
      `${name}: ${reference.outcome}`,
    );
    const seen = stubJiraFetch((request) => fakeJiraAnswer(request));
    const answer = await mutate([item]);
    assert.ok(answer.ok, `${name}: ${JSON.stringify(answer)}`);
    assert.deepEqual(shapeOf(seen), shapeOf(reference.seen), name);
    assert.ok(writesIn(seen).length > 0, name);
    for (const request of seen) {
      assert.ok(request.signal, `${name}: ${request.method} ${request.path}`);
      assert.equal(request.abortedAtStart, false);
    }
    for (const request of reference.seen)
      assert.equal(request.signal, undefined);
    const result = JSON.parse(answer.text) as ProjectedResult;
    assert.equal(result.items.length, 1);
    assert.equal(result.items[0]!.ok, true, name);
    assertNoSecret(answer.text, FAKE);
    vi.unstubAllGlobals();
  }
});

test("a created issue answers its key and browse link; the summary is the core's", async () => {
  stubJiraFetch((request) =>
    fakeJiraAnswer(request, { createdKey: "STAR-200" }),
  );
  const answer = await mutate([OPERATIONS[3]![1]]);
  assert.ok(answer.ok);
  assert.deepEqual(JSON.parse(answer.text), {
    summary: "Applied 1 change(s) (created STAR-200)",
    url: "https://acme.atlassian.net/browse/STAR-200",
    items: [
      {
        operation: "create",
        issueKey: "STAR-200",
        ok: true,
        url: "https://acme.atlassian.net/browse/STAR-200",
        createdKey: "STAR-200",
      },
    ],
  });
});

test("an opaque fields object is data: __proto__ pollutes nothing and is sent as the local core sends it", async () => {
  const input = JSON.parse(
    '{"items":[{"issue":"STAR-1","fields":{"__proto__":{"x":1},"customfield_1":"a"}}]}',
  ) as { items: unknown[] };
  // Unresolvable as a field name: refused before any write, as locally.
  const refused = await referenceRun(input.items);
  assert.match(
    refused.outcome,
    /^refused: Could not resolve Jira field\(s\): __proto__/,
  );
  let seen = stubJiraFetch((request) => fakeJiraAnswer(request));
  const answer = await host().call("jira_mutate_issue", input, caller());
  assert.deepEqual(answer, {
    ok: false,
    code: "tool_error",
    message:
      "Could not resolve Jira field(s): __proto__ Nothing was written to Jira.",
  });
  assert.equal(writesIn(seen).length, 0);
  vi.unstubAllGlobals();
  // A field Jira names "__proto__": the same PUT body as the local core's.
  const options = {
    extraFields: [{ id: "customfield_9", name: "__proto__", custom: true }],
  };
  const reference = await referenceRun(input.items, options);
  seen = stubJiraFetch((request) => fakeJiraAnswer(request, options));
  const applied = await host().call("jira_mutate_issue", input, caller());
  assert.ok(applied.ok);
  const put = writesIn(seen);
  assert.deepEqual(shapeOf(put), shapeOf(writesIn(reference.seen)));
  assert.deepEqual(put[0]!.body, {
    fields: { customfield_9: { x: 1 }, customfield_1: "a" },
    update: {},
  });
  assert.equal(({} as Record<string, unknown>).x, undefined);
  assert.equal(Object.getPrototypeOf({}), Object.prototype);
});

test("a transition id Jira does not offer is refused in prepare, before any write (live step 4's fixture)", async () => {
  const seen = stubJiraFetch((request) => fakeJiraAnswer(request));
  const answer = await mutate([{ issue: "STAR-1", transitionId: "999999999" }]);
  assert.ok(!answer.ok && answer.code === "tool_error");
  assert.ok(
    answer.message.startsWith(
      "Requested transition is not available for STAR-1.",
    ),
    answer.message,
  );
  assert.ok(answer.message.endsWith(" Nothing was written to Jira."));
  assert.equal(writesIn(seen).length, 0);
  assertNoSecret(answer.message, FAKE);
});

test("D-W2 end to end: a write's 400 shows Jira's reasons, never its body or the credential, for each operation", async () => {
  const rejected = new Response(
    JSON.stringify({
      errorMessages: [REASON_SENTINEL],
      x: `${BODY_SENTINEL} ${FAKE.token}`,
    }),
    { status: 400 },
  );
  for (const [name, item] of OPERATIONS) {
    stubJiraFetch((request) =>
      isWrite(request) ? rejected.clone() : fakeJiraAnswer(request),
    );
    const answer = await mutate([item]);
    assert.ok(!answer.ok && answer.code === "tool_error", name);
    assert.ok(
      answer.message.includes(REASON_SENTINEL),
      `${name}: ${answer.message}`,
    );
    assert.ok(answer.message.startsWith("All 1 Jira change(s) failed: "), name);
    assert.ok(!answer.message.includes(BODY_SENTINEL), name);
    assertNoSecret(answer.message, FAKE);
    vi.unstubAllGlobals();
  }
});

/** Lets real I/O (fetch bodies) run between fake-timer steps. */
async function flush(): Promise<void> {
  for (let i = 0; i < 10; i += 1)
    await new Promise((resolve) => setImmediate(resolve));
}

/** Advances the fake clock in steps, letting I/O settle in between. */
async function advance(ms: number, step = 250): Promise<void> {
  for (let passed = 0; passed < ms; passed += step) {
    await vi.advanceTimersByTimeAsync(Math.min(step, ms - passed));
    await flush();
  }
}

function fakeClock(): number {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  vi.setSystemTime(1_800_000_000_000);
  return Date.now();
}

const after = (ms: number, answer: () => Response): Promise<Response> =>
  new Promise((resolve) => setTimeout(() => resolve(answer()), ms));

/** Runs one call to its end on the fake clock; answers it and when it ended. */
async function run(
  items: unknown[],
  options: Parameters<typeof caller>[0] = {},
  maxMs = 60_000,
) {
  const started = Date.now();
  let endedAt: number | undefined;
  const pending = mutate(items, options).then((answer) => {
    endedAt = Date.now() - started;
    return answer;
  });
  for (let passed = 0; passed < maxMs && endedAt === undefined; passed += 250)
    await advance(250);
  return { answer: await pending, endedAt: endedAt ?? Number.NaN };
}

const EDIT = { issue: "STAR-1", summary: "New summary" };
const COMMENT = { operation: "comment", issue: "STAR-1", commentBody: "Hi" };
const RANK_TOP = {
  operation: "rank",
  rankIssues: ["STAR-2"],
  rankPosition: "top",
  rankBoardId: 7,
};

test("prepare budget (a-c): a read that hangs until its signal aborts gives PREPARE_TOO_LONG at the budget, with no write", async () => {
  const cases: Array<[item: object, hangs: (r: SeenJiraRequest) => boolean]> = [
    [EDIT, (r) => r.path === "/rest/api/3/issue/STAR-1"],
    [COMMENT, (r) => r.path === "/rest/api/3/mypermissions"],
    [RANK_TOP, (r) => r.path === "/rest/agile/1.0/board/7/project"],
  ];
  for (const [item, hangs] of cases) {
    fakeClock();
    let hung: SeenJiraRequest | undefined;
    const seen = stubJiraFetch((request) => {
      if (!hangs(request)) return fakeJiraAnswer(request);
      hung = request;
      return pendingUntilAbort(request);
    });
    const { answer, endedAt } = await run([item]);
    assert.deepEqual(answer, {
      ok: false,
      code: "tool_error",
      message: PREPARE_TOO_LONG,
    });
    // 45 s less the 22 s reserve; the fake clock steps by 250 ms.
    assert.ok(endedAt >= 23_000 && endedAt <= 23_250, String(endedAt));
    assert.equal(hung?.signal?.aborted, true);
    assert.equal(writesIn(seen).length, 0);
    vi.unstubAllGlobals();
    vi.useRealTimers();
  }
});

test("prepare budget (d): a read that ignores its signal and answers late still gives PREPARE_TOO_LONG; nothing follows it", async () => {
  fakeClock();
  const seen = stubJiraFetch((request) =>
    request.path === "/rest/api/3/issue/STAR-1"
      ? after(30_000, () => fakeJiraAnswer(request))
      : fakeJiraAnswer(request),
  );
  const { answer, endedAt } = await run([EDIT]);
  assert.deepEqual(answer, {
    ok: false,
    code: "tool_error",
    message: PREPARE_TOO_LONG,
  });
  assert.ok(endedAt <= 23_250);
  const count = seen.length;
  await advance(30_000);
  assert.equal(seen.length, count, "no request after the late settlement");
  assert.equal(writesIn(seen).length, 0);
});

test("prepare budget (e): a credential read past the budget gives PREPARE_TOO_LONG with no Jira request", async () => {
  fakeClock();
  const seen = stubJiraFetch((request) => fakeJiraAnswer(request));
  const { answer } = await run([EDIT], { credentialDelayMs: 23_001 });
  assert.deepEqual(answer, {
    ok: false,
    code: "tool_error",
    message: PREPARE_TOO_LONG,
  });
  assert.equal(seen.length, 0);
});

test("prepare budget (f): a caller abort during prepare is the host's cancel, not PREPARE_TOO_LONG", async () => {
  fakeClock();
  const controller = new AbortController();
  const seen = stubJiraFetch((request) =>
    request.path === "/rest/api/3/issue/STAR-1"
      ? pendingUntilAbort(request)
      : fakeJiraAnswer(request),
  );
  setTimeout(() => controller.abort(), 1_000);
  const { answer, endedAt } = await run([EDIT], { signal: controller.signal });
  assert.deepEqual(answer, {
    ok: false,
    code: "cancelled",
    message: WRITE_CANCELLED,
  });
  assert.ok(endedAt <= 1_250);
  assert.equal(writesIn(seen).length, 0);
});

test("prepare budget (g): prepare settling in the same timer turn the budget fires never writes", async () => {
  const start = fakeClock();
  // The issue read answers at the budget instant itself, in the turn its
  // timer fires.
  const seen = stubJiraFetch((request) =>
    request.path === "/rest/api/3/issue/STAR-1"
      ? after(start + 23_000 - Date.now(), () => fakeJiraAnswer(request))
      : fakeJiraAnswer(request),
  );
  const { answer } = await run([EDIT]);
  assert.deepEqual(answer, {
    ok: false,
    code: "tool_error",
    message: PREPARE_TOO_LONG,
  });
  assert.equal(writesIn(seen).length, 0);
});

test("prepare budget (h): once prepare is over, an apply write's 400 is D-W2's text even past the old budget", async () => {
  fakeClock();
  const seen = stubJiraFetch((request) =>
    request.method === "PUT"
      ? after(30_000, () =>
          json({ errorMessages: [REASON_SENTINEL], x: BODY_SENTINEL }, 400),
        )
      : fakeJiraAnswer(request),
  );
  const { answer, endedAt } = await run([EDIT]);
  assert.ok(endedAt >= 30_000);
  assert.deepEqual(answer, {
    ok: false,
    code: "tool_error",
    message: `All 1 Jira change(s) failed: Jira refused the change (HTTP 400): ${REASON_SENTINEL}`,
  });
  assert.equal(writesIn(seen).length, 1);
});

test("prepare budget (i): the fence refuses a prepare that resolves after the budget instant before its timer runs", async () => {
  const start = fakeClock();
  let release: () => void = () => {};
  const seen = stubJiraFetch((request) =>
    request.path === "/rest/api/3/issue/STAR-1"
      ? new Promise<Response>((resolve) => {
          release = () => resolve(fakeJiraAnswer(request));
        })
      : fakeJiraAnswer(request),
  );
  const pending = mutate([EDIT]);
  await flush();
  // The clock moves to the budget instant; no timer callback runs.
  vi.setSystemTime(start + 23_000);
  release();
  await flush();
  assert.deepEqual(await pending, {
    ok: false,
    code: "tool_error",
    message: PREPARE_TOO_LONG,
  });
  assert.equal(writesIn(seen).length, 0);
});

test("stop cutoff: a slow first item leaves the rest not applied, keeping its own result", async () => {
  fakeClock();
  let comments = 0;
  const seen = stubJiraFetch((request) =>
    request.path.endsWith("/comment") && (comments += 1) === 1
      ? after(39_000, () => json({ id: "1" }, 201))
      : fakeJiraAnswer(request),
  );
  const items = ["STAR-1", "STAR-2", "STAR-3"].map((issue) => ({
    ...COMMENT,
    issue,
  }));
  const { answer } = await run(items);
  assert.ok(answer.ok, JSON.stringify(answer));
  const result = JSON.parse(answer.text) as ProjectedResult;
  assert.deepEqual(
    result.items.map((item) => [item.issueKey, item.ok, item.error]),
    [
      ["STAR-1", true, undefined],
      ["STAR-2", false, STOP_TEXT],
      ["STAR-3", false, STOP_TEXT],
    ],
  );
  assert.equal(writesIn(seen).length, 1);
});

test("a hard timeout during item 1 is the write timeout text, and no request starts after it", async () => {
  fakeClock();
  const seen = stubJiraFetch((request) =>
    request.path.endsWith("/comment")
      ? pendingUntilAbort(request)
      : fakeJiraAnswer(request),
  );
  const items = ["STAR-1", "STAR-2"].map((issue) => ({ ...COMMENT, issue }));
  const { answer, endedAt } = await run(items);
  assert.deepEqual(answer, {
    ok: false,
    code: "timeout",
    message: WRITE_TIMEOUT,
  });
  assert.ok(endedAt >= 45_000 && endedAt <= 45_250);
  const count = seen.length;
  await advance(10_000);
  assert.equal(seen.length, count);
  assert.equal(writesIn(seen).length, 1);
});

// --- Result projection (AC7, A1) ---

const MAX_KEY = `${"A".repeat(55)}-12345678`;
const MAX_URL = (() => {
  const base = `https://${FAKE.site}/browse/${MAX_KEY}?`;
  return base + "a".repeat(300 - base.length);
})();

function item(
  overrides: Partial<JiraIssueMutationItemDisplay> = {},
): JiraIssueMutationItemDisplay {
  return {
    clientId: "item-1",
    issueKey: "STAR-1",
    operation: "edit",
    fieldChanges: [],
    resultIssueUrl: `https://${FAKE.site}/browse/STAR-1`,
    ...overrides,
  };
}

test("AC7 (a): a maximal result stays under the budget without shrinking, and round-trips", () => {
  const hostile = (n: number) => `\ud800${'"\\'.repeat(n)}`;
  const items = Array.from({ length: 10 }, (_, index) =>
    item({
      clientId: `item-${index + 1}`,
      operation: "create",
      issueKey: MAX_KEY,
      resultIssueKey: MAX_KEY,
      resultIssueUrl: MAX_URL,
      error: hostile(600),
      warning: hostile(400),
    }),
  );
  const result = projectMutationResult(
    {
      items,
      warnings: Array.from({ length: 25 }, () => hostile(300)),
      succeeded: 0,
      resultSummary: '"'.repeat(5_000),
      resultUrl: MAX_URL,
    },
    FAKE,
  );
  const text = JSON.stringify(result);
  assert.ok(text.length <= RESULT_BUDGET, String(text.length));
  assert.ok(text.length > 45_000, "the fixture is near its computed bound");
  // Nothing was shrunk.
  assert.equal(result.summary.length, 4_000);
  assert.equal(result.warnings?.length, 21);
  assert.equal(result.warnings?.at(-1), "5 more warning(s) omitted.");
  for (const row of result.items) {
    assert.equal(row.url, MAX_URL);
    assert.equal(row.createdKey, MAX_KEY);
    assert.equal(row.error?.length, 800);
    assert.equal(row.warning?.length, 500);
  }
  assert.equal(result.url, MAX_URL);
  assert.deepEqual(JSON.parse(text), result);
  assert.doesNotMatch(text, /\\ud[89ab]/i, "no lone surrogate is escaped");
  assertNoSecret(text, FAKE);
});

test("AC7 (b): invalid keys project as null; links off the site, too long or with unsafe characters are omitted", () => {
  const keys = [`${"A".repeat(60)}-12345`, "star-1", 'STAR-1"', "STAR-01", ""];
  const result = projectMutationResult(
    {
      items: [
        ...keys.map((key) =>
          item({ operation: "create", issueKey: key, resultIssueKey: key }),
        ),
        ...[
          "https://other.atlassian.net/browse/STAR-1",
          "https://acme.atlassian.net.evil.test/browse/STAR-1",
          "http://acme.atlassian.net/browse/STAR-1",
          `https://acme.atlassian.net/browse/STAR-1?${"a".repeat(260)}`,
          'https://acme.atlassian.net/browse/STAR-1?"x',
          "https://acme.atlassian.net/browse/STAR-1?\\x",
          "https://acme.atlassian.net/browse/STAR 1",
          "https://acme.atlassian.net/browse/STAR-1\u0001",
          "https://acme.atlassian.net/browse/STAR-1%E0%A4%A",
        ].map((url) => item({ resultIssueUrl: url })),
        item(),
      ],
      warnings: [],
      succeeded: 15,
      resultSummary: "Applied 15 change(s)",
      resultUrl: "https://other.atlassian.net/browse/STAR-1",
    },
    FAKE,
  );
  const rows = result.items;
  for (const row of rows.slice(0, keys.length)) {
    assert.equal(row.issueKey, null);
    assert.equal(row.createdKey, undefined);
    assert.equal(row.url, undefined);
  }
  for (const row of rows.slice(keys.length, -1)) {
    assert.equal(row.issueKey, "STAR-1");
    assert.equal(row.url, undefined);
  }
  assert.equal(rows.at(-1)!.url, "https://acme.atlassian.net/browse/STAR-1");
  assert.equal(result.url, undefined);
  assertNoSecret(JSON.stringify(result), FAKE);
});

test("AC7 (c): the shrink guard steps in order and keeps every row's outcome", () => {
  const applied = {
    items: Array.from({ length: 3 }, (_, index) =>
      item({
        clientId: `item-${index + 1}`,
        operation: "create",
        issueKey: `STAR-${index + 1}`,
        resultIssueKey: `STAR-${index + 1}`,
        resultIssueUrl: `https://${FAKE.site}/browse/STAR-${index + 1}`,
        error: "e".repeat(700),
        warning: "w".repeat(400),
      }),
    ),
    warnings: ["first warning", "second warning"],
    succeeded: 1,
    resultSummary: "s".repeat(3_000),
    resultUrl: `https://${FAKE.site}/browse/STAR-1`,
  };
  const size = (result: ProjectedResult) => JSON.stringify(result).length;
  const full = projectMutationResult(applied, FAKE);
  const outcomes = (result: ProjectedResult) =>
    result.items.map((row) => [
      row.operation,
      row.issueKey,
      row.ok,
      row.createdKey,
    ]);

  const step1 = projectMutationResult(applied, FAKE, size(full) - 1);
  assert.deepEqual(step1.warnings, ["2 warning(s) omitted."]);
  assert.equal(step1.items[0]!.error!.length, 700);
  assert.equal(step1.summary.length, 3_000);

  const step2 = projectMutationResult(applied, FAKE, size(step1) - 1);
  assert.equal(step2.items[0]!.error!.length, 200);
  assert.equal(step2.items[0]!.warning!.length, 200);
  assert.equal(step2.summary.length, 3_000);

  const step3 = projectMutationResult(applied, FAKE, size(step2) - 1);
  assert.equal(step3.summary, "Applied 1 change(s); 2 failed.");
  assert.ok(step3.items.every((row) => row.url !== undefined));

  const step4 = projectMutationResult(applied, FAKE, size(step3) - 1);
  assert.equal(step4.url, undefined);
  assert.ok(step4.items.every((row) => row.url === undefined));

  const floor = projectMutationResult(applied, FAKE, 1);
  assert.deepEqual(floor, step4);
  for (const shrunk of [step1, step2, step3, step4])
    assert.deepEqual(outcomes(shrunk), outcomes(full));
  assert.deepEqual(outcomes(full), [
    ["create", "STAR-1", false, "STAR-1"],
    ["create", "STAR-2", false, "STAR-2"],
    ["create", "STAR-3", false, "STAR-3"],
  ]);
});

test("AC7 (d): a real 10 × 50 rank batch and a 10-sprint batch stay under the budget", async () => {
  stubJiraFetch((request) => fakeJiraAnswer(request));
  const ranks = Array.from({ length: 10 }, (_, index) => ({
    operation: "rank",
    rankIssues: Array.from(
      { length: 50 },
      (_, issue) => `STAR-${index * 100 + issue + 1}`,
    ),
    rankPosition: "before",
    rankTargetIssue: `STAR-${index * 100 + 99}`,
  }));
  const ranked = await mutate(ranks);
  assert.ok(ranked.ok, JSON.stringify(ranked).slice(0, 300));
  assert.ok(ranked.text.length <= RESULT_BUDGET);
  const rankResult = JSON.parse(ranked.text) as ProjectedResult;
  assert.equal(
    rankResult.summary.length,
    4_000,
    "the order diagnostics are capped",
  );
  assert.ok(rankResult.items.every((row) => row.ok));
  assertNoSecret(ranked.text, FAKE);

  const sprints = Array.from({ length: 10 }, (_, index) => ({
    operation: "sprint",
    sprintId: 10 + index,
    sprintName: `Sprint ${index} ${"n".repeat(20)}`,
    sprintStartDate: "2026-12-01T09:00:00+01:00",
    sprintEndDate: "2026-12-12T17:00:00+01:00",
    sprintGoal: "g".repeat(200),
  }));
  const edited = await mutate(sprints);
  assert.ok(edited.ok, JSON.stringify(edited).slice(0, 300));
  assert.ok(edited.text.length <= RESULT_BUDGET);
  const sprintResult = JSON.parse(edited.text) as ProjectedResult;
  assert.match(
    sprintResult.summary,
    /^Applied 10 change\(s\); Sprint 0 n+ now 2026-12-01T08:00:00\.000Z/,
  );
  // A sprint item has no issue key, so its link is never shown (A1).
  assert.ok(
    sprintResult.items.every(
      (row) => row.issueKey === null && row.url === undefined,
    ),
  );
  assertNoSecret(edited.text, FAKE);
});

test("A1 (i): a created key equal to the API token is never shown, nor its link", async () => {
  const credential = { ...FAKE, token: "TOKENKEY-123456" };
  stubJiraFetch((request) =>
    fakeJiraAnswer(request, { createdKey: "TOKENKEY-123456" }),
  );
  const answer = await mutate([OPERATIONS[3]![1]], {
    credential: encodeAtlassianCredential(credential),
  });
  assert.ok(answer.ok);
  const result = JSON.parse(answer.text) as ProjectedResult;
  assert.deepEqual(result, {
    summary: "Applied 1 change(s); 0 failed.",
    items: [{ operation: "create", issueKey: null, ok: true }],
  });
  assert.ok(!answer.text.includes("TOKENKEY-123456"));
  assertNoSecret(answer.text, credential);
});

test("A1 (ii): the same for an OAuth access token shaped like a key", async () => {
  const accessToken = "OAUTHKEY-98765432";
  stubJiraFetch((request) =>
    fakeJiraAnswer(request, { createdKey: accessToken }),
  );
  const answer = await mutate([OPERATIONS[3]![1]], {
    credential: oauthCredential(accessToken),
  });
  assert.ok(answer.ok);
  assert.deepEqual(JSON.parse(answer.text), {
    summary: "Applied 1 change(s); 0 failed.",
    items: [{ operation: "create", issueKey: null, ok: true }],
  });
  assertNoSecret(answer.text, {
    site: FAKE.site,
    cloudId: FAKE_CLOUD_ID,
    accessToken,
  });
});

test("A1 (iv): a key that is a 16-character slice of the token is dropped; an ordinary key is kept with its link", async () => {
  const credential = { ...FAKE, token: "zzSLICEKEY-1234567890zz" };
  const slice = "SLICEKEY-1234567";
  assert.equal(slice.length, 16);
  assert.ok(credential.token.includes(slice));
  stubJiraFetch((request) =>
    fakeJiraAnswer(request, {
      keyOf: (requested) => (requested === "STAR-7" ? slice : requested),
    }),
  );
  const answer = await mutate(
    [
      { issue: "STAR-7", summary: "One" },
      { issue: "STAR-135", summary: "Two" },
    ],
    { credential: encodeAtlassianCredential(credential) },
  );
  assert.ok(answer.ok);
  const result = JSON.parse(answer.text) as ProjectedResult;
  assert.deepEqual(result.items, [
    { operation: "edit", issueKey: null, ok: true },
    {
      operation: "edit",
      issueKey: "STAR-135",
      ok: true,
      url: "https://acme.atlassian.net/browse/STAR-135",
    },
  ]);
  // The root link is the first item's, whose key failed.
  assert.equal(result.url, undefined);
  assertNoSecret(answer.text, credential);
});

// --- MCP exchange bound (AC12) ---

/** A response the MCP handler writes to; settles when it ends. */
class FakeResponse extends EventEmitter {
  headersSent = false;
  destroyed = false;
  writableFinished = false;
  status = 0;
  readonly done: Promise<{ status: number; body: string }>;
  private settle: (value: { status: number; body: string }) => void = () => {};
  constructor() {
    super();
    this.done = new Promise((resolve) => (this.settle = resolve));
  }
  writeHead(status: number): this {
    this.status = status;
    this.headersSent = true;
    return this;
  }
  end(body: string = ""): this {
    this.writableFinished = true;
    this.emit("finish");
    this.emit("close");
    this.settle({ status: this.status, body });
    return this;
  }
  destroy(): this {
    this.destroyed = true;
    this.emit("close");
    this.settle({ status: 0, body: "" });
    return this;
  }
}

function mcpCall(options: { deadlineMs: number; lifecycleMs?: number }) {
  const edge = createEdgeTools({ ...options, log: () => {} });
  const req = Object.assign(
    Readable.from([
      Buffer.from(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: {
            name: "jira_mutate_issue",
            arguments: { items: [COMMENT] },
          },
        }),
      ),
    ]),
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-protocol-version": "2025-06-18",
      },
    },
  );
  const res = new FakeResponse();
  edge.handleMcp(
    req as unknown as http.IncomingMessage,
    res as unknown as http.ServerResponse,
    {
      clientId: "client-1",
      credential: () =>
        Promise.resolve({
          ok: true,
          credential: encodeAtlassianCredential(FAKE),
        }),
    },
  );
  return res.done;
}

test("AC12: /mcp lets a write run past the host deadline plus margin; an explicit lifecycle bound still ends it", async () => {
  fakeClock();
  const slowComment = (request: SeenJiraRequest) =>
    request.path.endsWith("/comment")
      ? after(6_500, () => json({ id: "1" }, 201))
      : fakeJiraAnswer(request);
  stubJiraFetch(slowComment);
  // The old bound was 1,000 + 5,000 ms; the write answers at 6,500 ms.
  const pending = mcpCall({ deadlineMs: 1_000 });
  await advance(7_000);
  const answer = await pending;
  assert.equal(answer.status, 200);
  const body = JSON.parse(answer.body) as {
    result: { content: Array<{ text: string }>; isError?: boolean };
  };
  assert.equal(body.result.isError, undefined);
  assert.equal(
    (JSON.parse(body.result.content[0]!.text) as ProjectedResult).items[0]!.ok,
    true,
  );

  const started = Date.now();
  const bounded = mcpCall({ deadlineMs: 1_000, lifecycleMs: 2_000 });
  let endedAt: number | undefined;
  void bounded.then(() => (endedAt = Date.now() - started));
  await advance(7_000);
  const cut = await bounded;
  assert.equal(cut.status, 504);
  assert.ok(
    endedAt !== undefined && endedAt >= 2_000 && endedAt <= 2_250,
    String(endedAt),
  );
});
