/**
 * `confluence_mutate_page` on the edge (Task-1463 P5b) through the tool host,
 * with a stubbed `fetch` acting as the site (`test/confluenceMutateFetch.ts`):
 * the operation gate before the credential, the delete switch from the
 * requested scope list, one call that sends what the shared core sends for
 * the local tool, the shared runner's budget, fence and stop cutoff on a fake
 * clock, trash only behind P5a's positive-status guard, D-W2 texts end to
 * end, and a result whose every string, id and link is capped and vetted for
 * the call's secret. Every value is fake.
 */
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import http from "node:http";
import { Readable } from "node:stream";
import { afterEach, test, vi } from "vitest";
import type { ConfluencePageMutationItemDisplay } from "@assistant/shared/confluenceMutation";
import { buildConfluenceMutationItems } from "../confluenceMutate.ts";
import { applyConfluenceMutationItems } from "../confluenceMutateApply.ts";
import { errorText } from "../errors.ts";
import { setRetrySleepForTests } from "../httpRetry.ts";
import { FAKE_CLOUD_ID } from "../test/atlassianFake.ts";
import {
  PAGE_ADF,
  attachmentRow,
  fakeConfluenceAnswer,
  isWrite,
  json,
  stubConfluenceWriteFetch,
  type FakeConfluenceOptions,
  type SeenConfluenceWrite,
} from "../test/confluenceMutateFetch.ts";
import { assertNoCredential, oracleForms } from "../test/credentialOracle.ts";
import { confluenceConfigOf, encodeAtlassianCredential } from "./atlassian.ts";
import {
  ATTACHMENT_DELETE_OFF,
  CONFLUENCE_RESULT_WITHHELD,
  PAGE_DELETE_OFF,
  PREPARE_TOO_LONG_CONFLUENCE,
  UPLOAD_UNAVAILABLE,
  confluenceDeleteSwitchFor,
  projectConfluenceResult,
  type ProjectedConfluenceResult,
} from "./confluenceMutatePage.ts";
import type {
  AtlassianCredential,
  AtlassianTokenCredential,
} from "./descriptor.ts";
import type { ToolCaller } from "./host.ts";
import { createEdgeTools } from "./index.ts";
import { REDACTED } from "./upstreamText.ts";
import { STOP_TEXT } from "./writeCall.ts";
import { RESULT_BUDGET } from "./writeResult.ts";

const FAKE: AtlassianTokenCredential = {
  site: "acme.atlassian.net",
  email: "me@x.test",
  token: "FAKE-TOKEN-SENTINEL-0123456789",
};
const BOTH = ["delete:page:confluence", "delete:attachment:confluence"];
const BODY_SENTINEL = "BODY-SENTINEL-raw-confluence-body";
const REASON_SENTINEL = "REASON-SENTINEL title is too long";
const WRITE_TIMEOUT =
  "The tool timed out; some changes may have been applied, so check before retrying.";
const WRITE_CANCELLED =
  "The call was cancelled; some changes may have been applied, so check before retrying.";
const NOTHING_WRITTEN = " Nothing was written to Confluence.";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  setRetrySleepForTests(null);
});

interface CallOptions {
  credential?: AtlassianCredential;
  signal?: AbortSignal;
  credentialDelayMs?: number;
  /** The requested scope list; `null` passes none. Default: both deletes. */
  scopes?: readonly string[] | null;
}

/** The vault's answer for `credential`: a token, or an OAuth access view. */
function encoded(credential: AtlassianCredential): string {
  return "accessToken" in credential
    ? JSON.stringify({ kind: "atlassian-oauth", ...credential })
    : encodeAtlassianCredential(credential);
}

/** A caller whose credential reads are counted. */
function caller(options: CallOptions = {}): ToolCaller & { reads: number } {
  const outcome = {
    ok: true as const,
    credential: encoded(options.credential ?? FAKE),
  };
  const counted = {
    reads: 0,
    clientId: "client-1",
    credential: () => {
      counted.reads += 1;
      return options.credentialDelayMs === undefined
        ? Promise.resolve(outcome)
        : new Promise<typeof outcome>((resolve) =>
            setTimeout(() => resolve(outcome), options.credentialDelayMs),
          );
    },
    ...(options.signal ? { signal: options.signal } : {}),
  };
  return counted;
}

/**
 * One call through a fresh edge host, with the credential oracle on its
 * answer (fix-2): the text or message holds none of the credential's forms.
 */
async function mutate(items: unknown[], options: CallOptions = {}) {
  const scopes = options.scopes === undefined ? BOTH : options.scopes;
  const edge = createEdgeTools({
    log: () => {},
    ...(scopes === null ? {} : { atlassianScopes: scopes }),
  });
  const who = caller(options);
  const answer = await edge.host.call("confluence_mutate_page", { items }, who);
  assertNoCredential(
    answer.ok ? answer.text : answer.message,
    options.credential ?? FAKE,
  );
  return Object.assign(answer, { credentialReads: who.reads });
}

/** A successful answer's text. */
const textOf = (answer: Awaited<ReturnType<typeof mutate>>): string => {
  assert.ok(answer.ok, JSON.stringify(answer));
  return answer.ok ? answer.text : "";
};
const resultOf = (answer: Awaited<ReturnType<typeof mutate>>) =>
  JSON.parse(textOf(answer)) as ProjectedConfluenceResult;
const shapeOf = (seen: SeenConfluenceWrite[]) =>
  seen.map((r) => [r.method, r.path, r.query, r.body]);
const writesIn = (seen: SeenConfluenceWrite[]) => seen.filter(isWrite);
const deletesIn = (seen: SeenConfluenceWrite[]) =>
  seen.filter((r) => r.method === "DELETE");

const EDIT = { page: "123", body: "Added" };
const COMMENT = { operation: "comment", page: "123", body: "Note" };
const DELETE_PAGE = { operation: "delete", page: "123" };
const DELETE_ATTACHMENT = {
  operation: "deleteAttachment",
  attachmentId: "att1",
};
const UPLOAD = {
  operation: "uploadAttachment",
  page: "123",
  sourcePath: "/tmp/x.png",
};

// --- AC4: the operation gate, before the credential ---

test("AC4: each gate refusal answers its text with no credential read and no request", async () => {
  const cases: Array<[unknown[], readonly string[], string]> = [
    [[UPLOAD], BOTH, UPLOAD_UNAVAILABLE],
    [[DELETE_PAGE], ["delete:attachment:confluence"], PAGE_DELETE_OFF],
    [[DELETE_ATTACHMENT], ["delete:page:confluence"], ATTACHMENT_DELETE_OFF],
  ];
  for (const [items, scopes, message] of cases) {
    const seen = stubConfluenceWriteFetch();
    const answer = await mutate(items, { scopes });
    assert.equal(answer.ok, false);
    assert.equal(answer.ok ? "" : answer.code, "tool_error");
    assert.equal(answer.ok ? "" : answer.message, message);
    assert.equal(answer.credentialReads, 0, message);
    assert.equal(seen.length, 0, message);
    vi.unstubAllGlobals();
  }
});

test("AC4: a mixed batch is refused whole when one item is off, and proceeds when both switches are on", async () => {
  let seen = stubConfluenceWriteFetch();
  const refused = await mutate([EDIT, DELETE_PAGE], { scopes: [] });
  assert.deepEqual(
    [refused.ok, refused.ok ? "" : refused.message, refused.credentialReads],
    [false, PAGE_DELETE_OFF, 0],
  );
  assert.equal(seen.length, 0);
  vi.unstubAllGlobals();

  seen = stubConfluenceWriteFetch();
  const result = resultOf(await mutate([EDIT, DELETE_PAGE], { scopes: BOTH }));
  assert.deepEqual(
    result.items.map((row) => [row.operation, row.ok]),
    [
      ["edit", true],
      ["delete", true],
    ],
  );
  assert.equal(deletesIn(seen).length, 1);
});

test("AC4: an upload is refused whatever the switches, and the first offending item in input order decides", async () => {
  const seen = stubConfluenceWriteFetch();
  for (const scopes of [[], ["delete:page:confluence"], BOTH, null]) {
    const answer = await mutate([EDIT, UPLOAD], { scopes });
    assert.equal(answer.ok ? "" : answer.message, UPLOAD_UNAVAILABLE);
  }
  const first = await mutate([DELETE_ATTACHMENT, DELETE_PAGE, UPLOAD], {
    scopes: [],
  });
  assert.equal(first.ok ? "" : first.message, ATTACHMENT_DELETE_OFF);
  // `operation` absent is edit, which no switch gates.
  const edit = await mutate([{ page: "123", newTitle: "Renamed" }], {
    scopes: [],
  });
  assert.ok(edit.ok);
  assert.equal(seen.filter((r) => r.method === "PUT").length, 1);
});

// --- AC5: the switch, from the requested scope list ---

test("AC5: the switch takes each delete's exact scope; no list, or a wrong case, is off", () => {
  assert.deepEqual(confluenceDeleteSwitchFor(undefined), {
    page: false,
    attachment: false,
  });
  assert.deepEqual(confluenceDeleteSwitchFor([]), {
    page: false,
    attachment: false,
  });
  assert.deepEqual(confluenceDeleteSwitchFor(["delete:page:confluence"]), {
    page: true,
    attachment: false,
  });
  assert.deepEqual(
    confluenceDeleteSwitchFor(["delete:attachment:confluence"]),
    { page: false, attachment: true },
  );
  assert.deepEqual(confluenceDeleteSwitchFor(BOTH), {
    page: true,
    attachment: true,
  });
  assert.deepEqual(
    confluenceDeleteSwitchFor([
      "Delete:page:confluence",
      "delete:attachment:Confluence",
      "delete:page:confluence ",
      "write:page:confluence",
    ]),
    { page: false, attachment: false },
  );
});

test("AC5: createEdgeTools without scopes fails closed; a page-only list lets a page delete through and refuses an attachment delete", async () => {
  const seen = stubConfluenceWriteFetch();
  const page = await mutate([DELETE_PAGE], { scopes: null });
  assert.equal(page.ok ? "" : page.message, PAGE_DELETE_OFF);
  const attachment = await mutate([DELETE_ATTACHMENT], { scopes: null });
  assert.equal(attachment.ok ? "" : attachment.message, ATTACHMENT_DELETE_OFF);
  assert.equal(seen.length, 0);

  const pageOnly = ["read:page:confluence", "delete:page:confluence"];
  assert.ok((await mutate([DELETE_PAGE], { scopes: pageOnly })).ok);
  const refused = await mutate([DELETE_ATTACHMENT], { scopes: pageOnly });
  assert.equal(refused.ok ? "" : refused.message, ATTACHMENT_DELETE_OFF);
  assert.deepEqual(
    deletesIn(seen).map((r) => r.path),
    ["/wiki/api/v2/pages/123"],
  );
});

// --- AC6: one call, the same requests as the local tool's core ---

/** The local tool's core for the same input: no signal, its deps' shape. */
async function referenceRun(
  items: unknown[],
  options: FakeConfluenceOptions = {},
): Promise<SeenConfluenceWrite[]> {
  const seen = stubConfluenceWriteFetch(undefined, options);
  const config = confluenceConfigOf(FAKE);
  try {
    const prepared = await buildConfluenceMutationItems(
      config,
      items as Parameters<typeof buildConfluenceMutationItems>[1],
      {},
    );
    await applyConfluenceMutationItems(config, prepared.items, {
      describeError: errorText,
    });
  } finally {
    vi.unstubAllGlobals();
  }
  return seen;
}

const OPERATIONS: Array<[name: string, item: Record<string, unknown>]> = [
  [
    "create with a parent and labels",
    {
      operation: "create",
      spaceKey: "ENG",
      title: "New page",
      parentPage: "123",
      body: "Hello",
      addLabels: ["a", "b"],
    },
  ],
  [
    "edit append with labels",
    { ...EDIT, addLabels: ["x"], removeLabels: ["y"] },
  ],
  ["edit replace", { page: "123", body: "Whole", placement: "replace" }],
  ["rename only", { page: "123", newTitle: "Renamed" }],
  ["comment", COMMENT],
  ["delete", DELETE_PAGE],
  ["deleteAttachment by id", DELETE_ATTACHMENT],
  [
    "deleteAttachment by name",
    { operation: "deleteAttachment", page: "123", fileName: "diagram.png" },
  ],
];

test("AC6: each operation sends the local core's requests, each with the call's signal", async () => {
  for (const [name, item] of OPERATIONS) {
    const reference = await referenceRun([item]);
    const seen = stubConfluenceWriteFetch();
    const answer = await mutate([item]);
    const result = resultOf(answer);
    assert.deepEqual(shapeOf(seen), shapeOf(reference), name);
    assert.ok(writesIn(seen).length > 0, name);
    for (const request of seen)
      assert.ok(request.signal instanceof AbortSignal, `${name}: signal`);
    assert.deepEqual(
      result.items.map((row) => [row.operation, row.ok]),
      [[item.operation ?? "edit", true]],
      name,
    );
    vi.unstubAllGlobals();
  }
});

test("AC6: an edit replace reports prepare's dropped-node warning; a rename reports the new title", async () => {
  stubConfluenceWriteFetch();
  const replaced = resultOf(
    await mutate([{ page: "123", body: "Whole", placement: "replace" }]),
  );
  assert.deepEqual(replaced.warnings, [
    "replacing Page 123 drops its extension node(s)",
  ]);
  assert.deepEqual(replaced.items, [
    {
      operation: "edit",
      pageId: "123",
      ok: true,
      title: "Page 123",
      url: "https://acme.atlassian.net/wiki/spaces/ENG/pages/123",
      version: 8,
    },
  ]);
  const renamed = resultOf(
    await mutate([{ page: "123", newTitle: "Renamed" }]),
  );
  assert.equal(renamed.items[0]!.title, "Renamed");
});

test("AC6: an OAuth credential reaches the API base with its bearer, and the result is the same", async () => {
  const oauth: AtlassianCredential = {
    site: FAKE.site,
    cloudId: FAKE_CLOUD_ID,
    accessToken: "fake-oauth-access-for-confluence-edge",
  };
  const seen = stubConfluenceWriteFetch();
  const result = resultOf(await mutate([COMMENT], { credential: oauth }));
  assert.ok(result.items[0]!.ok);
  for (const request of seen)
    assert.ok(
      request.url.pathname.startsWith(`/ex/confluence/${FAKE_CLOUD_ID}/`),
      request.url.pathname,
    );
});

// --- AC6: the shared runner's budget, fence and cutoff on a fake clock ---

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

/** A request that never answers; it rejects once its signal aborts, as `fetch` does. */
function pendingUntilAbort(seen: SeenConfluenceWrite): Promise<Response> {
  return new Promise((_resolve, reject) => {
    const signal = seen.signal;
    if (!signal) return;
    const fail = () =>
      reject(
        signal.reason instanceof Error ? signal.reason : new Error("aborted"),
      );
    if (signal.aborted) return fail();
    signal.addEventListener("abort", fail, { once: true });
  });
}

/** Runs one call to its end on the fake clock; answers it and when it ended. */
async function run(items: unknown[], options: CallOptions = {}) {
  const started = Date.now();
  let endedAt: number | undefined;
  const pending = mutate(items, options).then((answer) => {
    endedAt = Date.now() - started;
    return answer;
  });
  for (let passed = 0; passed < 60_000 && endedAt === undefined; passed += 250)
    await advance(250);
  return { answer: await pending, endedAt: endedAt ?? Number.NaN };
}

const isPageRead = (r: SeenConfluenceWrite) =>
  r.method === "GET" && r.path === "/wiki/api/v2/pages/123";
const TOO_LONG = {
  ok: false,
  code: "tool_error",
  message: PREPARE_TOO_LONG_CONFLUENCE,
};
const outcomeOf = (answer: Awaited<ReturnType<typeof mutate>>) => {
  const { credentialReads: _reads, ...rest } = answer;
  void _reads;
  return rest;
};

test("prepare budget (a): a page read that hangs until its signal aborts gives PREPARE_TOO_LONG at the budget, with no write", async () => {
  for (const item of [EDIT, COMMENT, DELETE_PAGE]) {
    fakeClock();
    let hung: SeenConfluenceWrite | undefined;
    const seen = stubConfluenceWriteFetch((request) => {
      if (!isPageRead(request)) return undefined;
      hung = request;
      return pendingUntilAbort(request);
    });
    const { answer, endedAt } = await run([item]);
    assert.deepEqual(outcomeOf(answer), TOO_LONG);
    // 45 s less the 22 s reserve; the fake clock steps by 250 ms.
    assert.ok(endedAt >= 23_000 && endedAt <= 23_250, String(endedAt));
    assert.equal(hung?.signal?.aborted, true);
    assert.equal(writesIn(seen).length, 0);
    vi.unstubAllGlobals();
    vi.useRealTimers();
  }
});

test("prepare budget (d): a page read that ignores its signal and answers late still gives PREPARE_TOO_LONG; nothing follows it", async () => {
  fakeClock();
  const seen = stubConfluenceWriteFetch((request) =>
    isPageRead(request)
      ? after(30_000, () => fakeConfluenceAnswer(request))
      : undefined,
  );
  const { answer, endedAt } = await run([EDIT]);
  assert.deepEqual(outcomeOf(answer), TOO_LONG);
  assert.ok(endedAt <= 23_250);
  const count = seen.length;
  await advance(30_000);
  assert.equal(seen.length, count, "no request after the late settlement");
  assert.equal(writesIn(seen).length, 0);
});

test("prepare budget (e): a credential read past the budget gives PREPARE_TOO_LONG with no Confluence request", async () => {
  fakeClock();
  const seen = stubConfluenceWriteFetch();
  const { answer } = await run([EDIT], { credentialDelayMs: 23_001 });
  assert.deepEqual(outcomeOf(answer), TOO_LONG);
  assert.equal(seen.length, 0);
});

test("prepare budget (f): a caller abort during prepare is the host's cancel, not PREPARE_TOO_LONG", async () => {
  fakeClock();
  const controller = new AbortController();
  const seen = stubConfluenceWriteFetch((request) =>
    isPageRead(request) ? pendingUntilAbort(request) : undefined,
  );
  setTimeout(() => controller.abort(), 1_000);
  const { answer, endedAt } = await run([EDIT], { signal: controller.signal });
  assert.deepEqual(outcomeOf(answer), {
    ok: false,
    code: "cancelled",
    message: WRITE_CANCELLED,
  });
  assert.ok(endedAt <= 1_250);
  assert.equal(writesIn(seen).length, 0);
});

test("prepare budget (g): prepare settling in the same timer turn the budget fires never writes", async () => {
  const start = fakeClock();
  const seen = stubConfluenceWriteFetch((request) =>
    isPageRead(request)
      ? after(start + 23_000 - Date.now(), () => fakeConfluenceAnswer(request))
      : undefined,
  );
  const { answer } = await run([EDIT]);
  assert.deepEqual(outcomeOf(answer), TOO_LONG);
  assert.equal(writesIn(seen).length, 0);
});

test("prepare budget (h): once prepare is over, a page PUT's 400 is D-W2's text even past the old budget", async () => {
  fakeClock();
  const seen = stubConfluenceWriteFetch((request) =>
    request.method === "PUT"
      ? after(30_000, () =>
          json({ errorMessages: [REASON_SENTINEL], x: BODY_SENTINEL }, 400),
        )
      : undefined,
  );
  const { answer, endedAt } = await run([EDIT]);
  assert.ok(endedAt >= 30_000);
  assert.deepEqual(outcomeOf(answer), {
    ok: false,
    code: "tool_error",
    message: `All 1 Confluence change(s) failed: Confluence refused the change (HTTP 400): ${REASON_SENTINEL}`,
  });
  assert.equal(writesIn(seen).length, 1);
});

test("prepare budget (i): the fence refuses a prepare that resolves after the budget instant before its timer runs", async () => {
  const start = fakeClock();
  let release: () => void = () => {};
  let held = false;
  const seen = stubConfluenceWriteFetch((request) => {
    if (!isPageRead(request) || held) return undefined;
    held = true;
    return new Promise<Response>((resolve) => {
      release = () => resolve(fakeConfluenceAnswer(request));
    });
  });
  // The rename's only prepare read is the page; release it at the instant.
  const pending = mutate([{ page: "123", newTitle: "Renamed" }]);
  await flush();
  vi.setSystemTime(start + 23_000);
  release();
  await flush();
  for (let i = 0; i < 5; i += 1) await flush();
  assert.deepEqual(outcomeOf(await pending), TOO_LONG);
  assert.equal(writesIn(seen).length, 0);
});

test("stop cutoff: a slow first item leaves the rest not applied, keeping its own result", async () => {
  fakeClock();
  let comments = 0;
  const seen = stubConfluenceWriteFetch((request) =>
    request.method === "POST" &&
    request.path === "/wiki/api/v2/footer-comments" &&
    (comments += 1) === 1
      ? after(39_000, () => fakeConfluenceAnswer(request))
      : undefined,
  );
  const items = ["123", "124", "125"].map((page) => ({ ...COMMENT, page }));
  const { answer } = await run(items);
  const result = resultOf(answer);
  assert.deepEqual(
    result.items.map((row) => [row.pageId, row.ok, row.error]),
    [
      ["123", true, undefined],
      ["124", false, STOP_TEXT],
      ["125", false, STOP_TEXT],
    ],
  );
  assert.equal(writesIn(seen).length, 1);
});

test("a hard timeout during item 1 is the write timeout text, and no request starts after it", async () => {
  fakeClock();
  const seen = stubConfluenceWriteFetch((request) =>
    request.method === "POST" ? pendingUntilAbort(request) : undefined,
  );
  const items = ["123", "124"].map((page) => ({ ...COMMENT, page }));
  const { answer, endedAt } = await run(items);
  assert.deepEqual(outcomeOf(answer), {
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

// --- AC7 and C5: trash only, behind P5a's positive-status guard ---

test("AC7: the delete requests are exact paths with no query, once per item", async () => {
  const seen = stubConfluenceWriteFetch();
  resultOf(await mutate([DELETE_PAGE, DELETE_ATTACHMENT]));
  assert.deepEqual(
    deletesIn(seen).map((r) => [r.url.pathname, r.url.search, r.body]),
    [
      ["/wiki/api/v2/pages/123", "", null],
      ["/wiki/api/v2/attachments/att1", "", null],
    ],
  );
});

test("C5: a page delete whose verification read omits status refuses with P5a's text and sends no DELETE", async () => {
  const seen = stubConfluenceWriteFetch(undefined, { pageStatus: null });
  const answer = await mutate([DELETE_PAGE]);
  assert.deepEqual(outcomeOf(answer), {
    ok: false,
    code: "tool_error",
    message: `Page 123 is not confirmed current (status unknown); nothing was deleted.${NOTHING_WRITTEN}`,
  });
  assert.equal(deletesIn(seen).length, 0);
});

test("C5: a deleteAttachment whose verification read omits status refuses with P5a's text and sends no DELETE", async () => {
  for (const item of [
    DELETE_ATTACHMENT,
    { operation: "deleteAttachment", page: "123", fileName: "diagram.png" },
  ]) {
    const seen = stubConfluenceWriteFetch(undefined, {
      attachmentStatus: null,
    });
    const answer = await mutate([item]);
    assert.deepEqual(outcomeOf(answer), {
      ok: false,
      code: "tool_error",
      message: `diagram.png is not confirmed current (status unknown); nothing was deleted.${NOTHING_WRITTEN}`,
    });
    assert.equal(deletesIn(seen).length, 0);
    vi.unstubAllGlobals();
  }
});

test("C5: a replayed delete deletes once; the second call refuses on the trashed status, so one DELETE across both", async () => {
  const cases: Array<[item: object, refusal: string]> = [
    [
      DELETE_PAGE,
      `Page 123 is not confirmed current (status trashed); nothing was deleted.${NOTHING_WRITTEN}`,
    ],
    [
      DELETE_ATTACHMENT,
      `diagram.png is not confirmed current (status trashed); nothing was deleted.${NOTHING_WRITTEN}`,
    ],
  ];
  for (const [item, refusal] of cases) {
    let trashed = false;
    const seen = stubConfluenceWriteFetch((request) => {
      if (request.method === "DELETE") trashed = true;
      if (!trashed || request.method !== "GET") return undefined;
      return fakeConfluenceAnswer(request, {
        pageStatus: "trashed",
        attachmentStatus: "trashed",
      });
    });
    const first = await mutate([item]);
    assert.ok(resultOf(first).items[0]!.ok);
    const second = await mutate([item]);
    assert.deepEqual(outcomeOf(second), {
      ok: false,
      code: "tool_error",
      message: refusal,
    });
    assert.equal(deletesIn(seen).length, 1);
    vi.unstubAllGlobals();
  }
});

// --- AC8: D-W2 texts end to end ---

test("AC8: a label POST 400 is the item's warning; the page write stands", async () => {
  stubConfluenceWriteFetch((request) =>
    request.method === "POST" && request.path.endsWith("/label")
      ? json({ errorMessages: [REASON_SENTINEL], x: BODY_SENTINEL }, 400)
      : undefined,
  );
  const result = resultOf(await mutate([{ ...EDIT, addLabels: ["a"] }]));
  assert.equal(result.items[0]!.ok, true);
  assert.equal(
    result.items[0]!.warning,
    `label changes failed: add a: Confluence refused the change (HTTP 400): ${REASON_SENTINEL}`,
  );
});

test("AC8: a page PUT 409 gives the status form; a v2 errors array gives no title text", async () => {
  for (const [status, body, text] of [
    [
      409,
      { message: BODY_SENTINEL },
      "Confluence refused the change (HTTP 409).",
    ],
    [
      400,
      { errors: [{ title: BODY_SENTINEL, detail: BODY_SENTINEL }] },
      "Confluence refused the change (HTTP 400).",
    ],
  ] as const) {
    stubConfluenceWriteFetch((request) =>
      request.method === "PUT" ? json(body, status) : undefined,
    );
    const answer = await mutate([EDIT]);
    assert.deepEqual(outcomeOf(answer), {
      ok: false,
      code: "tool_error",
      message: `All 1 Confluence change(s) failed: ${text}`,
    });
    vi.unstubAllGlobals();
  }
});

test("AC8: apply's verification read answering 404 gives the read's status text", async () => {
  let reads = 0;
  stubConfluenceWriteFetch((request) =>
    request.method === "GET" &&
    request.path === "/wiki/api/v2/pages/123" &&
    (reads += 1) === 2
      ? json({ message: BODY_SENTINEL }, 404)
      : undefined,
  );
  const answer = await mutate([{ page: "123", newTitle: "Renamed" }]);
  assert.deepEqual(outcomeOf(answer), {
    ok: false,
    code: "tool_error",
    message: "All 1 Confluence change(s) failed: Confluence answered HTTP 404.",
  });
});

test("AC8: a prepare read refusal ends the call before any write, with Nothing written", async () => {
  const seen = stubConfluenceWriteFetch((request) =>
    isPageRead(request) ? json({ message: BODY_SENTINEL }, 404) : undefined,
  );
  const answer = await mutate([EDIT]);
  assert.deepEqual(outcomeOf(answer), {
    ok: false,
    code: "tool_error",
    message: `Confluence answered HTTP 404.${NOTHING_WRITTEN}`,
  });
  assert.equal(writesIn(seen).length, 0);
});

// --- AC9: the result's size is bounded by construction ---

/** A shared-core row as apply leaves it. */
function row(
  fields: Partial<ConfluencePageMutationItemDisplay> = {},
): ConfluencePageMutationItemDisplay {
  return { clientId: "cfl_0", operation: "edit", pageId: "123", ...fields };
}

/** `item` with no `pageId`, as a create's row before Confluence answers. */
function withoutPageId(
  item: ConfluencePageMutationItemDisplay,
): ConfluencePageMutationItemDisplay {
  const { pageId: _pageId, ...rest } = item;
  void _pageId;
  return rest as ConfluencePageMutationItemDisplay;
}

/** `projectConfluenceResult` with the credential oracle on its result (fix-2). */
function project(
  ...args: Parameters<typeof projectConfluenceResult>
): ProjectedConfluenceResult {
  const result = projectConfluenceResult(...args);
  assertNoCredential(result, args[1]);
  assertNoCredential(JSON.stringify(result), args[1]);
  return result;
}

/** `"` and `\` (two characters each once serialized) with one lone surrogate. */
const worst = (length: number) =>
  `${'"\\'.repeat(Math.ceil(length / 2) + 50)}\uD800`;

test("AC9 (a): ten maximal rows serialize within the budget without shrinking, and round-trip", () => {
  const pageId = "9".repeat(20);
  const url = `https://${FAKE.site}/wiki/spaces/ENG/pages/${pageId}/`.padEnd(
    300,
    "a",
  );
  assert.equal(url.length, 300);
  const applied = {
    items: Array.from({ length: 10 }, (_, index) =>
      row({
        clientId: `cfl_${index}`,
        operation: "deleteAttachment",
        resultPageId: pageId,
        resultPageUrl: url,
        resultVersion: 999_999_999,
        title: worst(200),
        attachment: {
          fileName: worst(200),
          resultId: `att${"9".repeat(20)}`,
          resultVersion: 999_999_999,
        },
        warning: worst(400),
        error: worst(600),
      }),
    ),
    warnings: Array.from({ length: 14 }, () => worst(300)),
    succeeded: 0,
    resultSummary: worst(2_000),
    resultUrl: url,
  };
  const result = project(applied, FAKE);
  // Every capped field survived projection at its cap.
  assert.equal(result.summary.length, 2_000);
  assert.equal(result.url, url);
  assert.equal(result.warnings!.length, 11);
  for (const warning of result.warnings!.slice(0, 10))
    assert.equal(warning.length, 300);
  assert.equal(result.warnings![10], "4 more warning(s) omitted.");
  assert.equal(result.items.length, 10);
  for (const item of result.items) {
    assert.equal(item.pageId, pageId);
    assert.equal(item.url, url);
    assert.equal(item.version, 999_999_999);
    assert.equal(item.title!.length, 200);
    assert.equal(item.attachment!.fileName.length, 200);
    assert.equal(item.attachment!.id, `att${"9".repeat(20)}`);
    assert.equal(item.attachment!.version, 999_999_999);
    assert.equal(item.warning!.length, 400);
    assert.equal(item.error!.length, 600);
    assert.ok(!item.error!.includes("\uD800"));
  }
  const text = JSON.stringify(result);
  assert.ok(text.length <= RESULT_BUDGET, String(text.length));
  // Nothing was shrunk: the same as with no budget at all.
  assert.deepEqual(result, project(applied, FAKE, Number.POSITIVE_INFINITY));
  assert.deepEqual(JSON.parse(text), result);
});

test("AC9 (b): invalid ids and versions are dropped; off-site, long or unsafe links are omitted", () => {
  const site = `https://${FAKE.site}/wiki/spaces/ENG/pages/123`;
  const badIds: unknown[] = ["1".repeat(21), "12a", "", " 123", 123, null];
  const badAttachmentIds: unknown[] = [
    "att",
    `att${"1".repeat(21)}`,
    "ATT1",
    "1",
    "att1 ",
  ];
  const badVersions: unknown[] = [-1, 1.5, 1_000_000_000, "7", Number.NaN];
  const badUrls = [
    "https://evil.example/wiki/spaces/ENG/pages/123",
    `http://${FAKE.site}/wiki/spaces/ENG/pages/123`,
    `https://${FAKE.site}.evil.example/x`,
    `${site}/`.padEnd(301, "a"),
    `${site}?q="x"`,
    `${site}?q=\\x`,
    `${site}?q=a b`,
    `${site}?q=\u0007`,
    `${site}?q=%E0%A4%A`,
  ];
  /** One projected row per input row; each group fits the ten-row cap. */
  const rowsOf = (items: ConfluencePageMutationItemDisplay[]) => {
    assert.ok(items.length <= 10);
    return project(
      { items, warnings: [], succeeded: 1, resultSummary: "Applied" },
      FAKE,
    ).items;
  };
  for (const projected of rowsOf(
    badIds.map((id) =>
      withoutPageId(row({ resultPageId: id as string, resultPageUrl: site })),
    ),
  )) {
    assert.equal(projected.pageId, null);
    assert.equal(projected.url, undefined, "a link without a valid id");
  }
  for (const projected of rowsOf(
    badAttachmentIds.map((id) =>
      row({
        operation: "deleteAttachment",
        attachment: { fileName: "f.png", resultId: id as string },
      }),
    ),
  ))
    assert.deepEqual(projected.attachment, { fileName: "f.png" });
  for (const projected of rowsOf(
    badVersions.map((version) =>
      row({
        resultVersion: version as number,
        attachment: { fileName: "f.png", resultVersion: version as number },
      }),
    ),
  )) {
    assert.equal(projected.version, undefined);
    assert.deepEqual(projected.attachment, { fileName: "f.png" });
  }
  const linked = rowsOf(badUrls.map((url) => row({ resultPageUrl: url })));
  assert.equal(linked.length, badUrls.length);
  for (const [index, url] of badUrls.entries()) {
    assert.equal(linked[index]!.pageId, "123", url);
    assert.equal(linked[index]!.url, undefined, url);
  }
  // A good row keeps its link: the omissions above are the link rules'.
  assert.equal(
    project(
      {
        items: [row({ resultPageUrl: site })],
        warnings: [],
        succeeded: 1,
        resultSummary: "Applied",
      },
      FAKE,
    ).items[0]!.url,
    site,
  );
});

test("AC9 (c): the shrink guard steps in Confluence's order and keeps each row's outcome and error", () => {
  const applied = {
    items: Array.from({ length: 3 }, (_, index) =>
      row({
        clientId: `cfl_${index}`,
        operation: index === 2 ? "deleteAttachment" : "edit",
        pageId: `12${index}`,
        resultPageUrl: `https://${FAKE.site}/wiki/spaces/ENG/pages/12${index}`,
        resultVersion: 8,
        title: "t".repeat(180),
        warning: "w".repeat(380),
        ...(index === 1 ? {} : { error: "e".repeat(580) }),
        ...(index === 2
          ? { attachment: { fileName: "f".repeat(180), existingId: "att1" } }
          : {}),
      }),
    ),
    warnings: ["first warning", "second warning"],
    succeeded: 1,
    resultSummary: "Applied 1 Confluence change(s); 2 failed",
    resultUrl: `https://${FAKE.site}/wiki/spaces/ENG/pages/121`,
  };
  const size = (result: ProjectedConfluenceResult) =>
    JSON.stringify(result).length;
  const outcomes = (result: ProjectedConfluenceResult) =>
    result.items.map((r) => [
      r.operation,
      r.pageId,
      r.ok,
      r.error !== undefined,
    ]);
  const full = project(applied, FAKE);

  const step1 = project(applied, FAKE, size(full) - 1);
  assert.deepEqual(step1.warnings, ["2 warning(s) omitted."]);
  assert.equal(step1.items[0]!.error!.length, 580);

  const step2 = project(applied, FAKE, size(step1) - 1);
  assert.equal(step2.items[0]!.error!.length, 200);
  assert.equal(step2.items[0]!.warning!.length, 200);
  assert.equal(step2.items[0]!.title!.length, 180);

  const step3 = project(applied, FAKE, size(step2) - 1);
  assert.equal(step3.items[0]!.title!.length, 50);
  assert.equal(step3.items[2]!.attachment!.fileName.length, 50);
  assert.ok(step3.items.every((r) => r.url !== undefined));

  const step4 = project(applied, FAKE, size(step3) - 1);
  assert.deepEqual(step4.items, [
    {
      operation: "edit",
      pageId: "120",
      ok: false,
      error: step2.items[0]!.error,
    },
    { operation: "edit", pageId: "121", ok: true },
    {
      operation: "deleteAttachment",
      pageId: "122",
      ok: false,
      error: step2.items[2]!.error,
    },
  ]);
  assert.deepEqual(project(applied, FAKE, 1), step4);
  for (const shrunk of [step1, step2, step3, step4])
    assert.deepEqual(outcomes(shrunk), outcomes(full));
  assert.deepEqual(outcomes(full), [
    ["edit", "120", false, true],
    ["edit", "121", true, false],
    ["deleteAttachment", "122", false, true],
  ]);
});

// --- AC10: no upstream text outside D-W2 ---

test("AC10: bodies, current bodies and other upstream fields never reach the answer", async () => {
  const sentinelAdf = PAGE_ADF.replace('"Body"', `"${BODY_SENTINEL}"`);
  stubConfluenceWriteFetch((request) => {
    if (request.method !== "GET") return undefined;
    if (isPageRead(request) || request.path === "/wiki/api/v2/pages/123")
      return json({
        id: "123",
        title: "Runbook",
        status: "current",
        spaceId: "900",
        version: { number: 7 },
        body: { atlas_doc_format: { value: sentinelAdf } },
        authorId: BODY_SENTINEL,
        _links: { webui: "/spaces/ENG/pages/123", extra: BODY_SENTINEL },
      });
    if (request.path === "/wiki/api/v2/spaces/900")
      return json({ id: "900", key: "ENG", name: BODY_SENTINEL });
    return undefined;
  });
  const answer = await mutate([
    { page: "123", body: `Appended ${BODY_SENTINEL}` },
    { ...COMMENT, body: BODY_SENTINEL },
  ]);
  const result = resultOf(answer);
  assert.deepEqual(
    result.items.map((r) => [r.operation, r.ok, r.title]),
    [
      ["edit", true, "Runbook"],
      ["comment", true, "Runbook"],
    ],
  );
  assert.ok(!textOf(answer).includes(BODY_SENTINEL), textOf(answer));
});

// --- C1: identifiers and links vetted for the call's secret, raw first ---

/** Every character percent-encoded, so each decoding changes the text. */
const percentEncoded = (text: string) =>
  [...Buffer.from(text, "utf8")]
    .map((byte) => `%${byte.toString(16).toUpperCase().padStart(2, "0")}`)
    .join("");

/** The answer's text holds none of `credential`'s forms, nor a 16-character window of one. */
function assertNoForms(text: string, credential: AtlassianCredential): void {
  for (const form of oracleForms(credential))
    for (let at = 0; at + 16 <= form.length; at += 1)
      assert.ok(!text.includes(form.slice(at, at + 16)), form);
  assertNoCredential(text, credential);
}

const CREATE = {
  operation: "create",
  spaceKey: "ENG",
  title: "New page",
  body: "Hello",
};

test("C1 (i): a created page id equal to a 16-digit token is null, and its links go with it", async () => {
  const credential = { ...FAKE, token: "4815162342424242" };
  stubConfluenceWriteFetch(undefined, { createdId: credential.token });
  const answer = await mutate([CREATE], { credential });
  const result = resultOf(answer);
  assert.deepEqual(result.items, [
    {
      operation: "create",
      pageId: null,
      ok: true,
      title: "New page",
      version: 1,
    },
  ]);
  assert.equal(result.url, undefined);
  assertNoForms(textOf(answer), credential);
});

test("C1 (ii): the same with an OAuth access token shaped like a page id", async () => {
  const credential: AtlassianCredential = {
    site: FAKE.site,
    cloudId: FAKE_CLOUD_ID,
    accessToken: "9876543210987654",
  };
  stubConfluenceWriteFetch(undefined, { createdId: credential.accessToken });
  const answer = await mutate([CREATE], { credential });
  const result = resultOf(answer);
  assert.equal(result.items[0]!.pageId, null);
  assert.equal(result.items[0]!.url, undefined);
  assert.equal(result.url, undefined);
  assertNoForms(textOf(answer), credential);
});

test("C1 (iii): an attachment id of `att` and the token's digits is omitted", async () => {
  const credential = { ...FAKE, token: "4815162342424242" };
  const id = `att${credential.token}`;
  stubConfluenceWriteFetch((request) => {
    if (request.method !== "GET") return undefined;
    if (request.path === "/wiki/api/v2/pages/123/attachments")
      return json({ results: [{ ...attachmentRow(), id }] });
    if (request.path === `/wiki/api/v2/attachments/${id}`)
      return json({ ...attachmentRow(), id });
    return undefined;
  });
  const answer = await mutate(
    [{ operation: "deleteAttachment", page: "123", fileName: "diagram.png" }],
    { credential },
  );
  const result = resultOf(answer);
  assert.deepEqual(result.items[0]!.attachment, { fileName: "diagram.png" });
  assert.equal(result.items[0]!.pageId, "123");
  assertNoForms(textOf(answer), credential);
});

test("C1 (iv): a link holding the token raw, encoded once or twice is omitted; the same link without it is kept", async () => {
  const once = percentEncoded(FAKE.token);
  const twice = once.replaceAll("%", "%25");
  const forms = [FAKE.token, once, twice];
  assert.equal(new Set(forms).size, 3, "three distinct links");
  for (const form of forms) {
    const webui = `/spaces/ENG/pages/456/${form}`;
    stubConfluenceWriteFetch(undefined, { createdWebui: webui });
    const answer = await mutate([CREATE]);
    const result = resultOf(answer);
    // The backing id is safe, so only the link's own vetting drops it.
    assert.equal(result.items[0]!.pageId, "456", form);
    assert.equal(result.items[0]!.url, undefined, form);
    assert.equal(result.url, undefined, form);
    assertNoForms(textOf(answer), FAKE);
    vi.unstubAllGlobals();
  }
  const safe = percentEncoded("SAFE-WORD-SENTINEL-9876543210");
  stubConfluenceWriteFetch(undefined, {
    createdWebui: `/spaces/ENG/pages/456/${safe}`,
  });
  const kept = resultOf(await mutate([CREATE]));
  assert.equal(
    kept.items[0]!.url,
    `https://${FAKE.site}/wiki/spaces/ENG/pages/456/${safe}`,
  );
  assert.equal(kept.url, kept.items[0]!.url);
});

test("C1 (v): a page id that is a 16-character slice of the token is dropped; an ordinary one is kept with its link", async () => {
  const credential = { ...FAKE, token: "ab12345678901234567890cd" };
  const slice = "1234567890123456";
  assert.ok(credential.token.includes(slice));
  stubConfluenceWriteFetch(undefined, { createdId: slice });
  const sliced = await mutate([CREATE], { credential });
  assert.equal(resultOf(sliced).items[0]!.pageId, null);
  assert.equal(resultOf(sliced).items[0]!.url, undefined);
  assertNoForms(textOf(sliced), credential);
  vi.unstubAllGlobals();

  stubConfluenceWriteFetch();
  const ordinary = resultOf(await mutate([CREATE], { credential }));
  assert.equal(ordinary.items[0]!.pageId, "456");
  assert.equal(
    ordinary.items[0]!.url,
    `https://${FAKE.site}/wiki/spaces/ENG/pages/456/New+page`,
  );
});

test("C1 (vi): a link holding the Basic form, padded or not, is omitted", async () => {
  const [, padded, unpadded] = oracleForms(FAKE);
  assert.ok(padded!.endsWith("="), "the fixture's Basic form is padded");
  assert.notEqual(padded, unpadded);
  for (const form of [padded!, unpadded!]) {
    stubConfluenceWriteFetch(undefined, {
      createdWebui: `/spaces/ENG/pages/456?k=${form}`,
    });
    const answer = await mutate([CREATE]);
    const result = resultOf(answer);
    assert.equal(result.items[0]!.pageId, "456");
    assert.equal(result.items[0]!.url, undefined, form);
    assertNoForms(textOf(answer), FAKE);
    vi.unstubAllGlobals();
  }
});

test("O5: an off-site absolute link that confluenceWebUrl passes through is omitted", async () => {
  stubConfluenceWriteFetch(undefined, {
    createdWebui: "https://elsewhere.example/wiki/spaces/ENG/pages/456",
  });
  const result = resultOf(await mutate([CREATE]));
  assert.equal(result.items[0]!.pageId, "456");
  assert.equal(result.items[0]!.url, undefined);
  assert.equal(result.url, undefined);
});

// --- The last check of the answer as it is sent (R3, requester ruling) ---

test("through the host: a secret that only the serialized result spells leaves the rows' outcomes; one the outcomes spell answers the fixed text", async () => {
  // First: no field holds the token, nor any 16-character window of it, but
  // the title, the JSON scaffold and the link joined do.
  const joined = { ...FAKE, token: 'Runbook","url":"https://acme' };
  stubConfluenceWriteFetch(undefined, { pageTitle: "Runbook" });
  const outcomes = await mutate([EDIT], { credential: joined });
  assert.deepEqual(resultOf(outcomes), {
    summary: REDACTED,
    items: [{ operation: "edit", pageId: null, ok: true }],
  });
  vi.unstubAllGlobals();
  // Then: the outcomes' own scaffold, as the /mcp body escapes it.
  const scaffold = { ...FAKE, token: '\\"ok\\":true' };
  const seen = stubConfluenceWriteFetch();
  const withheld = await mutate([EDIT], { credential: scaffold });
  assert.deepEqual(outcomeOf(withheld), {
    ok: false,
    code: "tool_error",
    message: CONFLUENCE_RESULT_WITHHELD,
  });
  // The write did run: the text says so, and the PUT was sent.
  assert.equal(seen.filter((r) => r.method === "PUT").length, 1);
  assert.equal(
    CONFLUENCE_RESULT_WITHHELD,
    "The changes ran, but their result cannot be shown without revealing the credential; check the pages before retrying.",
  );
});

test("strings that JSON joins into a secret leave only the rows' outcomes; failing that, the fixed text", () => {
  const joined = { ...FAKE, token: 'END","warnings":["START' };
  assert.deepEqual(
    project(
      {
        items: [row()],
        warnings: ["START"],
        succeeded: 1,
        resultSummary: "END",
      },
      joined,
    ),
    {
      summary: REDACTED,
      items: [{ operation: "edit", pageId: null, ok: true }],
    },
  );
  const scaffold = { ...FAKE, token: '\\"ok\\":true' };
  assert.throws(
    () =>
      projectConfluenceResult(
        {
          items: [row()],
          warnings: [],
          succeeded: 1,
          resultSummary: "Applied 1 Confluence change(s)",
        },
        scaffold,
      ),
    (err: unknown) =>
      err instanceof Error && err.message === CONFLUENCE_RESULT_WITHHELD,
  );
});

// --- AC11 and C3: the MCP exchange ---

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

const MCP_HEADERS = {
  "content-type": "application/json",
  accept: "application/json, text/event-stream",
  "mcp-protocol-version": "2025-06-18",
};

const mcpCaller = {
  clientId: "client-1",
  credential: () =>
    Promise.resolve({
      ok: true as const,
      credential: encodeAtlassianCredential(FAKE),
    }),
};

test("AC11: /mcp lets confluence_mutate_page run past the host deadline plus margin", async () => {
  fakeClock();
  stubConfluenceWriteFetch((request) =>
    request.method === "POST" && request.path === "/wiki/api/v2/footer-comments"
      ? after(6_500, () => fakeConfluenceAnswer(request))
      : undefined,
  );
  // The old bound would be 1,000 + 5,000 ms; the write answers at 6,500 ms.
  const edge = createEdgeTools({ deadlineMs: 1_000, log: () => {} });
  const req = Object.assign(
    Readable.from([
      Buffer.from(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: {
            name: "confluence_mutate_page",
            arguments: { items: [COMMENT] },
          },
        }),
      ),
    ]),
    { method: "POST", headers: MCP_HEADERS },
  );
  const res = new FakeResponse();
  edge.handleMcp(
    req as unknown as http.IncomingMessage,
    res as unknown as http.ServerResponse,
    mcpCaller,
  );
  await advance(7_000);
  const answer = await res.done;
  assertNoCredential(answer.body, FAKE);
  assert.equal(answer.status, 200);
  const body = JSON.parse(answer.body) as {
    result: { content: Array<{ text: string }>; isError?: boolean };
  };
  assert.equal(body.result.isError, undefined);
  const result = JSON.parse(
    body.result.content[0]!.text,
  ) as ProjectedConfluenceResult;
  assert.equal(result.items[0]!.ok, true);
});

/** POSTs one JSON-RPC message to `url`. */
function post(
  url: string,
  message: unknown,
): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const request = http.request(
      url,
      { method: "POST", agent: false, headers: MCP_HEADERS },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () =>
          resolve({
            status: response.statusCode ?? 0,
            text: Buffer.concat(chunks).toString("utf8"),
          }),
        );
      },
    );
    request.on("error", reject);
    request.end(JSON.stringify(message));
  });
}

test("C3: a cancellation notification on another POST does not reach a running confluence_mutate_page", async () => {
  let release: () => void = () => {};
  const released = new Promise<void>((resolve) => (release = resolve));
  let started: () => void = () => {};
  const running = new Promise<void>((resolve) => (started = resolve));
  let putSignal: AbortSignal | undefined;
  stubConfluenceWriteFetch(async (request) => {
    if (request.method !== "PUT") return undefined;
    putSignal = request.signal;
    started();
    await released;
    return fakeConfluenceAnswer(request);
  });
  const edge = createEdgeTools({ log: () => {} });
  const server = http.createServer((req, res) =>
    edge.handleMcp(req, res, mcpCaller),
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    const url = `http://127.0.0.1:${port}/mcp`;
    const answer = post(url, {
      jsonrpc: "2.0",
      id: 9,
      method: "tools/call",
      params: { name: "confluence_mutate_page", arguments: { items: [EDIT] } },
    });
    await running;
    const notified = await post(url, {
      jsonrpc: "2.0",
      method: "notifications/cancelled",
      params: { requestId: 9, reason: "The user interrupted." },
    });
    // What the SDK answers any notification: accepted, no body.
    assert.equal(notified.status, 202);
    assert.equal(notified.text, "");
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(putSignal?.aborted, false);
    release();
    const called = await answer;
    assert.equal(called.status, 200);
    const body = JSON.parse(called.text) as {
      id: number;
      result: { content: Array<{ text: string }>; isError?: boolean };
    };
    assert.equal(body.id, 9);
    assert.equal(body.result.isError, undefined);
    const result = JSON.parse(
      body.result.content[0]!.text,
    ) as ProjectedConfluenceResult;
    assert.equal(result.items[0]!.ok, true);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
