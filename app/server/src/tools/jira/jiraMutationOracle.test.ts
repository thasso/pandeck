/**
 * The literal oracle for the local `jira_mutate_issue` (Task-1463 P6b,
 * P6B-F2): what the tool shows when it proposes (card title, summary, body,
 * tool text) and what its executor reports when the card is approved
 * (status, `resultSummary`, `resultUrl`, the all-failed error), for each
 * operation and their mixes, with and without prepare warnings. Every
 * expectation is a literal captured from the code before P6b moved any of it;
 * a later change must leave these lines alone. The only normalization is the
 * card id inside the tool text's `pa://` link.
 *
 * The site is the fetch-level fake Jira (`test/jiraMutateFetch.ts`), so the
 * gateway path can run the same cases against the same fake.
 */
import { afterEach, expect, test, vi } from "vitest";
import {
  json,
  stubJiraFetch,
  type JiraResponder,
} from "../../test/jiraEdgeFetch.ts";
import {
  fakeJiraAnswer,
  type FakeJiraOptions,
} from "../../test/jiraMutateFetch.ts";

vi.mock("../../jiraSettings.ts", async (importActual) => ({
  ...(await importActual<typeof import("../../jiraSettings.ts")>()),
  getJiraToolConfig: () => ({
    jiraHost: "acme.atlassian.net",
    atlassianEmail: "oracle@example.com",
    atlassianToken: "oracle-token",
  }),
}));

const { jiraMutateIssueTool } = await import("./jiraTools.ts");
const { approvalsForSession, resolveApproval, setApprovalBroadcastForTests } =
  await import("../../pendingApprovals.ts");

setApprovalBroadcastForTests(() => {});

afterEach(() => {
  vi.unstubAllGlobals();
});

interface Observed {
  title: string;
  summary: string | undefined;
  text: string;
  body: unknown;
  status: string;
  resultSummary: string | undefined;
  resultUrl: string | undefined;
  error: string | undefined;
}

interface OracleCase {
  name: string;
  items: unknown[];
  options?: FakeJiraOptions;
  /** Answers before the fake Jira; `undefined` leaves a request to it. */
  answer?: () => JiraResponder;
  expected: Observed;
}

/** The card id is the one value that differs per run. */
const withoutCardId = (text: string): string =>
  text.replace(/appr_\d+_[0-9a-f]{8}/g, "appr_ID");

let session = 0;

async function observe(oracle: OracleCase): Promise<Observed> {
  const answer = oracle.answer?.();
  stubJiraFetch(
    (request) => answer?.(request) ?? fakeJiraAnswer(request, oracle.options),
  );
  const sessionId = `jira-oracle-${(session += 1)}`;
  const result = await jiraMutateIssueTool.execute(
    { items: oracle.items } as never,
    { session: { sessionId }, toolCallId: "call-1" } as never,
  );
  const part = result.content[0];
  const proposed = approvalsForSession(sessionId).at(-1)!;
  const body = structuredClone(proposed.body);
  const { card } = await resolveApproval(proposed.id, "approved");
  return {
    title: proposed.title,
    summary: proposed.summary,
    text: withoutCardId(part?.type === "text" ? part.text : ""),
    body,
    status: card.status,
    resultSummary: card.resultSummary,
    resultUrl: card.resultUrl,
    error: card.error,
  };
}

/** A board backlog of `count` issues, so `bottom` reads the whole window. */
function longBacklog(count: number): JiraResponder {
  const keys = Array.from({ length: count }, (_, index) => `STAR-${index + 1}`);
  return (request) => {
    if (/^\/rest\/agile\/1\.0\/board\/\d+\/backlog$/.test(request.path))
      return json({ issues: keys.map((key) => ({ key })) });
    return undefined;
  };
}

/** The `n`th comment post (1-based) fails with `status`; the others pass. */
function failingComment(n: number, status: number): () => JiraResponder {
  return () => {
    let posts = 0;
    return (request) => {
      if (request.method !== "POST" || !request.path.endsWith("/comment"))
        return undefined;
      posts += 1;
      return posts === n
        ? json({ errorMessages: ["Comment refused"] }, status)
        : undefined;
    };
  };
}

/** Each create answers the next of `keys`. */
function createdKeys(...keys: string[]): () => JiraResponder {
  return () => {
    let creates = 0;
    return (request) => {
      if (request.method !== "POST" || request.path !== "/rest/api/3/issue")
        return undefined;
      const key = keys[creates++]!;
      return json({ id: `102${creates}`, key }, 201);
    };
  };
}

const CASES: OracleCase[] = [
  {
    name: "edit fields, labels and a transition",
    items: [
      {
        issue: "STAR-1",
        summary: "New summary",
        description: "# Heading\n\nBody with **bold**.",
        labels: { add: ["x"], remove: ["old"] },
        fields: { "Story Points": 3 },
        transitionName: "Done",
      },
    ],
    expected: {
      title: "Edit STAR-1",
      summary: "STAR-1",
      text: "Prepared a Jira edit proposal for 1 issue(s) pending your approval. Do not claim Jira changed until the approved result appears. When you ask the user to decide, link the card: [Edit STAR-1](pa://approval/appr_ID).",
      body: {
        kind: "jiraIssue",
        jiraHost: "acme.atlassian.net",
        items: [
          {
            clientId: "item-1",
            issueKey: "STAR-1",
            operation: "edit",
            issueId: "10001",
            issueUrl: "https://acme.atlassian.net/browse/STAR-1",
            issueSummary: "Subject",
            currentStatus: "Open",
            targetTransitionId: "31",
            targetTransitionName: "Done",
            targetStatus: "Done",
            fieldChanges: [
              {
                fieldId: "status",
                label: "Status",
                from: "Open",
                to: "Done",
                operation: "transition",
              },
              {
                fieldId: "labels",
                label: "Labels",
                from: "old",
                to: "add x; remove old",
                operation: "update",
              },
              {
                fieldId: "summary",
                label: "Summary",
                from: "Subject",
                to: "New summary",
                operation: "set",
                value: "New summary",
              },
              {
                fieldId: "description",
                label: "Description",
                from: null,
                to: "# Heading\n\nBody with **bold**.",
                operation: "set",
                value: "# Heading\n\nBody with **bold**.",
              },
              {
                fieldId: "customfield_10004",
                label: "Story Points",
                from: null,
                to: "3",
                operation: "set",
                value: 3,
              },
            ],
          },
        ],
      },
      status: "executed",
      resultSummary: "Applied 1 change(s)",
      resultUrl: "https://acme.atlassian.net/browse/STAR-1",
      error: undefined,
    },
  },
  {
    name: "link add and remove",
    items: [
      {
        issue: "STAR-1",
        linkChanges: [
          { op: "add", type: "Blocks", direction: "outward", issue: "STAR-2" },
          { op: "remove", linkId: "9001" },
        ],
      },
    ],
    expected: {
      title: "Edit STAR-1",
      summary: "STAR-1",
      text: "Prepared a Jira edit proposal for 1 issue(s) pending your approval. Do not claim Jira changed until the approved result appears. When you ask the user to decide, link the card: [Edit STAR-1](pa://approval/appr_ID).",
      body: {
        kind: "jiraIssue",
        jiraHost: "acme.atlassian.net",
        items: [
          {
            clientId: "item-1",
            issueKey: "STAR-1",
            operation: "edit",
            issueId: "10001",
            issueUrl: "https://acme.atlassian.net/browse/STAR-1",
            issueSummary: "Subject",
            currentStatus: "Open",
            targetTransitionId: null,
            targetTransitionName: null,
            targetStatus: null,
            fieldChanges: [],
            linkChanges: [
              {
                op: "add",
                type: "Blocks",
                direction: "outward",
                relationship: "blocks",
                targetIssueKey: "STAR-2",
                targetIssueUrl: "https://acme.atlassian.net/browse/STAR-2",
              },
              {
                op: "remove",
                type: "link",
                direction: "outward",
                relationship: "unlink",
                targetIssueKey: "",
                targetIssueUrl: null,
                linkId: "9001",
              },
            ],
          },
        ],
      },
      status: "executed",
      resultSummary: "Applied 1 change(s)",
      resultUrl: "https://acme.atlassian.net/browse/STAR-1",
      error: undefined,
    },
  },
  {
    name: "create with parent and description",
    items: [
      {
        operation: "create",
        projectKey: "STAR",
        issueType: "Task",
        summary: "A new task",
        description: "Some *Markdown*.",
        parentIssue: "STAR-1",
      },
    ],
    options: { createdKey: "STAR-200" },
    expected: {
      title: "Create STAR issue",
      summary: "create STAR Task",
      text: "Prepared a Jira edit proposal for 1 issue(s) pending your approval. Do not claim Jira changed until the approved result appears. When you ask the user to decide, link the card: [Create STAR issue](pa://approval/appr_ID).",
      body: {
        kind: "jiraIssue",
        jiraHost: "acme.atlassian.net",
        items: [
          {
            clientId: "item-1",
            issueKey: "",
            operation: "create",
            createProjectKey: "STAR",
            createIssueType: "Task",
            createSummary: "A new task",
            createDescription: "Some *Markdown*.",
            createParentIssue: "STAR-1",
            fieldChanges: [
              {
                fieldId: "parent",
                label: "Parent",
                from: null,
                to: "STAR-1",
                operation: "set",
              },
            ],
          },
        ],
      },
      status: "executed",
      resultSummary: "Applied 1 change(s) (created STAR-200)",
      resultUrl: "https://acme.atlassian.net/browse/STAR-200",
      error: undefined,
    },
  },
  {
    name: "two creates",
    items: [
      {
        operation: "create",
        projectKey: "STAR",
        issueType: "Task",
        summary: "First task",
      },
      {
        operation: "create",
        projectKey: "STAR",
        issueType: "Task",
        summary: "Second task",
      },
    ],
    answer: createdKeys("STAR-201", "STAR-202"),
    expected: {
      title: "Create 2 Jira issues",
      summary: "create STAR Task, create STAR Task",
      text: "Prepared a Jira edit proposal for 2 issue(s) pending your approval. Do not claim Jira changed until the approved result appears. When you ask the user to decide, link the card: [Create 2 Jira issues](pa://approval/appr_ID).",
      body: {
        kind: "jiraIssue",
        jiraHost: "acme.atlassian.net",
        items: [
          {
            clientId: "item-1",
            issueKey: "",
            operation: "create",
            createProjectKey: "STAR",
            createIssueType: "Task",
            createSummary: "First task",
            fieldChanges: [],
          },
          {
            clientId: "item-2",
            issueKey: "",
            operation: "create",
            createProjectKey: "STAR",
            createIssueType: "Task",
            createSummary: "Second task",
            fieldChanges: [],
          },
        ],
      },
      status: "executed",
      resultSummary: "Applied 2 change(s) (created STAR-201, STAR-202)",
      resultUrl: "https://acme.atlassian.net/browse/STAR-201",
      error: undefined,
    },
  },
  {
    name: "comment",
    items: [
      {
        operation: "comment",
        issue: "STAR-1",
        commentBody: "Hello **there**.",
      },
    ],
    expected: {
      title: "Comment on STAR-1",
      summary: "comment STAR-1",
      text: "Prepared a Jira edit proposal for 1 issue(s) pending your approval. Do not claim Jira changed until the approved result appears. When you ask the user to decide, link the card: [Comment on STAR-1](pa://approval/appr_ID).",
      body: {
        kind: "jiraIssue",
        jiraHost: "acme.atlassian.net",
        items: [
          {
            clientId: "item-1",
            issueKey: "STAR-1",
            operation: "comment",
            issueUrl: "https://acme.atlassian.net/browse/STAR-1",
            commentBody: "Hello **there**.",
            fieldChanges: [],
          },
        ],
      },
      status: "executed",
      resultSummary: "Applied 1 change(s)",
      resultUrl: "https://acme.atlassian.net/browse/STAR-1",
      error: undefined,
    },
  },
  {
    name: "single rank to the top of a board",
    items: [
      {
        operation: "rank",
        rankIssues: ["STAR-8"],
        rankPosition: "top",
        rankBoardId: 7,
      },
    ],
    expected: {
      title: "Rank STAR-8 top",
      summary: "rank STAR-8 top",
      text: "Prepared a Jira edit proposal for 1 issue(s) pending your approval. Do not claim Jira changed until the approved result appears. When you ask the user to decide, link the card: [Rank STAR-8 top](pa://approval/appr_ID).",
      body: {
        kind: "jiraIssue",
        jiraHost: "acme.atlassian.net",
        items: [
          {
            clientId: "item-1",
            issueKey: "STAR-8",
            operation: "rank",
            issueUrl: "https://acme.atlassian.net/browse/STAR-8",
            issueSummary: "Subject",
            fieldChanges: [],
            rankIssueKeys: ["STAR-8"],
            rankPosition: "top",
            rankTargetIssueKey: "STAR-9",
            rankScope: { kind: "board", boardId: 7, epics: false },
            rankSteps: [
              {
                issueKey: "STAR-8",
                placement: "before",
                relativeToIssueKey: "STAR-9",
              },
            ],
          },
        ],
      },
      status: "executed",
      resultSummary: "Applied 1 change(s); order now STAR-9 → STAR-8",
      resultUrl: "https://acme.atlassian.net/browse/STAR-8",
      error: undefined,
    },
  },
  {
    name: "multi rank before a target",
    items: [
      {
        operation: "rank",
        rankIssues: ["STAR-2", "STAR-3"],
        rankPosition: "before",
        rankTargetIssue: "STAR-1",
      },
    ],
    expected: {
      title: "Rank 2 Jira issues",
      summary: "rank STAR-2, STAR-3 before",
      text: "Prepared a Jira edit proposal for 1 issue(s) pending your approval. Do not claim Jira changed until the approved result appears. When you ask the user to decide, link the card: [Rank 2 Jira issues](pa://approval/appr_ID).",
      body: {
        kind: "jiraIssue",
        jiraHost: "acme.atlassian.net",
        items: [
          {
            clientId: "item-1",
            issueKey: "STAR-2",
            operation: "rank",
            issueUrl: "https://acme.atlassian.net/browse/STAR-2",
            issueSummary: "Subject",
            fieldChanges: [],
            rankIssueKeys: ["STAR-2", "STAR-3"],
            rankPosition: "before",
            rankTargetIssueKey: "STAR-1",
            rankSteps: [
              {
                issueKey: "STAR-2",
                placement: "before",
                relativeToIssueKey: "STAR-1",
              },
              {
                issueKey: "STAR-3",
                placement: "after",
                relativeToIssueKey: "STAR-2",
              },
            ],
          },
        ],
      },
      status: "executed",
      resultSummary: "Applied 1 change(s); order now STAR-2 → STAR-3 → STAR-1",
      resultUrl: "https://acme.atlassian.net/browse/STAR-2",
      error: undefined,
    },
  },
  {
    name: "rank to the bottom of a full window, with a prepare warning",
    items: [
      {
        operation: "rank",
        rankIssues: ["STAR-1"],
        rankPosition: "bottom",
        rankBoardId: 7,
      },
    ],
    answer: () => longBacklog(100),
    expected: {
      title: "Rank STAR-1 bottom",
      summary: "rank STAR-1 bottom · 1 warning(s)",
      text: 'Prepared a Jira edit proposal for 1 issue(s) pending your approval. Warnings: board 7 backlog was read up to 100 issues; "bottom" means the end of that window, not necessarily the end of a longer backlog.. Do not claim Jira changed until the approved result appears. When you ask the user to decide, link the card: [Rank STAR-1 bottom](pa://approval/appr_ID).',
      body: {
        kind: "jiraIssue",
        jiraHost: "acme.atlassian.net",
        items: [
          {
            clientId: "item-1",
            issueKey: "STAR-1",
            operation: "rank",
            issueUrl: "https://acme.atlassian.net/browse/STAR-1",
            issueSummary: "Subject",
            fieldChanges: [],
            rankIssueKeys: ["STAR-1"],
            rankPosition: "bottom",
            rankTargetIssueKey: "STAR-100",
            rankScope: { kind: "board", boardId: 7, epics: false },
            rankSteps: [
              {
                issueKey: "STAR-1",
                placement: "after",
                relativeToIssueKey: "STAR-100",
              },
            ],
          },
        ],
      },
      status: "executed",
      resultSummary:
        "Applied 1 change(s); order now STAR-1 → STAR-2 → STAR-3 → STAR-4 → STAR-5 → STAR-6 → STAR-7 → STAR-8 → STAR-9 → STAR-10 → STAR-11 → STAR-12 → STAR-13 → STAR-14 → STAR-15 → STAR-16 → STAR-17 → STAR-18 → STAR-19 → STAR-20 → STAR-21 → STAR-22 → STAR-23 → STAR-24 → STAR-25 → STAR-26 → STAR-27 → STAR-28 → STAR-29 → STAR-30 → STAR-31 → STAR-32 → STAR-33 → STAR-34 → STAR-35 → STAR-36 → STAR-37 → STAR-38 → STAR-39 → STAR-40 → STAR-41 → STAR-42 → STAR-43 → STAR-44 → STAR-45 → STAR-46 → STAR-47 → STAR-48 → STAR-49 → STAR-50 → STAR-51 → STAR-52 → STAR-53 → STAR-54 → STAR-55 → STAR-56 → STAR-57 → STAR-58 → STAR-59 → STAR-60 → STAR-61 → STAR-62 → STAR-63 → STAR-64 → STAR-65 → STAR-66 → STAR-67 → STAR-68 → STAR-69 → STAR-70 → STAR-71 → STAR-72 → STAR-73 → STAR-74 → STAR-75 → STAR-76 → STAR-77 → STAR-78 → STAR-79 → STAR-80 → STAR-81 → STAR-82 → STAR-83 → STAR-84 → STAR-85 → STAR-86 → STAR-87 → STAR-88 → STAR-89 → STAR-90 → STAR-91 → STAR-92 → STAR-93 → STAR-94 → STAR-95 → STAR-96 → STAR-97 → STAR-98 → STAR-99 → STAR-100",
      resultUrl: "https://acme.atlassian.net/browse/STAR-1",
      error: undefined,
    },
  },
  {
    name: "sprint",
    items: [
      {
        operation: "sprint",
        sprintId: 5,
        sprintName: "Sprint 5b",
        sprintEndDate: "2026-12-05T17:00:00Z",
      },
    ],
    expected: {
      title: "Edit sprint Sprint 5",
      summary: "sprint Sprint 5 (name, end)",
      text: "Prepared a Jira edit proposal for 1 issue(s) pending your approval. Do not claim Jira changed until the approved result appears. When you ask the user to decide, link the card: [Edit sprint Sprint 5](pa://approval/appr_ID).",
      body: {
        kind: "jiraIssue",
        jiraHost: "acme.atlassian.net",
        items: [
          {
            clientId: "item-1",
            issueKey: "",
            operation: "sprint",
            issueUrl: "https://acme.atlassian.net/issues/?jql=sprint%20%3D%205",
            fieldChanges: [],
            sprint: {
              sprintId: 5,
              name: "Sprint 5",
              state: "future",
              boardId: 7,
              changes: [
                { field: "name", from: "Sprint 5", to: "Sprint 5b" },
                {
                  field: "endDate",
                  from: "2026-12-04T17:00:00.000Z",
                  to: "2026-12-05T17:00:00.000Z",
                },
              ],
            },
          },
        ],
      },
      status: "executed",
      resultSummary:
        "Applied 1 change(s); Sprint 5b now 2026-11-23T09:00:00.000Z – 2026-12-05T17:00:00.000Z",
      resultUrl: "https://acme.atlassian.net/issues/?jql=sprint%20%3D%205",
      error: undefined,
    },
  },
  {
    name: "mixed operations",
    items: [
      { issue: "STAR-1", summary: "New summary" },
      { operation: "comment", issue: "STAR-1", commentBody: "Done." },
      {
        operation: "create",
        projectKey: "STAR",
        issueType: "Task",
        summary: "Follow-up",
      },
      {
        operation: "rank",
        rankIssues: ["STAR-2"],
        rankPosition: "after",
        rankTargetIssue: "STAR-3",
      },
      { operation: "sprint", sprintId: 5, sprintGoal: "Ship it" },
    ],
    options: { createdKey: "STAR-202" },
    expected: {
      title: "5 Jira changes",
      summary:
        "STAR-1, comment STAR-1, create STAR Task, rank STAR-2 after, sprint Sprint 5 (goal)",
      text: "Prepared a Jira edit proposal for 5 issue(s) pending your approval. Do not claim Jira changed until the approved result appears. When you ask the user to decide, link the card: [5 Jira changes](pa://approval/appr_ID).",
      body: {
        kind: "jiraIssue",
        jiraHost: "acme.atlassian.net",
        items: [
          {
            clientId: "item-1",
            issueKey: "STAR-1",
            operation: "edit",
            issueId: "10001",
            issueUrl: "https://acme.atlassian.net/browse/STAR-1",
            issueSummary: "Subject",
            currentStatus: "Open",
            targetTransitionId: null,
            targetTransitionName: null,
            targetStatus: null,
            fieldChanges: [
              {
                fieldId: "summary",
                label: "Summary",
                from: "Subject",
                to: "New summary",
                operation: "set",
                value: "New summary",
              },
            ],
          },
          {
            clientId: "item-2",
            issueKey: "STAR-1",
            operation: "comment",
            issueUrl: "https://acme.atlassian.net/browse/STAR-1",
            commentBody: "Done.",
            fieldChanges: [],
          },
          {
            clientId: "item-3",
            issueKey: "",
            operation: "create",
            createProjectKey: "STAR",
            createIssueType: "Task",
            createSummary: "Follow-up",
            fieldChanges: [],
          },
          {
            clientId: "item-4",
            issueKey: "STAR-2",
            operation: "rank",
            issueUrl: "https://acme.atlassian.net/browse/STAR-2",
            issueSummary: "Subject",
            fieldChanges: [],
            rankIssueKeys: ["STAR-2"],
            rankPosition: "after",
            rankTargetIssueKey: "STAR-3",
            rankSteps: [
              {
                issueKey: "STAR-2",
                placement: "after",
                relativeToIssueKey: "STAR-3",
              },
            ],
          },
          {
            clientId: "item-5",
            issueKey: "",
            operation: "sprint",
            issueUrl: "https://acme.atlassian.net/issues/?jql=sprint%20%3D%205",
            fieldChanges: [],
            sprint: {
              sprintId: 5,
              name: "Sprint 5",
              state: "future",
              boardId: 7,
              changes: [{ field: "goal", from: null, to: "Ship it" }],
            },
          },
        ],
      },
      status: "executed",
      resultSummary:
        "Applied 5 change(s) (created STAR-202); order now STAR-2 → STAR-3; Sprint 5 now 2026-11-23T09:00:00.000Z – 2026-12-04T17:00:00.000Z",
      resultUrl: "https://acme.atlassian.net/browse/STAR-1",
      error: undefined,
    },
  },
  {
    name: "partial failure: the second of two comments is refused",
    items: [
      { operation: "comment", issue: "STAR-1", commentBody: "One" },
      { operation: "comment", issue: "STAR-2", commentBody: "Two" },
    ],
    answer: failingComment(2, 400),
    expected: {
      title: "Comment on 2 Jira issues",
      summary: "comment STAR-1, comment STAR-2",
      text: "Prepared a Jira edit proposal for 2 issue(s) pending your approval. Do not claim Jira changed until the approved result appears. When you ask the user to decide, link the card: [Comment on 2 Jira issues](pa://approval/appr_ID).",
      body: {
        kind: "jiraIssue",
        jiraHost: "acme.atlassian.net",
        items: [
          {
            clientId: "item-1",
            issueKey: "STAR-1",
            operation: "comment",
            issueUrl: "https://acme.atlassian.net/browse/STAR-1",
            commentBody: "One",
            fieldChanges: [],
          },
          {
            clientId: "item-2",
            issueKey: "STAR-2",
            operation: "comment",
            issueUrl: "https://acme.atlassian.net/browse/STAR-2",
            commentBody: "Two",
            fieldChanges: [],
          },
        ],
      },
      status: "executed",
      resultSummary: "Applied 1 change(s); 1 failed",
      resultUrl: "https://acme.atlassian.net/browse/STAR-1",
      error: undefined,
    },
  },
  {
    name: "all failed: the only comment is refused",
    items: [{ operation: "comment", issue: "STAR-1", commentBody: "One" }],
    answer: failingComment(1, 403),
    expected: {
      title: "Comment on STAR-1",
      summary: "comment STAR-1",
      text: "Prepared a Jira edit proposal for 1 issue(s) pending your approval. Do not claim Jira changed until the approved result appears. When you ask the user to decide, link the card: [Comment on STAR-1](pa://approval/appr_ID).",
      body: {
        kind: "jiraIssue",
        jiraHost: "acme.atlassian.net",
        items: [
          {
            clientId: "item-1",
            issueKey: "STAR-1",
            operation: "comment",
            issueUrl: "https://acme.atlassian.net/browse/STAR-1",
            commentBody: "One",
            fieldChanges: [],
          },
        ],
      },
      status: "failed",
      resultSummary: undefined,
      resultUrl: undefined,
      error:
        'All 1 Jira change(s) failed: Jira API returned HTTP 403 for POST /rest/api/3/issue/STAR-1/comment: {"errorMessages":["Comment refused"]}',
    },
  },
];

test.each(CASES.map((oracle) => [oracle.name, oracle] as const))(
  "local jira_mutate_issue oracle: %s",
  async (_name, oracle) => {
    expect(await observe(oracle)).toEqual(oracle.expected);
  },
);
