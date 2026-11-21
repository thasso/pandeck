/**
 * The shared Jira mutation core (Task-1463) at the Jira CLIENT SEAM: the
 * `jiraClient.ts` calls are mocked, so these tests see exactly which calls
 * prepare and apply make and with which arguments. Real transport (fetch,
 * `init.signal`, request counts) is covered in `jiraMutateTransport.test.ts`.
 */
import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, test, vi } from "vitest";
import type { JiraIssueMutationItemDisplay } from "@assistant/shared/jiraMutation";

vi.mock("./jiraClient.ts", async (importActual) => ({
  ...(await importActual<typeof import("./jiraClient.ts")>()),
  jiraGet: vi.fn(),
  jiraPost: vi.fn(),
  jiraPut: vi.fn(),
  jiraDelete: vi.fn(),
}));
vi.mock("./jiraFieldCache.ts", async (importActual) => ({
  ...(await importActual<typeof import("./jiraFieldCache.ts")>()),
  getJiraFieldMap: vi.fn(),
}));
vi.mock("./jiraIssueLinkTypeCache.ts", async (importActual) => ({
  ...(await importActual<typeof import("./jiraIssueLinkTypeCache.ts")>()),
  getJiraIssueLinkTypes: vi.fn(),
}));

import { AtlassianHttpError } from "./atlassian/atlassianFetch.ts";
import { errorText } from "./errors.ts";
import {
  jiraDelete,
  jiraGet,
  jiraPost,
  jiraPut,
  type JiraConfig,
} from "./jiraClient.ts";
import { getJiraFieldMap } from "./jiraFieldCache.ts";
import type { JiraFieldMap, JiraFieldMeta } from "./jiraFields.ts";
import { getJiraIssueLinkTypes } from "./jiraIssueLinkTypeCache.ts";
import { buildJiraMutationItems, type JiraMutationDeps } from "./jiraMutate.ts";
import {
  applyJiraMutationItems,
  type JiraApplyDeps,
} from "./jiraMutateApply.ts";
import { JiraMutationError, JiraWriteHttpError } from "./jiraMutationErrors.ts";
import { jiraMessageMatchesHttpStatus } from "./tools/jira/jiraTools.ts";

const config: JiraConfig = {
  jiraHost: "example.atlassian.net",
  atlassianEmail: "a@b.c",
  atlassianToken: "t",
};
const SEARCH = "/rest/api/3/search/jql";

const field = (id: string, name: string): JiraFieldMeta => ({
  id,
  name,
  custom: true,
});
const EPIC = field("customfield_10014", "Epic Link");
const POINTS = field("customfield_10004", "Story Points");
const FIELD_MAP: JiraFieldMap = {
  fetchedAt: 1,
  byId: new Map([
    [EPIC.id, EPIC],
    [POINTS.id, POINTS],
  ]),
  byNameLower: new Map([
    ["epic link", [EPIC]],
    ["story points", [POINTS]],
  ]),
};

/** What the mocked Jira answers to a read, by path. */
function jiraAnswer(path: string): unknown {
  if (path === "/rest/api/3/mypermissions")
    return {
      permissions: {
        ADD_COMMENTS: { havePermission: true },
        LINK_ISSUES: { havePermission: true },
        SCHEDULE_ISSUES: { havePermission: true },
      },
    };
  if (path === "/rest/api/3/issue/createmeta")
    return {
      projects: [
        {
          key: "OPS",
          issuetypes: [
            { name: "Task", fields: { description: { name: "Description" } } },
          ],
        },
      ],
    };
  if (path.endsWith("/editmeta"))
    return { fields: { summary: { name: "Summary" } } };
  if (path.endsWith("/transitions"))
    return { transitions: [{ id: "31", name: "Done", to: { name: "Done" } }] };
  if (/^\/rest\/agile\/1\.0\/board\/\d+\/project$/.test(path))
    return { values: [{ key: "NEB" }] };
  if (/^\/rest\/agile\/1\.0\/board\/\d+\/backlog$/.test(path))
    return { issues: [{ key: "NEB-9" }, { key: "NEB-2" }, { key: "NEB-3" }] };
  if (path.startsWith("/rest/agile/1.0/sprint/"))
    return {
      id: 5,
      name: "Sprint 5",
      state: "future",
      startDate: "2026-11-23T09:00:00.000Z",
      endDate: "2026-12-04T17:00:00.000Z",
    };
  const issue = /^\/rest\/api\/3\/issue\/([^/]+)$/.exec(path);
  if (issue) {
    const key = decodeURIComponent(issue[1]!);
    return {
      id: "100",
      key,
      fields: {
        summary: "Subject",
        status: { name: "Open" },
        project: { key: "NEB" },
        issuetype: { name: "Story", hierarchyLevel: 0 },
        ...(key === "NEB-1" ? {} : { parent: { key: "NEB-1" } }),
      },
    };
  }
  throw new Error(`unexpected GET ${path}`);
}

function prepareDeps(
  overrides: Partial<JiraMutationDeps> = {},
): JiraMutationDeps {
  return {
    fieldMap: vi.fn(async () => FIELD_MAP),
    issueLinkTypes: vi.fn(async () => [
      {
        id: "1010",
        name: "Blocks",
        inward: "is blocked by",
        outward: "blocks",
      },
    ]),
    describeError: errorText,
    matchesHttpStatus: jiraMessageMatchesHttpStatus,
    ...overrides,
  };
}

/** Like the edge will: fixed text, decided by status alone. */
function edgeLikeDeps(
  overrides: Partial<JiraMutationDeps> = {},
): JiraMutationDeps {
  return prepareDeps({
    describeError: () => "FIXED",
    matchesHttpStatus: (err, statuses) =>
      err instanceof AtlassianHttpError && statuses.includes(err.status),
    ...overrides,
  });
}

function applyDeps(overrides: Partial<JiraApplyDeps> = {}): JiraApplyDeps {
  return {
    fieldMap: vi.fn(async () => FIELD_MAP),
    describeError: errorText,
    ...overrides,
  };
}

function editItem(
  overrides: Partial<JiraIssueMutationItemDisplay> = {},
): JiraIssueMutationItemDisplay {
  return {
    clientId: "item-1",
    issueKey: "NEB-1",
    operation: "edit",
    issueUrl: "https://example.atlassian.net/browse/NEB-1",
    fieldChanges: [
      {
        fieldId: "summary",
        label: "Summary",
        to: "New",
        operation: "set",
        value: "New",
      },
    ],
    ...overrides,
  };
}

function rankItem(
  overrides: Partial<JiraIssueMutationItemDisplay> = {},
): JiraIssueMutationItemDisplay {
  return {
    clientId: "item-1",
    issueKey: "NEB-2",
    operation: "rank",
    fieldChanges: [],
    rankIssueKeys: ["NEB-2", "NEB-3"],
    rankPosition: "before",
    rankTargetIssueKey: "NEB-9",
    rankSteps: [
      { issueKey: "NEB-2", placement: "before", relativeToIssueKey: "NEB-9" },
      { issueKey: "NEB-3", placement: "after", relativeToIssueKey: "NEB-2" },
    ],
    ...overrides,
  };
}

const linkAdd = (target: string) => ({
  op: "add" as const,
  type: "Blocks",
  direction: "outward" as const,
  relationship: "blocks",
  targetIssueKey: target,
});

/** The reason the tests' callers abort with. */
const CALLER_GAVE_UP = new Error("caller gave up");

/** A call that aborts the controller while in flight and rejects with its reason. */
function abortingCall(controller: AbortController) {
  return async (): Promise<never> => {
    controller.abort(CALLER_GAVE_UP);
    throw controller.signal.reason;
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(jiraGet).mockImplementation(
    async (_config, path) => jiraAnswer(path) as never,
  );
  vi.mocked(jiraPost).mockImplementation(async (_config, path) => {
    if (path === SEARCH)
      return { issues: [{ key: "NEB-2" }, { key: "NEB-3" }] } as never;
    if (path === "/rest/api/3/issue") return { key: "OPS-5" } as never;
    return {} as never;
  });
  vi.mocked(jiraPut).mockImplementation(async () => ({}) as never);
  vi.mocked(jiraDelete).mockImplementation(async () => ({}) as never);
});

describe("injected seams (AC3, AC8)", () => {
  test("prepare and apply use the injected deps and touch no cache module", async () => {
    const userNames = vi.fn(async () => new Map([["acc-1", "Ada"]]));
    const deps = prepareDeps({ userNames });
    const { items } = await buildJiraMutationItems(
      config,
      [
        {
          issue: "NEB-1",
          epicIssue: "NEB-7",
          assigneeAccountId: "acc-1",
          fields: { "Story Points": 3 },
          linkChanges: [
            { op: "add", type: "Blocks", direction: "outward", issue: "NEB-2" },
          ],
        },
        {
          issue: "NEB-3",
          linkChanges: [
            { op: "add", type: "Blocks", direction: "inward", issue: "NEB-4" },
          ],
        },
      ],
      deps,
    );
    expect(deps.fieldMap).toHaveBeenCalledTimes(1);
    // Read at most once per prepare call, as the local cache path always was.
    expect(deps.issueLinkTypes).toHaveBeenCalledTimes(1);
    expect(userNames).toHaveBeenCalledWith(["acc-1"]);
    const assignee = items[0]!.fieldChanges.find(
      (change) => change.fieldId === "assignee",
    );
    // A display name only: the write still carries the account id.
    expect(assignee).toMatchObject({
      to: "Ada",
      value: { accountId: "acc-1" },
    });

    const apply = applyDeps();
    await applyJiraMutationItems(config, items, apply);
    expect(apply.fieldMap).toHaveBeenCalled();
    expect(vi.mocked(jiraPut).mock.calls[0]![2]).toMatchObject({
      fields: { [EPIC.id]: "NEB-7", [POINTS.id]: 3 },
    });
    expect(getJiraFieldMap).not.toHaveBeenCalled();
    expect(getJiraIssueLinkTypes).not.toHaveBeenCalled();
  });

  test("without a userNames dep, user-valued changes show the account id", async () => {
    const { items } = await buildJiraMutationItems(
      config,
      [{ issue: "NEB-1", assigneeAccountId: "acc-1" }],
      prepareDeps(),
    );
    expect(items[0]!.fieldChanges[0]).toMatchObject({
      to: "acc-1",
      value: { accountId: "acc-1" },
    });
  });

  test("a bearer config's browse URLs use the site host", async () => {
    const bearer: JiraConfig = {
      jiraHost: "castlabs.atlassian.net",
      cloudId: "cloud-1",
      bearerToken: "tok",
    };
    const { items } = await buildJiraMutationItems(
      bearer,
      [{ operation: "comment", issue: "neb-1", commentBody: "Hi" }],
      prepareDeps(),
    );
    expect(items[0]!.issueUrl).toBe(
      "https://castlabs.atlassian.net/browse/NEB-1",
    );
  });
});

describe("typed errors (AC4a)", () => {
  test("a rejected write is a JiraWriteHttpError and the row shows today's text", async () => {
    const message =
      'Jira API returned HTTP 400 for PUT /rest/api/3/issue/NEB-1: {"errors":{"summary":"too long"}}';
    vi.mocked(jiraPut).mockRejectedValueOnce(
      new AtlassianHttpError(message, 400, ["too long"]),
    );
    const seen: unknown[] = [];
    const items = [editItem()];
    const failure = applyJiraMutationItems(
      config,
      items,
      applyDeps({
        describeError: (err) => {
          seen.push(err);
          return errorText(err);
        },
      }),
    );
    await expect(failure).rejects.toThrow(JiraMutationError);
    await expect(failure).rejects.toThrow(
      `All 1 Jira change(s) failed: ${message}`,
    );
    expect(items[0]!.error).toBe(message);
    expect(seen[0]).toBeInstanceOf(JiraWriteHttpError);
    expect(seen[0]).toMatchObject({
      message,
      status: 400,
      reasons: ["too long"],
    });
  });

  test("the moved modules throw no plain Error of their own", () => {
    for (const file of [
      "jiraMutate.ts",
      "jiraMutateApply.ts",
      "jiraMutationErrors.ts",
      "jiraRank.ts",
      "jiraSprint.ts",
      "jiraPermissions.ts",
    ])
      expect(
        readFileSync(new URL(`./${file}`, import.meta.url), "utf8"),
        file,
      ).not.toMatch(/new Error\(/);
  });
});

describe("rank 207 entries (AC4b)", () => {
  test.each([
    {
      entries: [{ status: 400, errors: ["a"] }],
      message: "a",
      status: 400,
      reasons: ["a"],
    },
    {
      entries: [{ status: 401, errors: ["a"] }],
      message: "a",
      status: 401,
      reasons: undefined,
    },
    {
      entries: [{ status: 403, errors: ["a"] }],
      message: "a",
      status: 403,
      reasons: undefined,
    },
    {
      entries: [{ status: 503, errors: ["a"] }],
      message: "a",
      status: 503,
      reasons: undefined,
    },
    {
      entries: [
        { status: 400, errors: ["a"] },
        { status: 500, errors: ["b"] },
      ],
      message: "a; b",
      status: 500,
      reasons: undefined,
    },
    {
      entries: [
        { status: 400, errors: ["a"] },
        { status: 403, errors: ["b"] },
      ],
      message: "a; b",
      status: 403,
      reasons: undefined,
    },
    {
      entries: [{ status: 404 }],
      message: "HTTP 404",
      status: 404,
      reasons: undefined,
    },
  ])(
    "$entries.length entries, worst $status",
    async ({ entries, message, status, reasons }) => {
      vi.mocked(jiraPut).mockResolvedValueOnce({ entries } as never);
      const seen: unknown[] = [];
      const item = rankItem();
      await expect(
        applyJiraMutationItems(
          config,
          [item],
          applyDeps({
            describeError: (err) => {
              seen.push(err);
              return errorText(err);
            },
          }),
        ),
      ).rejects.toThrow(JiraMutationError);
      expect(item.rankSteps![0]!.error).toBe(message);
      expect(item.error).toBe(
        `Ranking NEB-2 before NEB-9 failed: ${message}. No rank operation was applied. Not attempted: NEB-3.`,
      );
      const err = seen[0] as JiraWriteHttpError;
      expect(err).toBeInstanceOf(JiraWriteHttpError);
      expect(err.message).toBe(message);
      expect(err.status).toBe(status);
      expect(err.reasons).toEqual(reasons);
    },
  );
});

describe("read-wrapping helpers (AC4c)", () => {
  const body404 = (path: string) =>
    new AtlassianHttpError(
      `Jira API returned HTTP 404 for GET ${path}: {"errorMessages":["secret body"]}`,
      404,
      ["secret body"],
    );
  const failGet = (match: RegExp, err: unknown) =>
    vi.mocked(jiraGet).mockImplementation(async (_config, path) => {
      if (match.test(path)) throw err;
      return jiraAnswer(path) as never;
    });
  const sprintInput = [
    { operation: "sprint" as const, sprintId: 5, sprintName: "New" },
  ];
  const rankInput = [
    {
      operation: "rank" as const,
      rankIssues: ["NEB-2"],
      rankPosition: "before",
      rankTargetIssue: "NEB-9",
    },
  ];
  const boardInput = [
    {
      operation: "rank" as const,
      rankIssues: ["NEB-2"],
      rankPosition: "top",
      rankBoardId: 7,
    },
  ];

  test("a sprint 404: local text quotes the error, edge text is fixed", async () => {
    const err = body404("/rest/agile/1.0/sprint/5");
    failGet(/\/sprint\/5$/, err);
    await expect(
      buildJiraMutationItems(config, sprintInput, prepareDeps()),
    ).rejects.toThrow(
      new JiraMutationError(
        `Jira sprint 5 could not be read: ${err.message} Find the sprint id with jira_lookup kind=sprints.`,
      ),
    );
    const edge = buildJiraMutationItems(config, sprintInput, edgeLikeDeps());
    await expect(edge).rejects.toBeInstanceOf(JiraMutationError);
    await expect(edge).rejects.toThrow(
      /^Jira sprint 5 could not be read: FIXED Find the sprint id with jira_lookup kind=sprints\.$/,
    );
  });

  test("a sprint 500 is rethrown as the same read error, not a write error", async () => {
    const err = new AtlassianHttpError(
      "Jira API returned HTTP 500 for GET",
      500,
    );
    failGet(/\/sprint\/5$/, err);
    for (const deps of [prepareDeps(), edgeLikeDeps()]) {
      const failure = buildJiraMutationItems(config, sprintInput, deps);
      await expect(failure).rejects.toBe(err);
      await expect(failure).rejects.not.toBeInstanceOf(JiraWriteHttpError);
    }
  });

  test("a rank issue 404: local quotes, edge fixed; a plain message is classified only locally", async () => {
    const err = body404("/rest/api/3/issue/NEB-2");
    failGet(/\/issue\/NEB-2$/, err);
    await expect(
      buildJiraMutationItems(config, rankInput, prepareDeps()),
    ).rejects.toThrow(
      `Jira issue NEB-2 could not be read for ranking: ${err.message}`,
    );
    await expect(
      buildJiraMutationItems(config, rankInput, edgeLikeDeps()),
    ).rejects.toThrow(
      /^Jira issue NEB-2 could not be read for ranking: FIXED$/,
    );

    // The local test stub's shape: a plain Error whose text says HTTP 404.
    const plain = new Error("proxy said HTTP 404");
    failGet(/\/issue\/NEB-2$/, plain);
    await expect(
      buildJiraMutationItems(config, rankInput, edgeLikeDeps()),
    ).rejects.toBe(plain);
    await expect(
      buildJiraMutationItems(config, rankInput, prepareDeps()),
    ).rejects.toThrow(
      new JiraMutationError(
        "Jira issue NEB-2 could not be read for ranking: proxy said HTTP 404",
      ),
    );
  });

  test("a board 403: local quotes, edge fixed", async () => {
    const err = new AtlassianHttpError(
      'Jira API returned HTTP 403 for GET /rest/agile/1.0/board/7/project: {"secret":1}',
      403,
    );
    failGet(/\/board\/7\/project$/, err);
    await expect(
      buildJiraMutationItems(config, boardInput, prepareDeps()),
    ).rejects.toThrow(
      `Jira board 7 could not be read: ${err.message} Use a board id you can see in Jira.`,
    );
    await expect(
      buildJiraMutationItems(config, boardInput, edgeLikeDeps()),
    ).rejects.toThrow(
      /^Jira board 7 could not be read: FIXED Use a board id you can see in Jira\.$/,
    );
  });

  test.each([
    { name: "sprint", input: sprintInput, path: /\/sprint\/5$/ },
    { name: "rank issue", input: rankInput, path: /\/issue\/NEB-2$/ },
    { name: "board", input: boardInput, path: /\/board\/7\/project$/ },
  ])("an abort in the $name read is never wrapped", async ({ input, path }) => {
    for (const make of [prepareDeps, edgeLikeDeps]) {
      const controller = new AbortController();
      // Its text even names a status the local matcher would wrap.
      const reason = new AtlassianHttpError("HTTP 404 while aborting", 404);
      vi.mocked(jiraGet).mockImplementation(async (_config, requested) => {
        if (path.test(requested)) {
          controller.abort(reason);
          throw controller.signal.reason;
        }
        return jiraAnswer(requested) as never;
      });
      await expect(
        buildJiraMutationItems(
          config,
          input,
          make({ signal: controller.signal }),
        ),
      ).rejects.toBe(reason);
    }
  });
});

describe("the local status matcher", () => {
  test.each([
    "Jira API returned HTTP 404 for GET /rest/api/3/issue/NEB-9: {}",
    "Jira API returned HTTP 403 for GET /x",
    "Jira API returned HTTP 400 for GET /x",
    "proxy said HTTP 404",
    "HTTP 4040",
    "HTTP 404x",
    "previously HTTP 400",
    "HTTP 401",
    "HTTP 500",
    "no status at all",
  ])("matches %j exactly as the regexes it replaces", (message) => {
    const err = new Error(message);
    expect(jiraMessageMatchesHttpStatus(err, [404, 403])).toBe(
      /HTTP 40(4|3)\b/.test(message),
    );
    expect(jiraMessageMatchesHttpStatus(err, [400, 403, 404])).toBe(
      /HTTP 40(0|3|4)\b/.test(message),
    );
  });
});

describe("call arguments (AC5a)", () => {
  test("without a signal, writes keep their exact argument lists", async () => {
    await applyJiraMutationItems(
      config,
      [
        editItem({
          linkChanges: [
            {
              ...linkAdd("NEB-2"),
              op: "remove",
              relationship: "unlink",
              linkId: "9001",
            },
          ],
        }),
      ],
      applyDeps(),
    );
    expect(vi.mocked(jiraPut).mock.calls[0]).toHaveLength(3);
    expect(vi.mocked(jiraDelete).mock.calls[0]).toEqual([
      config,
      "/rest/api/3/issueLink/9001",
    ]);
  });
});

describe("apply honours a signal (AC5b)", () => {
  test("an abort during the first link POST stops the link sequence", async () => {
    const controller = new AbortController();
    vi.mocked(jiraPost).mockImplementationOnce(abortingCall(controller));
    const item = editItem({
      fieldChanges: [],
      linkChanges: [
        linkAdd("NEB-2"),
        linkAdd("NEB-3"),
        {
          ...linkAdd("NEB-4"),
          op: "remove",
          relationship: "unlink",
          linkId: "9001",
        },
      ],
    });
    await expect(
      applyJiraMutationItems(
        config,
        [item],
        applyDeps({ signal: controller.signal }),
      ),
    ).rejects.toBe(CALLER_GAVE_UP);
    expect(jiraPost).toHaveBeenCalledTimes(1);
    expect(jiraDelete).not.toHaveBeenCalled();
    expect(item.linkChanges![0]!.error).toBeUndefined();
    expect(item.linkChanges![0]!.resultOk).toBeUndefined();
    expect(item.error).toBeUndefined();
  });

  test("an abort during a rank step sends no later step and no observation", async () => {
    const controller = new AbortController();
    vi.mocked(jiraPut).mockImplementationOnce(abortingCall(controller));
    const item = rankItem();
    await expect(
      applyJiraMutationItems(
        config,
        [item],
        applyDeps({ signal: controller.signal }),
      ),
    ).rejects.toBe(CALLER_GAVE_UP);
    expect(jiraPut).toHaveBeenCalledTimes(1);
    expect(jiraPost).not.toHaveBeenCalled();
    expect(jiraGet).not.toHaveBeenCalled();
    expect(item.rankSteps![0]!.error).toBeUndefined();
  });

  test("an abort during the rank observation read is not swallowed", async () => {
    const controller = new AbortController();
    vi.mocked(jiraPost).mockImplementationOnce(abortingCall(controller));
    const item = rankItem();
    await expect(
      applyJiraMutationItems(
        config,
        [item],
        applyDeps({ signal: controller.signal }),
      ),
    ).rejects.toBe(CALLER_GAVE_UP);
    expect(jiraPut).toHaveBeenCalledTimes(2);
    expect(item.rankResultOrder).toBeUndefined();
    expect(item.error).toBeUndefined();
  });

  test("without an abort, a failed observation read still leaves no order", async () => {
    vi.mocked(jiraPost).mockRejectedValueOnce(new Error("search down"));
    const item = rankItem({ rankResultOrder: ["stale"] });
    await expect(
      applyJiraMutationItems(
        config,
        [item],
        applyDeps({ signal: new AbortController().signal }),
      ),
    ).resolves.toMatchObject({ succeeded: 1 });
    expect(item.rankResultOrder).toBeUndefined();
  });

  test("every call in a mixed batch carries the signal", async () => {
    const { signal } = new AbortController();
    const items: JiraIssueMutationItemDisplay[] = [
      {
        clientId: "create",
        issueKey: "",
        operation: "create",
        createProjectKey: "OPS",
        createIssueType: "Task",
        createSummary: "New",
        fieldChanges: [],
        linkChanges: [linkAdd("NEB-2")],
      },
      {
        clientId: "comment",
        issueKey: "NEB-1",
        operation: "comment",
        commentBody: "Hi",
        fieldChanges: [],
      },
      editItem({
        clientId: "transition",
        targetTransitionId: "31",
        linkChanges: [
          linkAdd("NEB-3"),
          {
            ...linkAdd("NEB-4"),
            op: "remove",
            relationship: "unlink",
            linkId: "9001",
          },
        ],
      }),
      editItem({ clientId: "edit", issueKey: "NEB-5" }),
      rankItem({ rankScope: { kind: "board", boardId: 7, epics: false } }),
      rankItem({ clientId: "rank-search" }),
      {
        clientId: "sprint",
        issueKey: "",
        operation: "sprint",
        fieldChanges: [],
        sprint: {
          sprintId: 5,
          name: "Sprint 5",
          state: "future",
          changes: [{ field: "name", from: "Sprint 5", to: "Sprint 5" }],
        },
      },
    ];
    await applyJiraMutationItems(config, items, applyDeps({ signal }));
    expect(items.map((item) => item.error)).toEqual(items.map(() => undefined));
    const calls = {
      post: vi.mocked(jiraPost).mock.calls,
      put: vi.mocked(jiraPut).mock.calls,
      get: vi.mocked(jiraGet).mock.calls,
      delete: vi.mocked(jiraDelete).mock.calls,
    };
    // create, its link, comment, transition, link, rank observation, sprint
    expect(calls.post.length).toBeGreaterThanOrEqual(7);
    expect(calls.put.length).toBe(5);
    expect(calls.get.map((call) => call[1])).toEqual([
      "/rest/agile/1.0/board/7/backlog",
      "/rest/agile/1.0/sprint/5",
    ]);
    expect(calls.delete.length).toBe(1);
    for (const call of [...calls.post, ...calls.put])
      expect(call[4], call[1]).toMatchObject({ signal });
    for (const call of [...calls.get, ...calls.delete])
      expect(call[3], call[1]).toMatchObject({ signal });
    const search = calls.post.find((call) => call[1] === SEARCH)!;
    expect(search[4]).toEqual({ retry: true, signal });
  });
});

describe("prepare honours a signal (AC5c)", () => {
  test("every read reached from prepare carries the signal", async () => {
    const { signal } = new AbortController();
    await buildJiraMutationItems(
      config,
      [
        {
          operation: "create",
          projectKey: "OPS",
          issueType: "Task",
          summary: "New",
          description: "Body",
          linkChanges: [
            { op: "add", type: "Blocks", direction: "outward", issue: "NEB-2" },
          ],
        },
        {
          issue: "NEB-1",
          targetStatus: "Done",
          summary: "Renamed",
          linkChanges: [
            { op: "add", type: "Blocks", direction: "outward", issue: "NEB-2" },
          ],
        },
        { operation: "comment", issue: "NEB-1", commentBody: "Hi" },
        {
          operation: "rank",
          rankIssues: ["NEB-2", "NEB-3"],
          rankPosition: "top",
          rankBoardId: 7,
        },
        {
          operation: "rank",
          rankIssues: ["NEB-2"],
          rankPosition: "bottom",
          rankParentIssue: "NEB-1",
        },
        { operation: "sprint", sprintId: 5, sprintName: "New" },
      ],
      prepareDeps({ signal }),
    );
    const gets = vi.mocked(jiraGet).mock.calls;
    const posts = vi.mocked(jiraPost).mock.calls;
    expect(new Set(gets.map((call) => call[1]))).toEqual(
      new Set([
        "/rest/api/3/issue/createmeta",
        "/rest/api/3/mypermissions",
        "/rest/api/3/issue/NEB-1",
        "/rest/api/3/issue/NEB-1/transitions",
        "/rest/api/3/issue/NEB-1/editmeta",
        "/rest/api/3/issue/NEB-2",
        "/rest/api/3/issue/NEB-3",
        "/rest/agile/1.0/board/7/project",
        "/rest/agile/1.0/board/7/backlog",
        "/rest/agile/1.0/sprint/5",
      ]),
    );
    for (const call of gets) expect(call[3], call[1]).toMatchObject({ signal });
    expect(posts.map((call) => call[1])).toEqual([SEARCH]);
    expect(posts[0]![4]).toEqual({ retry: true, signal });
  });

  test("an abort during item 1's issue read rejects with the abort and reads nothing more", async () => {
    const controller = new AbortController();
    vi.mocked(jiraGet).mockImplementationOnce(abortingCall(controller));
    const failure = buildJiraMutationItems(
      config,
      [
        { issue: "NEB-1", summary: "Renamed" },
        { operation: "comment", issue: "NEB-3", commentBody: "Hi" },
      ],
      prepareDeps({ signal: controller.signal }),
    );
    await expect(failure).rejects.toBe(CALLER_GAVE_UP);
    await expect(failure).rejects.not.toBeInstanceOf(JiraMutationError);
    expect(jiraGet).toHaveBeenCalledTimes(1);
  });

  test("prepare stops before the next item once the signal aborts", async () => {
    const controller = new AbortController();
    // A dep that ignores the signal: item 1 completes, item 2 never starts.
    const fieldMap = vi.fn(async () => {
      controller.abort(CALLER_GAVE_UP);
      return FIELD_MAP;
    });
    await expect(
      buildJiraMutationItems(
        config,
        [
          { issue: "NEB-1", fields: { "Story Points": 3 } },
          { operation: "comment", issue: "NEB-3", commentBody: "Hi" },
        ],
        prepareDeps({ signal: controller.signal, fieldMap }),
      ),
    ).rejects.toBe(CALLER_GAVE_UP);
    expect(vi.mocked(jiraGet).mock.calls.map((call) => call[1])).toEqual([
      "/rest/api/3/issue/NEB-1",
    ]);
  });
});

describe("stop seam (AC6)", () => {
  const comment = (key: string): JiraIssueMutationItemDisplay => ({
    clientId: key,
    issueKey: key,
    operation: "comment",
    commentBody: "Hi",
    fieldChanges: [],
  });

  test("a stop before item 2 of 3 fails items 2 and 3 with its text and sends nothing for them", async () => {
    const items = [comment("NEB-1"), comment("NEB-2"), comment("NEB-3")];
    let checks = 0;
    const result = await applyJiraMutationItems(
      config,
      items,
      applyDeps({
        stopBefore: () => (++checks > 1 ? "Out of time." : undefined),
      }),
    );
    expect(jiraPost).toHaveBeenCalledTimes(1);
    expect(items.map((item) => item.error)).toEqual([
      undefined,
      "Out of time.",
      "Out of time.",
    ]);
    expect(result).toEqual({
      succeeded: 1,
      resultSummary: "Applied 1 change(s); 2 failed",
      resultUrl: "https://example.atlassian.net/browse/NEB-1",
    });
  });

  test("a stop before item 1 fails all of them through the same summary", async () => {
    const items = [comment("NEB-1"), comment("NEB-2")];
    await expect(
      applyJiraMutationItems(
        config,
        items,
        applyDeps({ stopBefore: () => "Out of time." }),
      ),
    ).rejects.toThrow(
      new JiraMutationError(
        "All 2 Jira change(s) failed: Out of time.; Out of time.",
      ),
    );
    expect(jiraPost).not.toHaveBeenCalled();
  });
});
