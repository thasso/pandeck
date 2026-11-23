/**
 * The `jira_mutate_issue` result contract (Task-1463 P6a, P6-F1). The
 * completeness cases run the REAL shared prepare and apply against the fake
 * Jira (`test/jiraMutateFetch.ts`) and check that apply changes nothing but
 * the contract's result fields, that every result field is reached, and that
 * merging the record onto the sent item rebuilds the applied one. The
 * remaining cases pin vetting, the record check, the merge and the shrink
 * stages on hand-made items. Every value is fake.
 *
 * Not yet asserted here (M2): the effects ledger; every record carries
 * `possible` as a placeholder.
 */
import { afterEach, describe, expect, test, vi } from "vitest";
import type { JiraIssueMutationItemDisplay } from "@assistant/shared/jiraMutation";
import { errorText } from "./errors.ts";
import type { JiraConfig } from "./jiraClient.ts";
import {
  buildFieldMap,
  fetchJiraFields,
  fetchJiraIssueLinkTypes,
} from "./jiraFields.ts";
import {
  buildJiraMutationItems,
  type JiraMutationParams,
} from "./jiraMutate.ts";
import { applyJiraMutationItems } from "./jiraMutateApply.ts";
import { checkJiraIssueItems } from "./jiraMutationCheck.ts";
import { JiraMutationError } from "./jiraMutationErrors.ts";
import {
  JIRA_RESULT_FIELDS,
  buildJiraResultRecord,
  checkJiraResult,
  jiraProposalOf,
  mergeJiraResult,
  shrinkJiraResults,
  type JiraResultRecord,
} from "./jiraMutationResult.ts";
import {
  ERROR_FALLBACK,
  ITEM_ERROR_MAX,
  ITEM_WARNING_MAX,
  NESTED_ERROR_OMITTED,
  SHRUNK_NESTED_ERROR_MAX,
  WARNING_FALLBACK,
} from "./mutationResultCodec.ts";
import {
  json,
  stubJiraFetch,
  type SeenJiraRequest,
} from "./test/jiraEdgeFetch.ts";
import {
  fakeJiraAnswer,
  type FakeJiraOptions,
} from "./test/jiraMutateFetch.ts";
import {
  REDACTED,
  SENTINEL,
  SITE,
  changedPaths,
  fakeVetting,
  wire,
} from "./test/mutationResultHarness.ts";

const config: JiraConfig = {
  jiraHost: SITE,
  atlassianEmail: "me@x.test",
  atlassianToken: "FAKE-TOKEN",
};
const BROWSE = `https://${SITE}/browse`;

afterEach(() => {
  vi.unstubAllGlobals();
});

type Input = NonNullable<JiraMutationParams["items"]>;

interface RunOptions {
  answer?: (request: SeenJiraRequest) => Response | undefined;
  fake?: FakeJiraOptions;
  stopBefore?: () => string | undefined;
}

/** Prepare and apply `input` against the fake Jira: the sent and applied items. */
async function run(
  input: unknown[],
  options: RunOptions = {},
): Promise<{
  sent: JiraIssueMutationItemDisplay[];
  applied: JiraIssueMutationItemDisplay[];
}> {
  stubJiraFetch(
    (request) =>
      options.answer?.(request) ?? fakeJiraAnswer(request, options.fake),
  );
  let map: ReturnType<typeof buildFieldMap> | undefined;
  const fieldMap = async () =>
    (map ??= buildFieldMap({
      fetchedAt: 0,
      fields: await fetchJiraFields(config),
    }));
  const prepared = await buildJiraMutationItems(config, input as Input, {
    fieldMap,
    issueLinkTypes: () => fetchJiraIssueLinkTypes(config),
    describeError: errorText,
    matchesHttpStatus: (err, statuses) =>
      new RegExp(`HTTP (?:${statuses.join("|")})\\b`).test(errorText(err)),
  });
  const sent = wire(prepared.items);
  const applied = wire(sent);
  try {
    await applyJiraMutationItems(config, applied, {
      fieldMap,
      describeError: errorText,
      ...(options.stopBefore ? { stopBefore: options.stopBefore } : {}),
    });
  } catch (err) {
    if (!(err instanceof JiraMutationError)) throw err;
  }
  return { sent, applied: wire(applied) };
}

/** Every path a pure result field occupies. */
const RESULT_PATHS = new Set<string>([
  ...JIRA_RESULT_FIELDS.item,
  ...JIRA_RESULT_FIELDS.linkChanges.map((key) => `linkChanges[].${key}`),
  ...JIRA_RESULT_FIELDS.rankSteps.map((key) => `rankSteps[].${key}`),
  ...JIRA_RESULT_FIELDS.sprint.map((key) => `sprint.${key}`),
]);

/** A changed path as the table names it: a sprint result's parts as the result. */
const tablePath = (path: string) =>
  path.startsWith("sprint.result") ? "sprint.result" : path;

const reached = new Set<string>();

/**
 * The contract's checks on one prepared and applied batch: the proposal
 * passes the closed check; apply changes only result fields, and `issueKey`
 * only on a keyless create; `proposalOf` undoes apply; and a vetted,
 * checked, wired record merged onto the sent item rebuilds the applied one.
 */
function expectContract(
  sent: JiraIssueMutationItemDisplay[],
  applied: JiraIssueMutationItemDisplay[],
): void {
  expect(checkJiraIssueItems(wire(sent))).toBe(true);
  for (const [index, item] of applied.entries()) {
    const before = sent[index]!;
    const keyless = before.operation === "create" && before.issueKey === "";
    for (const path of changedPaths(before, item).map(tablePath)) {
      reached.add(path);
      if (path === "issueKey") expect(keyless).toBe(true);
      else expect(RESULT_PATHS, path).toContain(path);
    }
    expect(jiraProposalOf(item)).toEqual({
      ...before,
      issueKey: item.issueKey,
    });
    const record = wire(
      buildJiraResultRecord(item, before, fakeVetting, "possible"),
    );
    expect(checkJiraResult(record, before, SITE)).toBe(true);
    const card = wire(before);
    mergeJiraResult(card, record, false);
    expect(card).toEqual(item);
  }
}

const EDIT = {
  issue: "STAR-1",
  summary: "New summary",
  description: "# Heading\n\nBody with **bold**.",
  labels: { add: ["x"], remove: ["old"] },
  fields: { "Story Points": 3 },
};
const TRANSITION = { issue: "STAR-1", transitionName: "Done" };
const LINKS = {
  issue: "STAR-1",
  linkChanges: [
    { op: "add", type: "Blocks", direction: "outward", issue: "STAR-2" },
    { op: "remove", linkId: "9001" },
  ],
};
const CREATE = {
  operation: "create",
  projectKey: "STAR",
  issueType: "Task",
  summary: "A new task",
  description: "Some *Markdown*.",
  parentIssue: "STAR-1",
};
const COMMENT = {
  operation: "comment",
  issue: "STAR-1",
  commentBody: "Hello **there**.",
};
const RANK = {
  operation: "rank",
  rankIssues: ["STAR-2", "STAR-3"],
  rankPosition: "before",
  rankTargetIssue: "STAR-1",
};
const RANK_TOP = {
  operation: "rank",
  rankIssues: ["STAR-2"],
  rankPosition: "top",
  rankBoardId: 7,
};
const SPRINT = {
  operation: "sprint",
  sprintId: 5,
  sprintName: "Sprint 5b",
  sprintGoal: "Ship it",
};

const status400 = (message = "Bad request") =>
  json({ errorMessages: [message] }, 400);
const isLinkAdd = (request: SeenJiraRequest) =>
  request.method === "POST" && request.path === "/rest/api/3/issueLink";
const isRankWrite = (request: SeenJiraRequest) =>
  request.method === "PUT" && request.path === "/rest/agile/1.0/issue/rank";
const isSearch = (request: SeenJiraRequest) =>
  request.path === "/rest/api/3/search/jql";
const isSprintWrite = (request: SeenJiraRequest) =>
  request.method === "POST" &&
  /^\/rest\/agile\/1\.0\/sprint\//.test(request.path);
const isWriteRequest = (request: SeenJiraRequest) =>
  request.method !== "GET" && !isSearch(request);

describe("completeness: apply changes only the contract's result fields", () => {
  test("every operation succeeds", async () => {
    const { sent, applied } = await run([
      EDIT,
      TRANSITION,
      LINKS,
      CREATE,
      COMMENT,
      RANK,
      RANK_TOP,
      SPRINT,
    ]);
    expect(applied.map((item) => item.error)).toEqual(Array(8).fill(undefined));
    expect(applied[3]).toMatchObject({
      issueKey: "STAR-200",
      resultIssueKey: "STAR-200",
    });
    expect(applied[5]!.rankResultOrder).toBeDefined();
    expect(applied[7]!.sprint?.result).toBeDefined();
    expectContract(sent, applied);
  });

  test("a failed link: an edit's error and a created issue's warning", async () => {
    const { sent, applied } = await run(
      [LINKS, { ...CREATE, linkChanges: LINKS.linkChanges }],
      { answer: (request) => (isLinkAdd(request) ? status400() : undefined) },
    );
    expect(applied[0]!.error).toBeDefined();
    expect(applied[0]!.linkChanges?.[0]).toMatchObject({ resultOk: false });
    expect(applied[1]!.warning).toMatch(/^Issue created, but/);
    expectContract(sent, applied);
  });

  test("a failed rank step, its order still observed", async () => {
    const { sent, applied } = await run([RANK], {
      answer: (request) => (isRankWrite(request) ? status400() : undefined),
    });
    expect(applied[0]!.error).toBeDefined();
    expect(applied[0]!.rankSteps?.[0]).toMatchObject({ resultOk: false });
    expect(applied[0]!.rankResultOrder).toBeDefined();
    expectContract(sent, applied);
  });

  test("a rank whose order cannot be observed", async () => {
    // Prepare searches too; only apply's read-back after the rank fails.
    let ranked = false;
    const { sent, applied } = await run([RANK], {
      answer: (request) => {
        if (isRankWrite(request)) ranked = true;
        return isSearch(request) && ranked ? status400() : undefined;
      },
    });
    expect(applied[0]!.error).toBeUndefined();
    expect(applied[0]!.rankResultOrder).toBeUndefined();
    expectContract(sent, applied);
  });

  test("a sprint Jira partly or wholly ignores", async () => {
    const { sent, applied } = await run(
      [SPRINT, { operation: "sprint", sprintId: 6, sprintName: "Renamed" }],
      {
        // Jira answers the sprint unchanged: the goal lands only for sprint 5.
        answer: (request) => {
          if (!isSprintWrite(request)) return undefined;
          const id = Number(request.path.split("/").pop());
          return json({
            id,
            name: `Sprint ${id}`,
            state: "future",
            startDate: "2026-11-23T09:00:00.000Z",
            endDate: "2026-12-04T17:00:00.000Z",
            goal: id === 5 ? "Ship it" : "",
          });
        },
      },
    );
    expect(applied[0]!.warning).toMatch(/kept the sprint's/);
    expect(applied[0]!.error).toBeUndefined();
    expect(applied[1]!.error).toMatch(/kept the sprint's/);
    expect(applied[1]!.sprint?.result).toBeDefined();
    expectContract(sent, applied);
  });

  test("a stop before the first item", async () => {
    const { sent, applied } = await run([EDIT, CREATE], {
      stopBefore: () => "Stopped.",
    });
    expect(applied.map((item) => item.error)).toEqual(["Stopped.", "Stopped."]);
    expectContract(sent, applied);
  });

  test("every write fails", async () => {
    const { sent, applied } = await run([EDIT, CREATE, COMMENT, SPRINT], {
      answer: (request) =>
        isWriteRequest(request) ? status400("Refused") : undefined,
    });
    expect(applied.every((item) => item.error !== undefined)).toBe(true);
    expectContract(sent, applied);
  });

  test("the cases reach every result field, and issueKey", () => {
    expect([...reached].sort()).toEqual([...RESULT_PATHS, "issueKey"].sort());
  });
});

function item(
  overrides: Partial<JiraIssueMutationItemDisplay> = {},
): JiraIssueMutationItemDisplay {
  return {
    clientId: "item-1",
    issueKey: "STAR-1",
    operation: "edit",
    fieldChanges: [],
    ...overrides,
  };
}

const createItem = (overrides: Partial<JiraIssueMutationItemDisplay> = {}) =>
  item({
    operation: "create",
    issueKey: "",
    createProjectKey: "STAR",
    createIssueType: "Task",
    createSummary: "New",
    ...overrides,
  });

const link = (overrides = {}) => ({
  op: "add" as const,
  type: "Blocks",
  direction: "outward" as const,
  relationship: "blocks",
  targetIssueKey: "STAR-2",
  ...overrides,
});

const step = (overrides = {}) => ({
  issueKey: "STAR-2",
  placement: "before" as const,
  relativeToIssueKey: "STAR-1",
  ...overrides,
});

const sprintItem = (overrides: Partial<JiraIssueMutationItemDisplay> = {}) =>
  item({
    operation: "sprint",
    issueKey: "",
    sprint: {
      sprintId: 5,
      name: "Sprint 5",
      state: "future",
      changes: [{ field: "name", from: "Sprint 5", to: "Sprint 5b" }],
    },
    ...overrides,
  });

const build = (
  applied: JiraIssueMutationItemDisplay,
  sent: JiraIssueMutationItemDisplay = jiraProposalOf(applied),
) => buildJiraResultRecord(applied, sent, fakeVetting, "possible");

describe("buildJiraResultRecord vets every result on its raw value (A1)", () => {
  test("a created key holding the secret is null, sets no key, and backs no link", () => {
    const sent = createItem();
    const record = build(
      {
        ...sent,
        issueKey: `STAR-${SENTINEL}`,
        resultIssueKey: `STAR-${SENTINEL}`,
        resultIssueUrl: `${BROWSE}/STAR-${SENTINEL}`,
      },
      sent,
    );
    expect(record).toEqual({ effects: "possible", resultIssueKey: null });
  });

  test("an unsafe created key never falls back to the sent key for its link", () => {
    const sent = createItem({ issueKey: "" });
    const record = build(
      {
        ...sent,
        issueKey: "bad key",
        resultIssueKey: "bad key",
        resultIssueUrl: `${BROWSE}/`,
      },
      sent,
    );
    expect(record.resultIssueKey).toBeNull();
    expect(record.resultIssueUrl).toBeUndefined();
  });

  test("a clean create answers its key, created key and link", () => {
    const sent = createItem();
    expect(
      build(
        {
          ...sent,
          issueKey: "STAR-200",
          resultIssueKey: "STAR-200",
          resultIssueUrl: `${BROWSE}/STAR-200`,
        },
        sent,
      ),
    ).toEqual({
      effects: "possible",
      resultIssueKey: "STAR-200",
      createdIssueKey: "STAR-200",
      resultIssueUrl: `${BROWSE}/STAR-200`,
    });
  });

  test("a created key differing from the result key, or on a keyed item, is not sent", () => {
    const sent = createItem();
    expect(
      build({ ...sent, issueKey: "STAR-201", resultIssueKey: "STAR-200" }, sent)
        .createdIssueKey,
    ).toBeUndefined();
    const keyed = item({ resultIssueKey: "STAR-1" });
    expect(build(keyed).createdIssueKey).toBeUndefined();
  });

  test("an edit's link is backed by the sent key; one holding the secret, or off the site, is left out", () => {
    expect(
      build(item({ resultIssueUrl: `${BROWSE}/STAR-1` })).resultIssueUrl,
    ).toBe(`${BROWSE}/STAR-1`);
    for (const url of [
      `${BROWSE}/STAR-1?${SENTINEL}`,
      "https://evil.test/browse/STAR-1",
      `${BROWSE}/STAR-1 x`,
      `${BROWSE}/STAR-1"`,
      `${BROWSE}/STAR-1/${"x".repeat(300)}`,
      `${BROWSE}/STAR-2`,
    ])
      expect(build(item({ resultIssueUrl: url })), url).toEqual({
        effects: "possible",
      });
    const unsafeSent = item({ issueKey: SENTINEL });
    expect(
      build(
        { ...unsafeSent, resultIssueUrl: `${BROWSE}/${SENTINEL}` },
        unsafeSent,
      ),
    ).toEqual({ effects: "possible" });
  });

  test("a sprint's link is backed by its sprint id", () => {
    const url = `https://${SITE}/issues/?jql=sprint%20%3D%205`;
    expect(build(sprintItem({ resultIssueUrl: url })).resultIssueUrl).toBe(url);
  });

  test("texts are redacted and capped: warning 400, error 600, nested 300", () => {
    const record = build(
      item({
        warning: `${SENTINEL} ${"w".repeat(500)}`,
        error: "e".repeat(700),
        linkChanges: [link({ resultOk: false, error: "n".repeat(400) })],
        rankSteps: [step({ resultOk: false, error: `${SENTINEL}!` })],
      }),
    );
    expect(record.warning).toBe(
      `${REDACTED} ${"w".repeat(500)}`.slice(0, ITEM_WARNING_MAX),
    );
    expect(record.error).toBe("e".repeat(ITEM_ERROR_MAX));
    expect(record.linkChanges).toEqual({
      ok: "0",
      errors: [[0, "n".repeat(300)]],
    });
    expect(record.rankSteps).toEqual({
      ok: "0",
      errors: [[0, `${REDACTED}!`]],
    });
  });

  test("an empty text becomes its fallback", () => {
    const record = build(item({ warning: "", error: "" }));
    expect(record).toMatchObject({
      warning: WARNING_FALLBACK,
      error: ERROR_FALLBACK,
    });
  });

  test("nested results align with the sent arrays: absent ones as '-'", () => {
    const sent = item({ linkChanges: [link(), link(), link()] });
    const applied = wire(sent);
    applied.linkChanges![0]!.resultOk = true;
    applied.linkChanges![1]!.resultOk = false;
    applied.linkChanges![1]!.error = "no";
    expect(build(applied, sent).linkChanges).toEqual({
      ok: "10-",
      errors: [[1, "no"]],
    });
  });

  test("a rank order with any unsafe key is left out whole", () => {
    expect(
      build(item({ rankResultOrder: ["STAR-1", "STAR-2"] })).rankResultOrder,
    ).toEqual(["STAR-1", "STAR-2"]);
    expect(
      build(item({ rankResultOrder: ["STAR-1", `STAR-${SENTINEL}`] }))
        .rankResultOrder,
    ).toBeUndefined();
  });

  test("a sprint result with any unsafe part is left out whole", () => {
    const applied = sprintItem();
    const result = {
      name: "Sprint 5b",
      startDate: "2026-11-23T09:00:00.000Z",
      endDate: null,
    };
    applied.sprint!.result = result;
    expect(build(applied).sprintResult).toEqual(result);
    for (const bad of [
      { ...result, name: `Sprint ${SENTINEL}` },
      { ...result, name: "a\nb" },
      { ...result, name: "n".repeat(256) },
      { ...result, startDate: "tomorrow" },
    ]) {
      applied.sprint!.result = bad;
      expect(build(applied).sprintResult).toBeUndefined();
    }
  });
});

describe("checkJiraResult refuses what the edge must never send", () => {
  const sent = item({ linkChanges: [link()], rankSteps: [step(), step()] });
  const valid: JiraResultRecord = {
    effects: "none",
    linkChanges: { ok: "1", errors: [] },
    rankSteps: { ok: "0-", errors: [[0, "failed"]] },
  };

  test("a valid record passes", () => {
    expect(checkJiraResult(valid, sent, SITE)).toBe(true);
  });

  test.each<[string, unknown, JiraIssueMutationItemDisplay?]>([
    ["no effects", { ...valid, effects: undefined }],
    ["an unknown effects", { ...valid, effects: "maybe" }],
    ["an unknown key", { ...valid, issueKey: "STAR-1" }],
    ["a malformed result key", { ...valid, resultIssueKey: "star-1" }],
    ["a link off the site", { ...valid, resultIssueUrl: "https://x.test/a" }],
    ["a warning over 400", { ...valid, warning: "w".repeat(401) }],
    ["an error over 600", { ...valid, error: "e".repeat(601) }],
    ["a malformed rank order key", { ...valid, rankResultOrder: ["x"] }],
    ["link results missing", { ...valid, linkChanges: undefined }],
    [
      "link results too short",
      { ...valid, linkChanges: { ok: "", errors: [] } },
    ],
    ["a bad ok character", { ...valid, linkChanges: { ok: "x", errors: [] } }],
    [
      "an error index out of range",
      { ...valid, rankSteps: { ok: "0-", errors: [[2, "x"]] } },
    ],
    [
      "duplicate error indices",
      {
        ...valid,
        rankSteps: {
          ok: "00",
          errors: [
            [0, "x"],
            [0, "y"],
          ],
        },
      },
    ],
    [
      "descending error indices",
      {
        ...valid,
        rankSteps: {
          ok: "00",
          errors: [
            [1, "x"],
            [0, "y"],
          ],
        },
      },
    ],
    [
      "a nested error over 300",
      { ...valid, rankSteps: { ok: "0-", errors: [[0, "e".repeat(301)]] } },
    ],
    [
      "nested results for an array the item lacks",
      { effects: "none", linkChanges: { ok: "", errors: [] } },
      item(),
    ],
    [
      "a sprint result on a non-sprint item",
      {
        ...valid,
        sprintResult: { name: "S", startDate: null, endDate: null },
      },
    ],
    [
      "a created key on a keyed item",
      { ...valid, resultIssueKey: "STAR-1", createdIssueKey: "STAR-1" },
    ],
    [
      "a created key differing from the result key",
      {
        effects: "possible",
        resultIssueKey: "STAR-200",
        createdIssueKey: "STAR-201",
      },
      createItem(),
    ],
    [
      "a created key without a result key",
      { effects: "possible", createdIssueKey: "STAR-200" },
      createItem(),
    ],
  ])("%s", (_name, record, against = sent) => {
    expect(checkJiraResult(record, against, SITE)).toBe(false);
  });
});

describe("mergeJiraResult", () => {
  test("a re-run's record deletes the previous run's absent results", () => {
    const card = item({
      linkChanges: [link({ resultOk: false, error: "old" })],
      rankResultOrder: ["STAR-9"],
      resultIssueUrl: `${BROWSE}/STAR-1`,
      warning: "old warning",
      error: "old error",
    });
    mergeJiraResult(
      card,
      { effects: "possible", linkChanges: { ok: "1", errors: [] } },
      false,
    );
    expect(card).toEqual(item({ linkChanges: [link({ resultOk: true })] }));
  });

  test("a sprint item's stale result is deleted", () => {
    const card = sprintItem();
    card.sprint!.result = { name: "Old", startDate: null, endDate: null };
    mergeJiraResult(card, { effects: "none" }, false);
    expect(card).toEqual(sprintItem());
  });

  test("issueKey changes only on a keyless create, to its created key", () => {
    const keyed = item();
    mergeJiraResult(
      keyed,
      {
        effects: "possible",
        resultIssueKey: "STAR-1",
        createdIssueKey: "STAR-1",
      },
      false,
    );
    expect(keyed.issueKey).toBe("STAR-1");
    const create = createItem();
    mergeJiraResult(
      create,
      { effects: "possible", resultIssueKey: "STAR-200" },
      false,
    );
    expect(create.issueKey).toBe("");
    mergeJiraResult(
      create,
      {
        effects: "possible",
        resultIssueKey: "STAR-200",
        createdIssueKey: "STAR-200",
      },
      false,
    );
    expect(create.issueKey).toBe("STAR-200");
  });

  test("an emptied nested error reads as omitted only in a trimmed answer", () => {
    const record: JiraResultRecord = {
      effects: "possible",
      rankSteps: { ok: "0", errors: [[0, ""]] },
    };
    const trimmed = item({ rankSteps: [step()] });
    mergeJiraResult(trimmed, record, true);
    expect(trimmed.rankSteps![0]!.error).toBe(NESTED_ERROR_OMITTED);
    const whole = item({ rankSteps: [step()] });
    mergeJiraResult(whole, record, false);
    expect(whole.rankSteps![0]!.error).toBe("");
  });
});

describe("shrinkJiraResults", () => {
  const records = (): JiraResultRecord[] => [
    {
      effects: "possible",
      warning: "w".repeat(400),
      error: "e".repeat(600),
      rankResultOrder: ["STAR-1", "STAR-2"],
      linkChanges: { ok: "01", errors: [[0, "l".repeat(300)]] },
      rankSteps: { ok: "0-", errors: [[0, `${"r".repeat(200)}`]] },
    },
  ];

  test("an answer within its budget is not trimmed", () => {
    const shrunk = records();
    expect(shrinkJiraResults(shrunk, () => true, fakeVetting)).toBe(false);
    expect(shrunk).toEqual(records());
  });

  test("stage 1 cuts nested errors to 120 and stops once it fits", () => {
    const shrunk = records();
    let calls = 0;
    expect(shrinkJiraResults(shrunk, () => calls++ > 0, fakeVetting)).toBe(
      true,
    );
    expect(shrunk[0]!.linkChanges!.errors).toEqual([
      [0, "l".repeat(SHRUNK_NESTED_ERROR_MAX)],
    ]);
    expect(shrunk[0]!.rankResultOrder).toEqual(["STAR-1", "STAR-2"]);
  });

  test("every stage keeps ok characters, error presence, item texts and identifiers", () => {
    const shrunk = records();
    expect(shrinkJiraResults(shrunk, () => false, fakeVetting)).toBe(true);
    expect(shrunk).toEqual([
      {
        effects: "possible",
        warning: "w".repeat(400),
        error: "e".repeat(600),
        linkChanges: { ok: "01", errors: [[0, ""]] },
        rankSteps: { ok: "0-", errors: [[0, ""]] },
      },
    ]);
  });
});
