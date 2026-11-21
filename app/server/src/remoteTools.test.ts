/**
 * Client mode's gateway tool set (Task-1398): what a listing may add, the
 * per-boot state the catalog's remote group and the gate read, and the pi
 * open's wait for the first listing.
 */
import assert from "node:assert/strict";
import { afterEach, test, vi } from "vitest";
import { GatewayUnavailableError } from "./gatewayLink.ts";
import { subscribeIntegrationToolChanges } from "./integrationToolChanges.ts";
import { updateJiraSettings } from "./jiraSettings.ts";
import {
  acceptRemoteTools,
  applyListing,
  installRemoteToolPort,
  knownRemoteTools,
  markDisconnected,
  remoteToolDispatchable,
  remoteToolGate,
  remoteToolsConnected,
  remoteToolsReady,
} from "./remoteTools.ts";
import {
  SLACK_CONVERSATION_READ_DESCRIPTION,
  SLACK_SEARCH_DESCRIPTION,
  SLACK_THREAD_READ_DESCRIPTION,
  SLACK_UNREAD_DESCRIPTION,
  slackConversationReadParamsSchema,
  slackSearchParamsSchema,
  slackThreadReadParamsSchema,
  slackUnreadParamsSchema,
} from "./slackRead.ts";
import { updateSlackSettings } from "./slackSettings.ts";

/** `jira_get_issue` as the edge lists it (`gatewayTools/jiraGetIssue.ts`). */
const JIRA_GET_ISSUE = {
  name: "jira_get_issue",
  description:
    "Fetch one Jira issue by key or id with your Atlassian account. Read-only. When you mention the issue, render its key as a Markdown link using the returned issueUrl.",
  inputSchema: {
    type: "object",
    properties: {
      issue: {
        type: "string",
        description: "Issue key such as OPS-73, or a numeric issue id.",
        pattern: "^(?:[A-Za-z][A-Za-z0-9_]*-\\d+|\\d+)$",
        maxLength: 120,
      },
      includeDescription: {
        type: "boolean",
        description: "Include the description as text and Markdown.",
        default: true,
      },
      includeComments: {
        type: "boolean",
        description: "Include the newest comments.",
        default: false,
      },
      maxComments: {
        type: "integer",
        description: "How many comments, newest first.",
        minimum: 1,
        maximum: 50,
        default: 10,
      },
    },
    required: ["issue"],
    additionalProperties: false,
  },
  effect: "read",
  actionKey: "jira:read",
};

/** The edge's four Slack reads as it lists them (`gatewayTools/slack*.ts`). */
const SLACK_READS = [
  ["slack_search", SLACK_SEARCH_DESCRIPTION, slackSearchParamsSchema],
  [
    "slack_conversation_read",
    SLACK_CONVERSATION_READ_DESCRIPTION,
    slackConversationReadParamsSchema,
  ],
  [
    "slack_thread_read",
    SLACK_THREAD_READ_DESCRIPTION,
    slackThreadReadParamsSchema,
  ],
  ["slack_unread", SLACK_UNREAD_DESCRIPTION, slackUnreadParamsSchema],
].map(([name, description, inputSchema]) => ({
  name,
  description,
  inputSchema,
  effect: "read",
  actionKey: "slack:read",
}));

const tool = (overrides: Record<string, unknown>) => ({
  ...JIRA_GET_ISSUE,
  ...overrides,
});

let uninstall: () => void = () => {};
const install = () => {
  uninstall = installRemoteToolPort({
    call: () => Promise.reject(new Error("unused")),
  });
};

afterEach(() => {
  uninstall();
  vi.useRealTimers();
});

test("the real jira_get_issue descriptor is accepted as listed", () => {
  assert.deepEqual(acceptRemoteTools([JIRA_GET_ISSUE]), [
    { ...JIRA_GET_ISSUE, product: "jira" },
  ]);
});

test("the edge's four real Slack descriptors are accepted as listed", () => {
  // Their descriptions and schemas are within the client's bounds as shipped.
  assert.deepEqual(
    acceptRemoteTools(SLACK_READS),
    SLACK_READS.map((read) => ({ ...read, product: "slack" })),
  );
});

test("each product's tools follow its own Settings toggle", async () => {
  install();
  applyListing(acceptRemoteTools([JIRA_GET_ISSUE, ...SLACK_READS]));
  assert.deepEqual(
    knownRemoteTools("slack").map((t) => t.name),
    [
      "slack_search",
      "slack_conversation_read",
      "slack_thread_read",
      "slack_unread",
    ],
  );
  assert.deepEqual(
    knownRemoteTools("jira").map((t) => t.name),
    ["jira_get_issue"],
  );

  updateSlackSettings({ enabled: true });
  await updateJiraSettings({ enabled: false });
  assert.equal(remoteToolDispatchable("slack_search"), true);
  assert.equal(remoteToolDispatchable("jira_get_issue"), false);
  assert.equal(remoteToolGate("slack"), true);
  assert.equal(remoteToolGate("jira"), false);

  updateSlackSettings({ enabled: false });
  await updateJiraSettings({ enabled: true });
  assert.equal(remoteToolDispatchable("slack_search"), false);
  assert.equal(remoteToolDispatchable("jira_get_issue"), true);
  assert.equal(remoteToolGate("slack"), false);
  assert.equal(remoteToolGate("jira"), true);

  await updateJiraSettings({ enabled: false });
});

test("only bounded read tools of a mapped product are accepted", () => {
  const rejected = [
    tool({ name: "jira_write", effect: "write" }),
    tool({ name: "Bad-Name" }),
    tool({ name: "jira_long", description: "x".repeat(1_025) }),
    tool({ name: "jira_empty", description: "" }),
    tool({
      name: "jira_huge",
      inputSchema: { type: "object", description: "x".repeat(4_096) },
    }),
    tool({ name: "jira_array", inputSchema: { type: "array" } }),
    tool({ name: "jira_list", inputSchema: [] }),
    // Unmapped products stay out, however the prefix is spelled.
    tool({ name: "confluence_page", actionKey: "confluence:read" }),
    tool({ name: "inherited_read", actionKey: "constructor:read" }),
    tool({ name: "slack_upper", actionKey: "Slack:read" }),
    tool({ name: "slack_write", actionKey: "slack:read", effect: "write" }),
    tool({ name: "jira_no_key", actionKey: undefined }),
    "jira_get_issue",
    null,
  ];
  assert.deepEqual(acceptRemoteTools(rejected), []);
  assert.deepEqual(acceptRemoteTools({ tools: [JIRA_GET_ISSUE] }), []);
});

test("the edge's write tool is dropped while its read tools are accepted (Task-1463 AC13)", () => {
  const mutate = tool({
    name: "jira_mutate_issue",
    description: "Create, edit, transition, comment on, link, rank issues.",
    inputSchema: {
      type: "object",
      properties: { items: { type: "array", items: { type: "object" } } },
      required: ["items"],
      additionalProperties: false,
    },
    effect: "write",
    actionKey: "jira:write",
  });
  assert.deepEqual(
    acceptRemoteTools([mutate, JIRA_GET_ISSUE]).map((t) => t.name),
    ["jira_get_issue"],
  );
});

test("a name listed twice is not accepted; only the first 64 entries count", () => {
  assert.deepEqual(
    acceptRemoteTools([
      JIRA_GET_ISSUE,
      tool({ name: "jira_other" }),
      tool({ effect: "write" }),
    ]).map((t) => t.name),
    ["jira_other"],
  );
  const many = Array.from({ length: 70 }, (_, i) =>
    tool({ name: `jira_${i}` }),
  );
  const accepted = acceptRemoteTools(many);
  assert.equal(accepted.length, 64);
  assert.equal(accepted.at(-1)!.name, "jira_63");
});

test("listings grow the known set, replace the current one, and notify", () => {
  install();
  let changes = 0;
  const unsubscribe = subscribeIntegrationToolChanges(() => changes++);
  try {
    applyListing(acceptRemoteTools([JIRA_GET_ISSUE, tool({ name: "jira_b" })]));
    assert.equal(changes, 1);
    assert.equal(remoteToolsConnected(), true);
    assert.ok(remoteToolDispatchable("jira_get_issue") === false); // Jira off
    applyListing(
      acceptRemoteTools([tool({ name: "jira_b", description: "B" })]),
    );
    assert.deepEqual(
      knownRemoteTools("jira").map((t) => [t.name, t.description]),
      [
        ["jira_get_issue", JIRA_GET_ISSUE.description],
        ["jira_b", "B"],
      ],
    );
    markDisconnected();
    assert.equal(changes, 3);
    assert.equal(remoteToolsConnected(), false);
  } finally {
    unsubscribe();
  }
});

test("a throwing subscriber is logged, never thrown into the link", () => {
  install();
  const errors = vi.spyOn(console, "error").mockImplementation(() => {});
  const unsubscribe = subscribeIntegrationToolChanges(() => {
    throw new Error("subscriber broke");
  });
  try {
    applyListing([]);
    markDisconnected();
    assert.equal(errors.mock.calls.length, 2);
  } finally {
    unsubscribe();
    errors.mockRestore();
  }
});

test("a pi open waits for the boot's first listing, even an empty one", async () => {
  // Not client mode: no wait.
  await remoteToolsReady(0);
  install();
  vi.useFakeTimers();
  let ready = false;
  const waiting = remoteToolsReady(10_000).then(() => (ready = true));
  await vi.advanceTimersByTimeAsync(9_000);
  assert.equal(ready, false);
  applyListing([]);
  await waiting;
  // After the first listing nothing waits, even while disconnected.
  markDisconnected();
  await remoteToolsReady(0);

  uninstall();
  install();
  const refused = remoteToolsReady(10_000);
  const rejection = assert.rejects(refused, GatewayUnavailableError);
  await vi.advanceTimersByTimeAsync(10_000);
  await rejection;
});
