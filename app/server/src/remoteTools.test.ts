/**
 * Client mode's gateway tool set (Task-1398): what a listing may add, the
 * per-boot state the catalog's remote group and the gate read, and the pi
 * open's wait for the first listing.
 */
import assert from "node:assert/strict";
import { afterEach, test, vi } from "vitest";
import { GatewayUnavailableError } from "./gatewayLink.ts";
import { subscribeIntegrationToolChanges } from "./integrationToolChanges.ts";
import {
  acceptRemoteTools,
  applyListing,
  installRemoteToolPort,
  knownRemoteTools,
  markDisconnected,
  remoteToolDispatchable,
  remoteToolsConnected,
  remoteToolsReady,
} from "./remoteTools.ts";

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
    tool({ name: "confluence_page", actionKey: "confluence:read" }),
    tool({ name: "jira_no_key", actionKey: undefined }),
    "jira_get_issue",
    null,
  ];
  assert.deepEqual(acceptRemoteTools(rejected), []);
  assert.deepEqual(acceptRemoteTools({ tools: [JIRA_GET_ISSUE] }), []);
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
