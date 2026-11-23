/**
 * The write tools' two phases through the tool host (Task-1463 P6a): the
 * listing, the client `tools.call` refusal, `prepare` and `apply` for both
 * tools against a fake Atlassian, the effects the ledger certifies, the
 * stop between items (P6-O1), prepare's failure texts (P6-O2) and the v03
 * secret fixtures. Every value is fake.
 */
import { afterEach, describe, expect, test, vi } from "vitest";
import type { ConfluencePageMutationItemDisplay } from "@assistant/shared/confluenceMutation";
import type { JiraIssueMutationItemDisplay } from "@assistant/shared/jiraMutation";
import { buildConfluenceMutationItems } from "../confluenceMutate.ts";
import { checkConfluencePageItems } from "../confluenceMutationCheck.ts";
import {
  checkConfluenceResult,
  mergeConfluenceResult,
  type ConfluenceResultRecord,
} from "../confluenceMutationResult.ts";
import { errorText } from "../errors.ts";
import { setRetrySleepForTests } from "../httpRetry.ts";
import {
  buildFieldMap,
  fetchJiraFields,
  fetchJiraIssueLinkTypes,
} from "../jiraFields.ts";
import { buildJiraMutationItems } from "../jiraMutate.ts";
import { checkJiraIssueItems } from "../jiraMutationCheck.ts";
import {
  checkJiraResult,
  mergeJiraResult,
  type JiraResultRecord,
} from "../jiraMutationResult.ts";
import { FAKE_CLOUD_ID } from "../test/atlassianFake.ts";
import {
  stubConfluenceWriteFetch,
  type SeenConfluenceWrite,
} from "../test/confluenceMutateFetch.ts";
import { assertNoCredential } from "../test/credentialOracle.ts";
import {
  json,
  pendingUntilAbort,
  stubJiraFetch,
  type SeenJiraRequest,
} from "../test/jiraEdgeFetch.ts";
import { fakeJiraAnswer, isWrite } from "../test/jiraMutateFetch.ts";
import {
  confluenceConfigOf,
  encodeAtlassianCredential,
  jiraConfigOf,
} from "./atlassian.ts";
import {
  ATTACHMENT_DELETE_OFF,
  UPLOAD_UNAVAILABLE,
} from "./confluenceMutatePage.ts";
import type { AtlassianTokenCredential } from "./descriptor.ts";
import { createToolHost, type ToolCaller } from "./host.ts";
import { edgeTools } from "./tools.ts";
import {
  ITEMS_INVALID,
  PROPOSAL_TOO_LARGE,
  SITE_CHANGED,
  STOPPED,
  TWO_PHASE_ONLY,
  type ApplyAnswer,
  type PrepareAnswer,
} from "./twoPhase.ts";

const FAKE: AtlassianTokenCredential = {
  site: "acme.atlassian.net",
  email: "me@x.test",
  token: "FAKE-TOKEN-SENTINEL-0123456789",
};
const JIRA = "jira_mutate_issue";
const CONFLUENCE = "confluence_mutate_page";
const WRITE_TIMEOUT =
  "The tool timed out; some changes may have been applied, so check before retrying.";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  setRetrySleepForTests(null);
});

type Credential = Parameters<typeof assertNoCredential>[1];

/** One client: its caller, and how often the vault was read. */
function client(options: { credential?: string; signal?: AbortSignal } = {}): {
  caller: ToolCaller;
  reads: () => number;
} {
  const credential = options.credential ?? encodeAtlassianCredential(FAKE);
  let reads = 0;
  return {
    caller: {
      clientId: "client-1",
      credential: () => {
        reads += 1;
        return Promise.resolve({ ok: true as const, credential });
      },
      ...(options.signal ? { signal: options.signal } : {}),
    },
    reads: () => reads,
  };
}

/** A host whose Confluence deletes are on, with its log lines. */
function host(deletes = { page: true, attachment: true }) {
  const lines: string[] = [];
  const real = createToolHost(edgeTools({ confluenceDeletes: deletes }), {
    log: (line) => lines.push(line),
  });
  return { host: real, lines };
}

const proposalOf = (answer: PrepareAnswer) => {
  if (!answer.ok) throw new Error(`prepare failed: ${answer.message}`);
  return answer;
};
const resultsOf = <R>(answer: ApplyAnswer): R[] => {
  if (!answer.ok) throw new Error(`apply failed: ${answer.message}`);
  return answer.results as R[];
};

/** Every serialized string of `value` is free of `credential`'s secret forms. */
const assertClean = (value: unknown, credential: Credential = FAKE) =>
  assertNoCredential(JSON.stringify(value), credential);

const EDIT = { issue: "STAR-1", summary: "New summary" };
const COMMENT = { operation: "comment", issue: "STAR-1", commentBody: "Hi" };
const CREATE = {
  operation: "create",
  projectKey: "STAR",
  issueType: "Task",
  summary: "A new task",
};
const LINKED_EDIT = {
  issue: "STAR-1",
  summary: "Linked summary",
  linkChanges: [
    { op: "add", type: "Blocks", direction: "outward", issue: "STAR-2" },
    { op: "remove", linkId: "9001" },
  ],
};
const RANK = {
  operation: "rank",
  rankIssues: ["STAR-2", "STAR-3"],
  rankPosition: "before",
  rankTargetIssue: "STAR-1",
};

/** The shared prepare for `items`, as the local tool runs it: its items. */
async function referenceJiraItems(
  items: unknown[],
): Promise<JiraIssueMutationItemDisplay[]> {
  stubJiraFetch((request) => fakeJiraAnswer(request));
  const config = jiraConfigOf(FAKE);
  let map: ReturnType<typeof buildFieldMap> | undefined;
  try {
    const prepared = await buildJiraMutationItems(
      config,
      items as Parameters<typeof buildJiraMutationItems>[1],
      {
        fieldMap: async () =>
          (map ??= buildFieldMap({
            fetchedAt: 0,
            fields: await fetchJiraFields(config),
          })),
        issueLinkTypes: () => fetchJiraIssueLinkTypes(config),
        describeError: errorText,
        matchesHttpStatus: (err, statuses) =>
          new RegExp(`HTTP (?:${statuses.join("|")})\\b`).test(errorText(err)),
      },
    );
    return prepared.items;
  } finally {
    vi.unstubAllGlobals();
  }
}

describe("the listing and a client's tools.call", () => {
  test("exactly the two write tools are listed twoPhase", () => {
    const listed = host().host.list();
    expect(
      listed
        .filter((tool) => tool.twoPhase)
        .map((tool) => tool.name)
        .sort(),
    ).toEqual([CONFLUENCE, JIRA]);
    for (const tool of listed)
      expect(tool.twoPhase === true).toBe(tool.effect === "write");
  });

  test("callForClient refuses each write tool before the credential, whatever its arguments", async () => {
    for (const name of [JIRA, CONFLUENCE])
      for (const args of [
        { items: [EDIT] },
        { items: [EDIT], via: "mcp" },
        { items: [EDIT], mode: "one-call", twoPhase: false },
        {},
      ]) {
        const seen = stubJiraFetch();
        const { caller, reads } = client();
        const { host: real, lines } = host();
        expect(await real.callForClient(name, args, caller)).toEqual({
          ok: false,
          code: "invalid_params",
          message: TWO_PHASE_ONLY,
        });
        expect(reads()).toBe(0);
        expect(seen).toEqual([]);
        expect(lines).toEqual([
          expect.stringMatching(
            new RegExp(`^tool ${name} client client-1 invalid_params \\d+ms$`),
          ),
        ]);
        vi.unstubAllGlobals();
      }
  });

  test("callForClient runs a read tool as call does", async () => {
    const { host: real } = host();
    const read = real.list().find((tool) => tool.effect === "read")!;
    const { caller } = client();
    expect(await real.callForClient(read.name, { nope: 1 }, caller)).toEqual(
      await real.call(read.name, { nope: 1 }, caller),
    );
  });

  test("prepare and apply know no read tool and no unknown name", async () => {
    const { host: real } = host();
    const { caller, reads } = client();
    for (const name of ["jira_get_issue", "no_such_tool"]) {
      expect(await real.prepare(name, {}, caller)).toEqual({
        ok: false,
        code: "unknown_tool",
        message: "No such tool.",
      });
      expect(
        await real.apply(name, { site: FAKE.site, items: [] }, caller),
      ).toEqual({
        ok: false,
        code: "unknown_tool",
        message: "No such tool.",
        effects: "none",
      });
    }
    expect(reads()).toBe(0);
  });
});

describe("tools.prepare", () => {
  test("answers the shared prepare's items, the site and no write, for each Jira operation", async () => {
    for (const item of [EDIT, COMMENT, CREATE, LINKED_EDIT, RANK]) {
      const reference = await referenceJiraItems([item]);
      const seen = stubJiraFetch((request) => fakeJiraAnswer(request));
      const { caller } = client();
      const answer = proposalOf(
        await host().host.prepare(JIRA, { items: [item] }, caller),
      );
      expect(answer.site).toBe(FAKE.site);
      expect(answer.items).toEqual(reference);
      expect(checkJiraIssueItems(answer.items)).toBe(true);
      expect(seen.filter(isWrite)).toEqual([]);
      assertClean(answer);
      vi.unstubAllGlobals();
    }
  });

  test("a create's proposal carries issueKey ''", async () => {
    stubJiraFetch((request) => fakeJiraAnswer(request));
    const answer = proposalOf(
      await host().host.prepare(JIRA, { items: [CREATE] }, client().caller),
    );
    expect(answer.items).toMatchObject([{ operation: "create", issueKey: "" }]);
  });

  test("answers the Confluence prepare's items", async () => {
    const reference = await (async () => {
      stubConfluenceWriteFetch();
      try {
        return (
          await buildConfluenceMutationItems(
            confluenceConfigOf(FAKE),
            [{ page: "123", body: "Added" }],
            {},
          )
        ).items;
      } finally {
        vi.unstubAllGlobals();
      }
    })();
    const seen = stubConfluenceWriteFetch();
    const answer = proposalOf(
      await host().host.prepare(
        CONFLUENCE,
        { items: [{ page: "123", body: "Added" }] },
        client().caller,
      ),
    );
    expect(answer.items).toEqual(reference);
    expect(checkConfluencePageItems(answer.items)).toBe(true);
    expect(seen.filter((request) => request.method !== "GET")).toEqual([]);
  });

  test("Confluence's gate refuses before the credential, with no request", async () => {
    const cases: Array<
      [unknown, string, { page: boolean; attachment: boolean }]
    > = [
      [
        { operation: "uploadAttachment", page: "123", sourcePath: "/x" },
        UPLOAD_UNAVAILABLE,
        { page: true, attachment: true },
      ],
      [
        { operation: "deleteAttachment", attachmentId: "att1" },
        ATTACHMENT_DELETE_OFF,
        { page: true, attachment: false },
      ],
    ];
    for (const [item, message, deletes] of cases) {
      const seen = stubConfluenceWriteFetch();
      const { caller, reads } = client();
      expect(
        await host(deletes).host.prepare(CONFLUENCE, { items: [item] }, caller),
      ).toEqual({ ok: false, code: "tool_error", message });
      expect(reads()).toBe(0);
      expect(seen).toEqual([]);
      vi.unstubAllGlobals();
    }
  });

  test("a schema refusal reads nothing", async () => {
    const { caller, reads } = client();
    const answer = await host().host.prepare(JIRA, { items: "x" }, caller);
    expect(answer).toMatchObject({ ok: false, code: "invalid_params" });
    expect(reads()).toBe(0);
  });

  test("items over PROPOSAL_MAX_BYTES answer PROPOSAL_TOO_LARGE", async () => {
    stubJiraFetch((request) => fakeJiraAnswer(request));
    const answer = await host().host.prepare(
      JIRA,
      { items: [{ issue: "STAR-1", description: "x".repeat(1_100_000) }] },
      client().caller,
    );
    expect(answer).toEqual({
      ok: false,
      code: "tool_error",
      message: PROPOSAL_TOO_LARGE,
    });
  });

  test("O2: an upstream body marker reaches no answer field and no log line", async () => {
    const MARKER = "BODY-MARKER-4XX-PREPARE";
    for (const status of [400, 404, 500]) {
      stubJiraFetch((request) =>
        request.method === "GET" && request.path.includes("STAR-9")
          ? json({ errorMessages: [MARKER], errors: { x: MARKER } }, status)
          : fakeJiraAnswer(request),
      );
      const { host: real, lines } = host();
      const answer = await real.prepare(
        JIRA,
        { items: [{ issue: "STAR-9", summary: "x" }] },
        client().caller,
      );
      expect(answer).toMatchObject({ ok: false, code: "tool_error" });
      expect(JSON.stringify(answer)).not.toContain(MARKER);
      expect(answer.ok ? "" : answer.message).toMatch(/Nothing was written/);
      expect(lines.join("\n")).not.toContain(MARKER);
      expect(lines.join("\n")).not.toContain("STAR-9");
      vi.unstubAllGlobals();
    }
  });

  test("a prepare read that hangs ends at PREPARE_DEADLINE_MS; a cancel ends it as cancelled", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    stubJiraFetch((request) => pendingUntilAbort(request));
    const pending = host().host.prepare(
      JIRA,
      { items: [EDIT] },
      client().caller,
    );
    await vi.advanceTimersByTimeAsync(30_000);
    expect(await pending).toEqual({
      ok: false,
      code: "timeout",
      message:
        "Preparing the changes took too long; nothing was written. Send fewer items.",
    });
    vi.useRealTimers();

    const cancel = new AbortController();
    const seen = stubJiraFetch((request) => {
      cancel.abort();
      return pendingUntilAbort(request);
    });
    const answer = await host().host.prepare(
      JIRA,
      { items: [EDIT] },
      client({ signal: cancel.signal }).caller,
    );
    expect(answer).toEqual({
      ok: false,
      code: "cancelled",
      message: "The call was cancelled; nothing was written.",
    });
    expect(seen.filter(isWrite)).toEqual([]);
  });
});

/** Prepares `items` on the fake Jira; answers the proposal's items. */
async function preparedJira(
  items: unknown[],
  credential?: string,
): Promise<JiraIssueMutationItemDisplay[]> {
  stubJiraFetch((request) => fakeJiraAnswer(request));
  try {
    const answer = proposalOf(
      await host().host.prepare(
        JIRA,
        { items },
        client(credential === undefined ? {} : { credential }).caller,
      ),
    );
    return answer.items as JiraIssueMutationItemDisplay[];
  } finally {
    vi.unstubAllGlobals();
  }
}

describe("tools.apply refusals: effects none, no request", () => {
  test("SITE_CHANGED, then the closed check, each after the credential", async () => {
    const [edit] = await preparedJira([EDIT]);
    const cases: Array<[string, unknown, string, string]> = [
      ["another site", [edit], SITE_CHANGED, "tool_error"],
      ["a stray key", [{ ...edit, extra: 1 }], ITEMS_INVALID, "invalid_params"],
      [
        "a result field",
        [{ ...edit, error: "x" }],
        ITEMS_INVALID,
        "invalid_params",
      ],
      ["no item", [], ITEMS_INVALID, "invalid_params"],
      ["11 items", Array(11).fill(edit), ITEMS_INVALID, "invalid_params"],
      [
        "items over PROPOSAL_MAX_BYTES",
        [{ ...edit, summary: "x".repeat(1_048_600) }],
        ITEMS_INVALID,
        "invalid_params",
      ],
    ];
    for (const [name, items, message, code] of cases) {
      const seen = stubJiraFetch();
      const { caller, reads } = client();
      const site = name === "another site" ? "other.atlassian.net" : FAKE.site;
      const answer = await host().host.apply(
        JIRA,
        { site, items: items as unknown[] },
        caller,
      );
      expect(answer, name).toEqual({
        ok: false,
        code,
        message,
        effects: "none",
      });
      expect(reads(), name).toBe(1);
      expect(seen, name).toEqual([]);
      vi.unstubAllGlobals();
    }
  });

  test("Confluence's gate refuses approved items before the credential", async () => {
    const seen = stubConfluenceWriteFetch();
    const { caller, reads } = client();
    const answer = await host({ page: true, attachment: false }).host.apply(
      CONFLUENCE,
      {
        site: FAKE.site,
        items: [{ clientId: "c", operation: "deleteAttachment" }],
      },
      caller,
    );
    expect(answer).toEqual({
      ok: false,
      code: "tool_error",
      message: ATTACHMENT_DELETE_OFF,
      effects: "none",
    });
    expect(reads()).toBe(0);
    expect(seen).toEqual([]);
  });
});

describe("tools.apply results and effects", () => {
  test("a create with an ordinary key: records merge onto the card as the local apply leaves it", async () => {
    const items = await preparedJira([CREATE, EDIT]);
    const seen = stubJiraFetch((request) => fakeJiraAnswer(request));
    const answer = await host().host.apply(
      JIRA,
      { site: FAKE.site, items: structuredClone(items) },
      client().caller,
    );
    const create = seen.find(
      (request) =>
        request.method === "POST" && request.path === "/rest/api/3/issue",
    );
    expect(create).toBeDefined();
    expect(answer).toMatchObject({ ok: true, effects: "possible" });
    const records = resultsOf<JiraResultRecord>(answer);
    expect(records.map((record) => record.effects)).toEqual([
      "possible",
      "possible",
    ]);
    expect(records[0]).toMatchObject({
      resultIssueKey: "STAR-200",
      createdIssueKey: "STAR-200",
      resultIssueUrl: "https://acme.atlassian.net/browse/STAR-200",
    });
    const cards = structuredClone(items);
    records.forEach((record, index) => {
      expect(checkJiraResult(record, items[index]!, FAKE.site)).toBe(true);
      mergeJiraResult(cards[index]!, record, false);
    });
    expect(cards[0]).toMatchObject({ issueKey: "STAR-200" });
    assertClean(answer);
  });

  test("every write refused: a success whose records carry errors, each possible", async () => {
    const items = await preparedJira([EDIT, COMMENT]);
    stubJiraFetch((request) =>
      isWrite(request)
        ? json({ errorMessages: ["Refused"] }, 400)
        : fakeJiraAnswer(request),
    );
    const answer = await host().host.apply(
      JIRA,
      { site: FAKE.site, items },
      client().caller,
    );
    expect(answer).toMatchObject({ ok: true, effects: "possible" });
    const records = resultsOf<JiraResultRecord>(answer);
    expect(
      records.map((record) => [record.effects, typeof record.error]),
    ).toEqual([
      ["possible", "string"],
      ["possible", "string"],
    ]);
  });

  test("the deadline during item 1's write: timeout, item 1 possible, item 2 none", async () => {
    const items = await preparedJira([EDIT, COMMENT]);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const seen = stubJiraFetch((request) =>
      isWrite(request) ? pendingUntilAbort(request) : fakeJiraAnswer(request),
    );
    const pending = host().host.apply(
      JIRA,
      { site: FAKE.site, items },
      client().caller,
    );
    await vi.advanceTimersByTimeAsync(45_000);
    expect(await pending).toEqual({
      ok: false,
      code: "timeout",
      message: WRITE_TIMEOUT,
      effects: "possible",
      itemEffects: ["possible", "none"],
    });
    expect(seen.filter(isWrite)).toHaveLength(1);
  });

  test("O1: a cancel during item 1's first link request lets item 1 finish and stops item 2", async () => {
    const items = await preparedJira([LINKED_EDIT, COMMENT]);
    const cancel = new AbortController();
    const seen = stubJiraFetch(async (request: SeenJiraRequest) => {
      if (
        request.method === "POST" &&
        request.path === "/rest/api/3/issueLink"
      ) {
        cancel.abort();
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      return fakeJiraAnswer(request);
    });
    const answer = await host().host.apply(
      JIRA,
      { site: FAKE.site, items },
      client({ signal: cancel.signal }).caller,
    );
    const writes = seen.filter(isWrite);
    expect(
      writes.map((request) => `${request.method} ${request.path}`),
    ).toEqual([
      "POST /rest/api/3/issueLink",
      "DELETE /rest/api/3/issueLink/9001",
      "PUT /rest/api/3/issue/STAR-1",
    ]);
    for (const request of writes) expect(request.signal?.aborted).toBe(false);
    expect(answer).toMatchObject({ ok: true, effects: "possible" });
    const records = resultsOf<JiraResultRecord>(answer);
    expect(records[0]).toMatchObject({ effects: "possible" });
    expect(records[0]!.error).toBeUndefined();
    expect(records[1]).toEqual({ effects: "none", error: STOPPED });
  });

  test("a cancel before apply starts stops every item: effects none", async () => {
    const items = await preparedJira([EDIT, COMMENT]);
    const cancel = new AbortController();
    cancel.abort();
    const seen = stubJiraFetch((request) => fakeJiraAnswer(request));
    const answer = await host().host.apply(
      JIRA,
      { site: FAKE.site, items },
      client({ signal: cancel.signal }).caller,
    );
    expect(answer).toMatchObject({ ok: true, effects: "none" });
    expect(resultsOf<JiraResultRecord>(answer)).toEqual([
      { effects: "none", error: STOPPED },
      { effects: "none", error: STOPPED },
    ]);
    expect(seen.filter(isWrite)).toEqual([]);
  });
});

describe("v03 secret fixtures through tools.apply", () => {
  test("a created key equal to the token: resultIssueKey null, the card keeps issueKey '', no link", async () => {
    const credential = { ...FAKE, token: "TOKENKEY-123456" };
    const encoded = encodeAtlassianCredential(credential);
    const items = await preparedJira([CREATE], encoded);
    stubJiraFetch((request) =>
      fakeJiraAnswer(request, { createdKey: "TOKENKEY-123456" }),
    );
    const answer = await host().host.apply(
      JIRA,
      { site: FAKE.site, items },
      client({ credential: encoded }).caller,
    );
    const [record] = resultsOf<JiraResultRecord>(answer);
    expect(record).toEqual({ effects: "possible", resultIssueKey: null });
    const card = structuredClone(items[0]!);
    expect(checkJiraResult(record!, items[0]!, FAKE.site)).toBe(true);
    mergeJiraResult(card, record!, false);
    expect(card.issueKey).toBe("");
    expect(card.resultIssueKey).toBeNull();
    expect(card.resultIssueUrl).toBeUndefined();
    assertClean(answer, credential);
  });

  test("a rank order holding a key-shaped token is left out whole", async () => {
    const accessToken = "OAUTHKEY-98765432";
    const encoded = JSON.stringify({
      kind: "atlassian-oauth",
      site: FAKE.site,
      cloudId: FAKE_CLOUD_ID,
      accessToken,
      expiresAt: Date.now() + 600_000,
    });
    const items = await preparedJira([RANK], encoded);
    let ranked = false;
    stubJiraFetch((request) => {
      if (
        request.method === "PUT" &&
        request.path === "/rest/agile/1.0/issue/rank"
      )
        ranked = true;
      if (ranked && request.path === "/rest/api/3/search/jql")
        return json({
          issues: [{ key: "STAR-2" }, { key: accessToken }, { key: "STAR-1" }],
        });
      return fakeJiraAnswer(request);
    });
    const answer = await host().host.apply(
      JIRA,
      { site: FAKE.site, items },
      client({ credential: encoded }).caller,
    );
    const [record] = resultsOf<JiraResultRecord>(answer);
    expect(record!.rankResultOrder).toBeUndefined();
    expect(record!.rankSteps).toBeDefined();
    assertClean(answer, { accessToken });
  });

  test("a Confluence attachment delete answers resultId att1", async () => {
    stubConfluenceWriteFetch();
    const prepared = proposalOf(
      await host().host.prepare(
        CONFLUENCE,
        { items: [{ operation: "deleteAttachment", attachmentId: "att1" }] },
        client().caller,
      ),
    );
    vi.unstubAllGlobals();
    const items = prepared.items as ConfluencePageMutationItemDisplay[];
    stubConfluenceWriteFetch();
    const answer = await host().host.apply(
      CONFLUENCE,
      { site: FAKE.site, items },
      client().caller,
    );
    const [record] = resultsOf<ConfluenceResultRecord>(answer);
    expect(record!.attachment).toMatchObject({ resultId: "att1" });
    expect(checkConfluenceResult(record!, items[0]!, FAKE.site)).toBe(true);
    const card = structuredClone(items[0]!);
    mergeConfluenceResult(card, record!);
    expect(card.attachment?.resultId).toBe("att1");
    assertClean(answer);
  });

  test("a created page id equal to a 16-digit token: resultPageId null, no link", async () => {
    const accessToken = "1234567890123456";
    const encoded = JSON.stringify({
      kind: "atlassian-oauth",
      site: FAKE.site,
      cloudId: FAKE_CLOUD_ID,
      accessToken,
      expiresAt: Date.now() + 600_000,
    });
    const create = {
      operation: "create",
      spaceKey: "ENG",
      title: "New page",
      body: "Hello",
    };
    stubConfluenceWriteFetch();
    const prepared = proposalOf(
      await host().host.prepare(
        CONFLUENCE,
        { items: [create] },
        client({ credential: encoded }).caller,
      ),
    );
    vi.unstubAllGlobals();
    const seen: SeenConfluenceWrite[] = stubConfluenceWriteFetch(undefined, {
      createdId: accessToken,
    });
    const answer = await host().host.apply(
      CONFLUENCE,
      { site: FAKE.site, items: prepared.items },
      client({ credential: encoded }).caller,
    );
    const [record] = resultsOf<ConfluenceResultRecord>(answer);
    expect(record!.resultPageId).toBeNull();
    expect(record!.resultPageUrl).toBeUndefined();
    expect(seen.some((request) => request.method === "POST")).toBe(true);
    assertClean(answer, { accessToken });
  });
});
