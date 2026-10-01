import { afterEach, describe, expect, test, vi } from "vitest";

// Mock the Jira config + network layer so jira_lookup runs offline. importActual
// keeps every other real export (normalizeProject/normalizeJiraUser/jiraBaseUrl/...)
// so only the credential + HTTP seams are stubbed.
vi.mock("../../jiraSettings.ts", async (importActual) => ({
  ...(await importActual<typeof import("../../jiraSettings.ts")>()),
  getJiraToolConfig: () => ({
    jiraHost: "example.atlassian.net",
    atlassianEmail: "a@b.c",
    atlassianToken: "t",
  }),
}));

vi.mock("../../jiraFieldCache.ts", async (importActual) => ({
  ...(await importActual<typeof import("../../jiraFieldCache.ts")>()),
  getJiraFieldMap: async () => ({ byId: new Map(), fetchedAt: 1_000 }),
}));

vi.mock("../../jiraIssueLinkTypeCache.ts", async (importActual) => ({
  ...(await importActual<typeof import("../../jiraIssueLinkTypeCache.ts")>()),
  getJiraIssueLinkTypes: vi.fn(async () => [
    { id: "1010", name: "Blocks", inward: "is blocked by", outward: "blocks" },
    {
      id: "1000",
      name: "Relates",
      inward: "relates to",
      outward: "relates to",
    },
  ]),
}));

vi.mock("../../jiraClient.ts", async (importActual) => ({
  ...(await importActual<typeof import("../../jiraClient.ts")>()),
  // projects use /project/search (paged object); users use /user*/search (array);
  // a single issue fetch returns a minimal issue for mutation building.
  jiraGet: vi.fn(async (_config: unknown, path: string) => {
    if (path.includes("/user")) return [];
    if (path === "/rest/api/3/mypermissions")
      return {
        permissions: {
          ADD_COMMENTS: { havePermission: true },
          LINK_ISSUES: { havePermission: true },
        },
      };
    if (path === "/rest/api/3/issue/createmeta")
      return {
        projects: [
          {
            key: "OPS",
            issuetypes: [
              {
                name: "Task",
                fields: { description: { name: "Description" } },
              },
              {
                name: "Sub-task",
                fields: {
                  description: { name: "Description" },
                  labels: { name: "Labels" },
                },
              },
            ],
          },
        ],
      };
    if (path.endsWith("/editmeta"))
      return {
        fields: {
          summary: { name: "Summary" },
          description: { name: "Description" },
        },
      };
    if (/\/rest\/api\/3\/issue\/[^/]+$/.test(path))
      return {
        id: "10001",
        key: "NEB-1",
        fields: {
          summary: "Subject",
          status: { name: "Open" },
          issuelinks: [
            {
              id: "9001",
              type: {
                name: "Blocks",
                inward: "is blocked by",
                outward: "blocks",
              },
              outwardIssue: {
                key: "NEB-2",
                fields: { summary: "Target", status: { name: "Open" } },
              },
            },
          ],
        },
      };
    return { values: [], total: 0, isLast: true, startAt: 0 };
  }),
  jiraPost: vi.fn(async () => ({})),
  jiraPut: vi.fn(async () => ({})),
  jiraDelete: vi.fn(async () => ({})),
}));

// Importing jiraTools also registers the "jiraIssue" approval executor.
const {
  assistantJiraTools,
  jiraLookupTool,
  jiraGetIssueTool,
  jiraMutateIssueTool,
  dropNulls,
} = await import("./jiraTools.ts");
const {
  approvalsForSession,
  reconcileLegacyPartialApprovalCard,
  resolveApproval,
  setApprovalBroadcastForTests,
} = await import("../../pendingApprovals.ts");
const { jiraGet, jiraPost, jiraPut, jiraDelete } =
  await import("../../jiraClient.ts");
const defaultJiraGet = vi.mocked(jiraGet).getMockImplementation()!;
const defaultJiraPost = vi.mocked(jiraPost).getMockImplementation()!;
const defaultJiraPut = vi.mocked(jiraPut).getMockImplementation()!;

setApprovalBroadcastForTests(() => {});

let mutateSession = 0;
function runMutate(sessionId: string, items: unknown[]) {
  return jiraMutateIssueTool.execute(
    { items } as never,
    { session: { sessionId } } as never,
  );
}

function proposalItems(sessionId: string) {
  const card = approvalsForSession(sessionId).at(-1);
  if (!card || card.body.kind !== "jiraIssue")
    throw new Error("no jira approval staged");
  return card.body.items;
}

function runLookup(params: Record<string, unknown>) {
  return jiraLookupTool.execute(params as never, {} as never);
}

function parseText(
  result: Awaited<ReturnType<typeof runLookup>>,
): Record<string, unknown> {
  const text =
    result.content?.[0]?.type === "text" ? result.content[0].text : "";
  return JSON.parse(text) as Record<string, unknown>;
}

describe("dropNulls", () => {
  test("drops null/undefined/empty-string/empty-array but keeps false and 0", () => {
    expect(
      dropNulls({
        a: null,
        b: undefined,
        c: "",
        d: [],
        e: false,
        f: 0,
        g: "x",
        h: [1],
      }),
    ).toEqual({
      e: false,
      f: 0,
      g: "x",
      h: [1],
    });
  });
});

describe("jira_lookup kind dispatch + payload invariants", () => {
  test("kind=fields returns kind=fields, keeps the fields array even when empty, and omits null scalar keys", async () => {
    const payload = parseText(await runLookup({ kind: "fields" }));
    expect(payload.kind).toBe("fields");
    expect(Array.isArray(payload.fields)).toBe(true);
    expect(payload.fields).toEqual([]);
    // null scalars (query/custom/orderable/searchable) are omitted, not echoed as null.
    for (const key of ["query", "custom", "orderable", "searchable"]) {
      expect(key in payload).toBe(false);
    }
    // No value in the payload is literally null.
    expect(Object.values(payload).some((v) => v === null)).toBe(false);
  });

  test("kind=projects returns kind=projects with a projects array", async () => {
    const payload = parseText(
      await runLookup({ kind: "projects", maxResults: 5 }),
    );
    expect(payload.kind).toBe("projects");
    expect(Array.isArray(payload.projects)).toBe(true);
    expect(payload.projects).toEqual([]);
  });

  test("kind=users returns kind=users with a users array", async () => {
    const payload = parseText(
      await runLookup({ kind: "users", maxResults: 5 }),
    );
    expect(payload.kind).toBe("users");
    expect(Array.isArray(payload.users)).toBe(true);
    expect(payload.users).toEqual([]);
  });

  test("kind=issueLinkTypes returns cached link types with inward/outward phrases", async () => {
    const payload = parseText(await runLookup({ kind: "issueLinkTypes" }));
    expect(payload.kind).toBe("issueLinkTypes");
    expect(payload.linkTypes).toEqual([
      {
        id: "1010",
        name: "Blocks",
        inward: "is blocked by",
        outward: "blocks",
      },
      {
        id: "1000",
        name: "Relates",
        inward: "relates to",
        outward: "relates to",
      },
    ]);
  });

  test("kind=issueLinkTypes filters by query over name/inward/outward", async () => {
    const payload = parseText(
      await runLookup({ kind: "issueLinkTypes", query: "blocked" }),
    );
    expect(
      (payload.linkTypes as Array<{ name: string }>).map((type) => type.name),
    ).toEqual(["Blocks"]);
  });

  test("content text is compact (non-pretty) JSON", async () => {
    const result = await runLookup({ kind: "fields" });
    const text =
      result.content?.[0]?.type === "text" ? result.content[0].text : "";
    expect(text).not.toContain("\n");
    expect(text.startsWith("{")).toBe(true);
  });
});

describe("assistantJiraTools registry", () => {
  test("exposes the consolidated 4-tool surface and no legacy discovery tools", () => {
    const names = assistantJiraTools.map((tool) => tool.name).sort();
    expect(names).toEqual([
      "jira_get_issue",
      "jira_lookup",
      "jira_mutate_issue",
      "jira_search_issues",
    ]);
    expect(names).not.toContain("jira_list_fields");
    expect(names).not.toContain("jira_list_projects");
    expect(names).not.toContain("jira_search_users");
  });
});

describe("jira_get_issue issue links", () => {
  test("surfaces normalized issueLinks with direction and relationship phrase", async () => {
    const result = await jiraGetIssueTool.execute(
      { issue: "NEB-1" } as never,
      {} as never,
    );
    const text =
      result.content?.[0]?.type === "text" ? result.content[0].text : "";
    const payload = JSON.parse(text) as {
      issue: { issueLinks: Array<Record<string, unknown>> };
    };
    expect(payload.issue.issueLinks).toEqual([
      {
        id: "9001",
        type: "Blocks",
        direction: "outward",
        relationship: "blocks",
        issue: {
          id: null,
          key: "NEB-2",
          issueUrl: "https://example.atlassian.net/browse/NEB-2",
          summary: "Target",
          issueType: null,
          status: "Open",
        },
      },
    ]);
  });
});

describe("jira_mutate_issue issue links (approval subsystem)", () => {
  test("builds an add link change resolving the type name and direction", async () => {
    const sid = `jira-mut-${(mutateSession += 1)}`;
    await runMutate(sid, [
      {
        issue: "NEB-1",
        linkChanges: [
          { op: "add", type: "blocks", direction: "outward", issue: "neb-2" },
        ],
      },
    ]);
    const link = proposalItems(sid)[0]!.linkChanges![0]!;
    expect(link).toMatchObject({
      op: "add",
      type: "Blocks",
      direction: "outward",
      relationship: "blocks",
      targetIssueKey: "NEB-2",
    });
  });

  test("rejects a remove link change without a linkId", async () => {
    await expect(
      runMutate(`jira-mut-${(mutateSession += 1)}`, [
        { issue: "NEB-1", linkChanges: [{ op: "remove" }] },
      ]),
    ).rejects.toThrow(/linkId/);
  });

  test("rejects an unknown link type", async () => {
    await expect(
      runMutate(`jira-mut-${(mutateSession += 1)}`, [
        {
          issue: "NEB-1",
          linkChanges: [
            { op: "add", type: "Nope", direction: "outward", issue: "NEB-2" },
          ],
        },
      ]),
    ).rejects.toThrow(/Unknown Jira issue link type/);
  });

  test("approving creates a link with outward=subject, inward=target and marks it ok", async () => {
    vi.mocked(jiraPost).mockClear();
    const sid = `jira-mut-${(mutateSession += 1)}`;
    await runMutate(sid, [
      {
        issue: "NEB-1",
        linkChanges: [
          { op: "add", type: "Blocks", direction: "outward", issue: "NEB-2" },
        ],
      },
    ]);
    const approvalId = approvalsForSession(sid).at(-1)!.id;
    const { card } = await resolveApproval(approvalId, "approved");
    expect(card.status).toBe("executed");
    expect(vi.mocked(jiraPost)).toHaveBeenCalledWith(
      expect.anything(),
      "/rest/api/3/issueLink",
      {
        type: { name: "Blocks" },
        inwardIssue: { key: "NEB-2" },
        outwardIssue: { key: "NEB-1" },
      },
    );
    expect(proposalItems(sid)[0]!.linkChanges![0]!.resultOk).toBe(true);
  });

  test("approving deletes a link by id for op=remove", async () => {
    vi.mocked(jiraDelete).mockClear();
    const sid = `jira-mut-${(mutateSession += 1)}`;
    await runMutate(sid, [
      { issue: "NEB-1", linkChanges: [{ op: "remove", linkId: "55555" }] },
    ]);
    const { card } = await resolveApproval(
      approvalsForSession(sid).at(-1)!.id,
      "approved",
    );
    expect(vi.mocked(jiraDelete)).toHaveBeenCalledWith(
      expect.anything(),
      "/rest/api/3/issueLink/55555",
    );
    expect(card.status).toBe("executed");
  });

  test("rejecting records the decision without any write", async () => {
    vi.mocked(jiraPost).mockClear();
    const sid = `jira-mut-${(mutateSession += 1)}`;
    await runMutate(sid, [
      {
        issue: "NEB-1",
        linkChanges: [
          { op: "add", type: "Blocks", direction: "outward", issue: "NEB-2" },
        ],
      },
    ]);
    const { card, outcomePrompt } = await resolveApproval(
      approvalsForSession(sid).at(-1)!.id,
      "rejected",
    );
    expect(card.status).toBe("rejected");
    expect(vi.mocked(jiraPost)).not.toHaveBeenCalled();
    expect(outcomePrompt).toContain("REJECTED");
  });
});

describe("legacy Jira approval reconciliation", () => {
  test("recovers a created issue key from the old post-create link failure shape", () => {
    const card = reconcileLegacyPartialApprovalCard({
      renderKind: "approval",
      id: "legacy",
      sessionId: "s1",
      kind: "jiraIssue",
      status: "failed",
      decision: "approved",
      title: "Create OPS issue",
      createdAt: 1,
      error:
        "All 1 Jira change(s) failed: add link Relates OPS-96↔OPS-95: permission denied",
      body: {
        kind: "jiraIssue",
        jiraHost: "example.atlassian.net",
        items: [
          {
            clientId: "c1",
            issueKey: "",
            operation: "create",
            createProjectKey: "OPS",
            createIssueType: "Sub-task",
            createSummary: "Test",
            fieldChanges: [],
          },
        ],
      },
    });
    expect(card).toMatchObject({
      status: "executed",
      resultSummary: "Created OPS-96 with warnings",
      resultUrl: "https://example.atlassian.net/browse/OPS-96",
    });
    // A successful execution CLEARS the error, so the key is gone rather than
    // present-and-undefined; assert what a reader sees.
    expect(card.error).toBeUndefined();
    if (card.body.kind !== "jiraIssue")
      throw new Error("unexpected approval kind");
    expect(card.body.items[0]).toMatchObject({
      issueKey: "OPS-96",
      resultIssueKey: "OPS-96",
      warning: expect.stringContaining("Issue created, but"),
    });
  });
});

describe("jira_mutate_issue create & comment", () => {
  test("create validates required fields, stages a create item, and posts on approval", async () => {
    await expect(
      runMutate("jira-c-x", [
        { operation: "create", issueType: "Task", summary: "x" },
      ]),
    ).rejects.toThrow(/projectKey/);

    vi.mocked(jiraPost).mockClear();
    vi.mocked(jiraPost).mockImplementationOnce(async () => ({
      key: "OPS-100",
    }));
    const sid = `jira-create-${(mutateSession += 1)}`;
    await runMutate(sid, [
      {
        operation: "create",
        projectKey: "ops",
        issueType: "Task",
        summary: "General engineering",
        description: "## Context\n\n- line 1\n- line 2",
      },
    ]);
    const staged = proposalItems(sid)[0]!;
    expect(staged.operation).toBe("create");
    expect(staged.createProjectKey).toBe("OPS");
    expect(staged.issueKey).toBe("");

    const { card } = await resolveApproval(
      approvalsForSession(sid).at(-1)!.id,
      "approved",
    );
    expect(card.status).toBe("executed");
    const call = vi
      .mocked(jiraPost)
      .mock.calls.find((c) => c[1] === "/rest/api/3/issue");
    expect(call).toBeTruthy();
    const createBody = call![2] as {
      fields: {
        project: { key: string };
        issuetype: { name: string };
        description: { type: string; content: Array<{ type: string }> };
      };
    };
    expect(createBody.fields.project.key).toBe("OPS");
    expect(createBody.fields.description).toMatchObject({
      type: "doc",
      content: [{ type: "heading" }, { type: "bulletList" }],
    });
    if (card.body.kind === "jiraIssue")
      expect(card.body.items[0]!.resultIssueKey).toBe("OPS-100");
  });

  test("rejects unsupported create fields before approval using Jira create metadata", async () => {
    vi.mocked(jiraGet).mockImplementation(async (config, path, query) => {
      if (path === "/rest/api/3/issue/createmeta") {
        return {
          projects: [
            { key: "OPS", issuetypes: [{ name: "Sub-task", fields: {} }] },
          ],
        } as never;
      }
      return defaultJiraGet(config, path, query) as never;
    });
    try {
      await expect(
        runMutate(`jira-create-meta-${(mutateSession += 1)}`, [
          {
            operation: "create",
            projectKey: "OPS",
            issueType: "Sub-task",
            summary: "Formatting test",
            parentIssue: "OPS-1",
            description: "**not on the screen**",
            labels: { add: ["test"] },
          },
        ]),
      ).rejects.toThrow(/Description, Labels cannot be set.*create screen/);
    } finally {
      vi.mocked(jiraGet).mockImplementation(defaultJiraGet);
    }
  });

  test("creates a sub-task with its parent and native issue links", async () => {
    vi.mocked(jiraPost).mockClear();
    vi.mocked(jiraPost)
      .mockImplementationOnce(async () => ({ key: "OPS-101" }))
      .mockImplementation(async () => ({}));
    const sid = `jira-subtask-${(mutateSession += 1)}`;
    await runMutate(sid, [
      {
        operation: "create",
        projectKey: "OPS",
        issueType: "Sub-task",
        summary: "Formatting test",
        parentIssue: "ops-1",
        linkChanges: [
          { op: "add", type: "Relates", direction: "outward", issue: "NEB-2" },
        ],
      },
    ]);
    const staged = proposalItems(sid)[0]!;
    expect(staged.createParentIssue).toBe("OPS-1");
    expect(staged.linkChanges?.[0]).toMatchObject({
      type: "Relates",
      targetIssueKey: "NEB-2",
    });

    const { card } = await resolveApproval(
      approvalsForSession(sid).at(-1)!.id,
      "approved",
    );
    expect(card.status).toBe("executed");
    const createCall = vi
      .mocked(jiraPost)
      .mock.calls.find((call) => call[1] === "/rest/api/3/issue");
    expect(createCall?.[2]).toMatchObject({
      fields: { parent: { key: "OPS-1" } },
    });
    expect(vi.mocked(jiraPost)).toHaveBeenCalledWith(
      expect.anything(),
      "/rest/api/3/issueLink",
      {
        type: { name: "Relates" },
        inwardIssue: { key: "NEB-2" },
        outwardIssue: { key: "OPS-101" },
      },
    );
  });

  test("reports a created issue with a warning when its post-create link fails", async () => {
    vi.mocked(jiraPost).mockClear();
    vi.mocked(jiraPost)
      .mockImplementationOnce(async () => ({ key: "OPS-102" }))
      .mockImplementationOnce(async () => {
        throw new Error("link denied");
      })
      .mockImplementation(async () => ({}));
    const sid = `jira-create-partial-${(mutateSession += 1)}`;
    await runMutate(sid, [
      {
        operation: "create",
        projectKey: "OPS",
        issueType: "Sub-task",
        summary: "Partial create",
        parentIssue: "OPS-1",
        linkChanges: [
          { op: "add", type: "Relates", direction: "outward", issue: "NEB-2" },
        ],
      },
    ]);

    const { card } = await resolveApproval(
      approvalsForSession(sid).at(-1)!.id,
      "approved",
    );
    expect(card.status).toBe("executed");
    if (card.body.kind !== "jiraIssue")
      throw new Error("unexpected approval kind");
    expect(card.body.items[0]).toMatchObject({ resultIssueKey: "OPS-102" });
    expect(card.body.items[0]!.error).toBeUndefined();
    expect(card.body.items[0]!.warning).toMatch(/Issue created.*link denied/);
    expect(card.resultSummary).toContain("1 warning");
  });

  test("edits summary and converts a Markdown description to ADF", async () => {
    vi.mocked(jiraPut).mockClear();
    const sid = `jira-edit-content-${(mutateSession += 1)}`;
    await runMutate(sid, [
      {
        issue: "NEB-1",
        summary: "Updated summary",
        description: "## Acceptance\n\n- **works**",
      },
    ]);
    expect(
      proposalItems(sid)[0]!.fieldChanges.map((change) => change.fieldId),
    ).toEqual(["summary", "description"]);

    const { card } = await resolveApproval(
      approvalsForSession(sid).at(-1)!.id,
      "approved",
    );
    expect(card.status).toBe("executed");
    expect(vi.mocked(jiraPut)).toHaveBeenCalledWith(
      expect.anything(),
      "/rest/api/3/issue/NEB-1",
      {
        fields: {
          summary: "Updated summary",
          description: expect.objectContaining({
            type: "doc",
            content: [
              {
                type: "heading",
                attrs: { level: 2 },
                content: expect.any(Array),
              },
              { type: "bulletList", content: expect.any(Array) },
            ],
          }),
        },
        update: {},
      },
    );
  });

  test("persists executor-mutated per-item diagnostics when an approved edit fails", async () => {
    vi.mocked(jiraPut).mockRejectedValueOnce(new Error("edit denied"));
    const sid = `jira-edit-failure-${(mutateSession += 1)}`;
    await runMutate(sid, [{ issue: "NEB-1", summary: "Will fail" }]);
    const { card } = await resolveApproval(
      approvalsForSession(sid).at(-1)!.id,
      "approved",
    );
    expect(card.status).toBe("failed");
    if (card.body.kind !== "jiraIssue")
      throw new Error("unexpected approval kind");
    expect(card.body.items[0]!.error).toBe("edit denied");
  });

  test("rejects a content edit before approval when Jira omits the field from editmeta", async () => {
    vi.mocked(jiraGet).mockImplementation(async (config, path, query) => {
      if (path.endsWith("/editmeta"))
        return { fields: { summary: { name: "Summary" } } } as never;
      return defaultJiraGet(config, path, query) as never;
    });
    try {
      await expect(
        runMutate(`jira-editmeta-${(mutateSession += 1)}`, [
          { issue: "NEB-1", description: "**not editable**" },
        ]),
      ).rejects.toThrow(/Description cannot be edited.*edit screen/);
    } finally {
      vi.mocked(jiraGet).mockImplementation(defaultJiraGet);
    }
  });

  test("rejects comments and links before approval when Jira permissions deny them", async () => {
    vi.mocked(jiraGet).mockImplementation(async (config, path, query) => {
      if (path === "/rest/api/3/mypermissions") {
        const permission = String(query?.permissions ?? "");
        return {
          permissions: { [permission]: { havePermission: false } },
        } as never;
      }
      return defaultJiraGet(config, path, query) as never;
    });
    try {
      await expect(
        runMutate(`jira-comment-permission-${(mutateSession += 1)}`, [
          { operation: "comment", issue: "NEB-1", commentBody: "Nope" },
        ]),
      ).rejects.toThrow(/ADD_COMMENTS/);
      await expect(
        runMutate(`jira-link-permission-${(mutateSession += 1)}`, [
          {
            issue: "NEB-1",
            linkChanges: [
              {
                op: "add",
                type: "Relates",
                direction: "outward",
                issue: "NEB-2",
              },
            ],
          },
        ]),
      ).rejects.toThrow(/LINK_ISSUES/);
    } finally {
      vi.mocked(jiraGet).mockImplementation(defaultJiraGet);
    }
  });

  test("comment requires issue + body and posts Markdown as ADF on approval", async () => {
    await expect(
      runMutate("jira-c-y", [{ operation: "comment", issue: "neb-1" }]),
    ).rejects.toThrow(/commentBody/);

    vi.mocked(jiraPost).mockClear();
    const sid = `jira-comment-${(mutateSession += 1)}`;
    await runMutate(sid, [
      {
        operation: "comment",
        issue: "neb-1",
        commentBody: "Progress: **shipped**.",
      },
    ]);
    expect(jiraGet).toHaveBeenCalledWith(
      expect.anything(),
      "/rest/api/3/mypermissions",
      {
        issueKey: "NEB-1",
        permissions: "ADD_COMMENTS",
      },
    );
    expect(proposalItems(sid)[0]!.operation).toBe("comment");

    const { card } = await resolveApproval(
      approvalsForSession(sid).at(-1)!.id,
      "approved",
    );
    expect(card.status).toBe("executed");
    const call = vi
      .mocked(jiraPost)
      .mock.calls.find((c) => String(c[1]).endsWith("/comment"));
    expect(call).toBeTruthy();
    expect(String(call![1])).toBe("/rest/api/3/issue/NEB-1/comment");
    expect(call![2]).toMatchObject({
      body: {
        type: "doc",
        content: [
          {
            type: "paragraph",
            content: expect.arrayContaining([
              expect.objectContaining({
                text: "shipped",
                marks: [{ type: "strong" }],
              }),
            ]),
          },
        ],
      },
    });
  });
});

/**
 * A miniature ranked Jira: one mutable order that the mocked Agile rank call
 * actually rearranges, so a test asserts the sequence Jira would end up with
 * rather than the calls we happened to make.
 */
type StubIssue = {
  key: string;
  project: string;
  level: number;
  parent?: string;
};

function rankStub(
  issues: StubIssue[],
  options: {
    boardProjects?: string[];
    permission?: boolean;
    failRankFor?: string;
  } = {},
) {
  const order = issues.map((issue) => issue.key);
  const byKey = new Map(issues.map((issue) => [issue.key, issue]));
  const ordered = (keys: string[]) => order.filter((key) => keys.includes(key));

  vi.mocked(jiraGet).mockImplementation(async (config, path, query) => {
    if (path === "/rest/api/3/mypermissions")
      return {
        permissions: {
          SCHEDULE_ISSUES: { havePermission: options.permission !== false },
        },
      } as never;
    const issueMatch = /^\/rest\/api\/3\/issue\/([^/]+)$/.exec(path);
    if (issueMatch) {
      const key = decodeURIComponent(issueMatch[1]!);
      const issue = byKey.get(key);
      if (!issue)
        throw new Error(
          `Jira API returned HTTP 404 for GET /rest/api/3/issue/${key}: {"errorMessages":["Issue does not exist"]}`,
        );
      return {
        id: key,
        key,
        fields: {
          summary: `${key} summary`,
          project: { key: issue.project },
          issuetype: {
            name: issue.level > 0 ? "Epic" : "Task",
            hierarchyLevel: issue.level,
          },
          parent: issue.parent ? { key: issue.parent } : null,
        },
      } as never;
    }
    if (/\/board\/\d+\/project$/.test(path))
      return {
        values: (options.boardProjects ?? ["OPS"]).map((key) => ({ key })),
      } as never;
    if (/\/board\/\d+\/epic$/.test(path))
      return {
        values: order
          .filter((key) => (byKey.get(key)?.level ?? 0) > 0)
          .map((key) => ({ key })),
      } as never;
    if (/\/board\/\d+\/backlog$/.test(path))
      return {
        issues: order
          .filter((key) => (byKey.get(key)?.level ?? 0) === 0)
          .map((key) => ({ key })),
      } as never;
    return defaultJiraGet(config, path, query) as never;
  });

  vi.mocked(jiraPost).mockImplementation(
    async (config, path, body, query, callOptions) => {
      if (path === "/rest/api/3/search/jql") {
        const jql = String((body as { jql?: string })?.jql ?? "");
        const parent = /^parent = "([^"]+)"/.exec(jql);
        const keys = parent
          ? order.filter((key) => byKey.get(key)?.parent === parent[1])
          : ordered([...jql.matchAll(/"([^"]+)"/g)].map((m) => m[1]!));
        return { issues: keys.map((key) => ({ key })) } as never;
      }
      return defaultJiraPost(config, path, body, query, callOptions) as never;
    },
  );

  vi.mocked(jiraPut).mockImplementation(async (config, path, body) => {
    if (path !== "/rest/agile/1.0/issue/rank")
      return defaultJiraPut(config, path, body) as never;
    const request = body as {
      issues: string[];
      rankBeforeIssue?: string;
      rankAfterIssue?: string;
    };
    const moving = request.issues[0]!;
    if (options.failRankFor === moving)
      throw new Error(
        "Jira API returned HTTP 403 for PUT /rest/agile/1.0/issue/rank",
      );
    const anchor = request.rankBeforeIssue ?? request.rankAfterIssue!;
    order.splice(order.indexOf(moving), 1);
    const at = order.indexOf(anchor);
    order.splice(request.rankBeforeIssue ? at : at + 1, 0, moving);
    return {} as never;
  });

  return { order };
}

function restoreJiraMocks() {
  vi.mocked(jiraGet).mockImplementation(defaultJiraGet);
  vi.mocked(jiraPost).mockImplementation(defaultJiraPost);
  vi.mocked(jiraPut).mockImplementation(defaultJiraPut);
}

/** Stage a rank proposal and approve it, returning the card and its item. */
async function runRank(items: unknown[]) {
  const sid = `jira-rank-${(mutateSession += 1)}`;
  await runMutate(sid, items);
  const staged = proposalItems(sid)[0]!;
  const { card } = await resolveApproval(
    approvalsForSession(sid).at(-1)!.id,
    "approved",
  );
  if (card.body.kind !== "jiraIssue")
    throw new Error("unexpected approval kind");
  return { card, staged, item: card.body.items[0]! };
}

describe("jira_mutate_issue rank", () => {
  afterEach(() => restoreJiraMocks());

  test("top ranks an epic before the board's current first epic", async () => {
    const stub = rankStub([
      { key: "OPS-1", project: "OPS", level: 1 },
      { key: "OPS-2", project: "OPS", level: 1 },
      { key: "OPS-9", project: "OPS", level: 1 },
    ]);
    const { card, staged, item } = await runRank([
      {
        operation: "rank",
        rankIssues: ["OPS-9"],
        rankPosition: "top",
        rankBoardId: 5,
      },
    ]);
    expect(staged.rankScope).toEqual({
      kind: "board",
      boardId: 5,
      epics: true,
    });
    expect(staged.rankSteps).toEqual([
      { issueKey: "OPS-9", placement: "before", relativeToIssueKey: "OPS-1" },
    ]);
    expect(vi.mocked(jiraPut)).toHaveBeenCalledWith(
      expect.anything(),
      "/rest/agile/1.0/issue/rank",
      { issues: ["OPS-9"], rankBeforeIssue: "OPS-1" },
    );
    expect(card.status).toBe("executed");
    expect(stub.order).toEqual(["OPS-9", "OPS-1", "OPS-2"]);
    expect(item.rankResultOrder).toEqual(["OPS-9", "OPS-1", "OPS-2"]);
    expect(card.resultSummary).toContain("order now OPS-9 → OPS-1 → OPS-2");
  });

  test("bottom ranks after the last issue of the board backlog", async () => {
    const stub = rankStub([
      { key: "OPS-10", project: "OPS", level: 0 },
      { key: "OPS-11", project: "OPS", level: 0 },
      { key: "OPS-12", project: "OPS", level: 0 },
    ]);
    const { staged, item } = await runRank([
      {
        operation: "rank",
        rankIssues: ["OPS-10"],
        rankPosition: "bottom",
        rankBoardId: 5,
      },
    ]);
    expect(staged.rankScope).toEqual({
      kind: "board",
      boardId: 5,
      epics: false,
    });
    expect(staged.rankSteps).toEqual([
      { issueKey: "OPS-10", placement: "after", relativeToIssueKey: "OPS-12" },
    ]);
    expect(stub.order).toEqual(["OPS-11", "OPS-12", "OPS-10"]);
    expect(item.rankResultOrder).toEqual(["OPS-11", "OPS-12", "OPS-10"]);
  });

  test("before and after place an issue against a named target", async () => {
    const before = rankStub([
      { key: "OPS-10", project: "OPS", level: 0 },
      { key: "OPS-11", project: "OPS", level: 0 },
      { key: "OPS-12", project: "OPS", level: 0 },
    ]);
    const beforeRun = await runRank([
      {
        operation: "rank",
        rankIssues: ["ops-12"],
        rankPosition: "before",
        rankTargetIssue: "ops-11",
      },
    ]);
    expect(beforeRun.staged.rankIssueKeys).toEqual(["OPS-12"]);
    expect(before.order).toEqual(["OPS-10", "OPS-12", "OPS-11"]);
    // No scope was read, so the observed order covers the issues involved.
    expect(beforeRun.item.rankResultOrder).toEqual(["OPS-12", "OPS-11"]);
    restoreJiraMocks();

    const after = rankStub([
      { key: "OPS-10", project: "OPS", level: 0 },
      { key: "OPS-11", project: "OPS", level: 0 },
      { key: "OPS-12", project: "OPS", level: 0 },
    ]);
    await runRank([
      {
        operation: "rank",
        rankIssues: ["OPS-10"],
        rankPosition: "after",
        rankTargetIssue: "OPS-12",
      },
    ]);
    expect(after.order).toEqual(["OPS-11", "OPS-12", "OPS-10"]);
  });

  test("an ordered batch lands in the requested sequence under its parent", async () => {
    const stub = rankStub([
      { key: "OPS-1", project: "OPS", level: 1 },
      { key: "OPS-11", project: "OPS", level: 0, parent: "OPS-1" },
      { key: "OPS-12", project: "OPS", level: 0, parent: "OPS-1" },
      { key: "OPS-13", project: "OPS", level: 0, parent: "OPS-1" },
      { key: "OPS-14", project: "OPS", level: 0, parent: "OPS-1" },
    ]);
    const { staged, item } = await runRank([
      {
        operation: "rank",
        rankIssues: ["OPS-13", "OPS-11", "OPS-12"],
        rankPosition: "top",
        rankParentIssue: "OPS-1",
      },
    ]);
    expect(staged.rankSteps).toEqual([
      { issueKey: "OPS-13", placement: "before", relativeToIssueKey: "OPS-14" },
      { issueKey: "OPS-11", placement: "after", relativeToIssueKey: "OPS-13" },
      { issueKey: "OPS-12", placement: "after", relativeToIssueKey: "OPS-11" },
    ]);
    expect(stub.order).toEqual([
      "OPS-1",
      "OPS-13",
      "OPS-11",
      "OPS-12",
      "OPS-14",
    ]);
    expect(item.rankResultOrder).toEqual([
      "OPS-13",
      "OPS-11",
      "OPS-12",
      "OPS-14",
    ]);
  });

  test("a failed rank call reports exactly which operations applied", async () => {
    const stub = rankStub(
      [
        { key: "OPS-1", project: "OPS", level: 1 },
        { key: "OPS-11", project: "OPS", level: 0, parent: "OPS-1" },
        { key: "OPS-12", project: "OPS", level: 0, parent: "OPS-1" },
        { key: "OPS-13", project: "OPS", level: 0, parent: "OPS-1" },
        { key: "OPS-14", project: "OPS", level: 0, parent: "OPS-1" },
      ],
      { failRankFor: "OPS-12" },
    );
    const { card, item } = await runRank([
      {
        operation: "rank",
        rankIssues: ["OPS-13", "OPS-12", "OPS-11"],
        rankPosition: "bottom",
        rankParentIssue: "OPS-1",
      },
    ]);
    expect(card.status).toBe("failed");
    expect(item.error).toContain("Applied: OPS-13.");
    expect(item.error).toContain("Not attempted: OPS-11.");
    expect(item.rankSteps?.map((step) => step.resultOk)).toEqual([
      true,
      false,
      undefined,
    ]);
    // The applied step stands on its own; the untouched issues stayed put
    // rather than being ranked against an issue that never moved.
    expect(stub.order).toEqual([
      "OPS-1",
      "OPS-11",
      "OPS-12",
      "OPS-14",
      "OPS-13",
    ]);
    expect(item.rankResultOrder).toEqual([
      "OPS-11",
      "OPS-12",
      "OPS-14",
      "OPS-13",
    ]);
  });

  test("rejects cross-project, cross-level, unknown and unbounded rank requests", async () => {
    rankStub([
      { key: "OPS-1", project: "OPS", level: 1 },
      { key: "OPS-11", project: "OPS", level: 0, parent: "OPS-1" },
      { key: "NEB-2", project: "NEB", level: 0 },
    ]);
    const rank = (item: Record<string, unknown>) =>
      runMutate(`jira-rank-bad-${(mutateSession += 1)}`, [
        { operation: "rank", ...item },
      ]);

    await expect(
      rank({
        rankIssues: ["OPS-11"],
        rankPosition: "before",
        rankTargetIssue: "NEB-2",
      }),
    ).rejects.toThrow(/different projects/);
    await expect(
      rank({
        rankIssues: ["OPS-11"],
        rankPosition: "before",
        rankTargetIssue: "OPS-1",
      }),
    ).rejects.toThrow(/different levels/);
    await expect(
      rank({
        rankIssues: ["OPS-404"],
        rankPosition: "before",
        rankTargetIssue: "OPS-11",
      }),
    ).rejects.toThrow(/OPS-404 could not be read for ranking/);
    await expect(
      rank({ rankIssues: ["OPS-11"], rankPosition: "top" }),
    ).rejects.toThrow(/rankBoardId or rankParentIssue/);
    await expect(
      rank({ rankIssues: ["OPS-11"], rankPosition: "before" }),
    ).rejects.toThrow(/requires rankTargetIssue/);
    await expect(
      rank({
        rankIssues: ["OPS-11", "OPS-11"],
        rankPosition: "top",
        rankBoardId: 5,
      }),
    ).rejects.toThrow(/lists OPS-11 twice/);
    await expect(
      rank({
        rankIssues: ["OPS-11"],
        rankPosition: "top",
        rankParentIssue: "OPS-11",
      }),
    ).rejects.toThrow(/is not a child of OPS-11/);
  });

  test("rejects a board that does not cover the issues' project", async () => {
    rankStub(
      [
        { key: "OPS-10", project: "OPS", level: 0 },
        { key: "OPS-11", project: "OPS", level: 0 },
      ],
      { boardProjects: ["NEB"] },
    );
    await expect(
      runMutate(`jira-rank-board-${(mutateSession += 1)}`, [
        {
          operation: "rank",
          rankIssues: ["OPS-10"],
          rankPosition: "top",
          rankBoardId: 7,
        },
      ]),
    ).rejects.toThrow(/board 7 does not cover project OPS/);
  });

  test("rejects a rank the Jira SCHEDULE_ISSUES permission denies", async () => {
    rankStub(
      [
        { key: "OPS-10", project: "OPS", level: 0 },
        { key: "OPS-11", project: "OPS", level: 0 },
      ],
      { permission: false },
    );
    await expect(
      runMutate(`jira-rank-perm-${(mutateSession += 1)}`, [
        {
          operation: "rank",
          rankIssues: ["OPS-10"],
          rankPosition: "after",
          rankTargetIssue: "OPS-11",
        },
      ]),
    ).rejects.toThrow(/SCHEDULE_ISSUES/);
  });

  test("surfaces a multi-status rank entry failure as an error", async () => {
    rankStub([
      { key: "OPS-10", project: "OPS", level: 0 },
      { key: "OPS-11", project: "OPS", level: 0 },
    ]);
    vi.mocked(jiraPut).mockImplementationOnce(
      async () =>
        ({
          entries: [
            { issueId: 10, status: 403, errors: ["No rank permission"] },
          ],
        }) as never,
    );
    const { card, item } = await runRank([
      {
        operation: "rank",
        rankIssues: ["OPS-10"],
        rankPosition: "after",
        rankTargetIssue: "OPS-11",
      },
    ]);
    expect(card.status).toBe("failed");
    expect(item.error).toContain("No rank permission");
    expect(item.rankSteps?.[0]?.resultOk).toBe(false);
  });
});
