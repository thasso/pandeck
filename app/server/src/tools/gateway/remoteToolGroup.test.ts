/**
 * The gateway tools (Task-1398, Slack Task-1455, Confluence Task-1439): a call reaches the port
 * only while the gateway is connected, the tool's product is on and the
 * latest listing still offers the tool as a read tool; answers and refusals become fixed text, except the
 * gateway's own `tool_error` and `invalid_params` texts.
 */
import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "vitest";
import {
  getConfluenceToolConfig,
  updateConfluenceSettings,
} from "../../confluenceSettings.ts";
import { updateJiraSettings } from "../../jiraSettings.ts";
import type { ToolCallContext } from "../../mcp/tool.ts";
import { updateSlackSettings } from "../../slackSettings.ts";
import {
  RemoteToolRefusal,
  acceptRemoteTools,
  applyListing,
  installRemoteToolPort,
  markDisconnected,
  type RemoteToolAnswer,
} from "../../remoteTools.ts";
import { remoteToolsFor } from "./remoteToolGroup.ts";

const listed = (overrides: Record<string, unknown> = {}) => ({
  name: "jira_get_issue",
  description: "Fetch one Jira issue.",
  inputSchema: { type: "object", properties: {} },
  effect: "read",
  actionKey: "jira:read",
  ...overrides,
});

interface PortCall {
  name: string;
  args: Record<string, unknown>;
  signal: AbortSignal;
}

let calls: PortCall[] = [];
let answer: () => Promise<RemoteToolAnswer>;
let uninstall: () => void = () => {};

beforeEach(async () => {
  calls = [];
  answer = () => Promise.resolve({ ok: true, text: '{"key":"OPS-1"}' });
  uninstall = installRemoteToolPort({
    call: (name, args, signal) => {
      calls.push({ name, args, signal });
      return answer();
    },
  });
  await updateJiraSettings({ enabled: true });
});

afterEach(() => uninstall());

const ctx = (signal?: AbortSignal) =>
  ({ ...(signal ? { signal } : {}) }) as ToolCallContext;

function capture() {
  applyListing(acceptRemoteTools([listed()]));
  const tool = remoteToolsFor("jira").find((t) => t.name === "jira_get_issue");
  assert.ok(tool);
  return tool;
}

test("a listed tool is a read tool whose call answers the gateway's text", async () => {
  const tool = capture();
  assert.equal(tool.sideEffects, "none");
  assert.deepEqual(tool.parameters, { type: "object", properties: {} });
  const signal = new AbortController().signal;
  assert.deepEqual(await tool.execute({ issue: "OPS-1" }, ctx(signal)), {
    content: [{ type: "text", text: '{"key":"OPS-1"}' }],
  });
  assert.deepEqual(calls, [
    { name: "jira_get_issue", args: { issue: "OPS-1" }, signal },
  ]);
  // Without the caller's signal the port still gets one.
  await tool.execute({}, ctx());
  assert.ok(calls[1]!.signal instanceof AbortSignal);
});

test("every failure has fixed text; only tool_error and invalid_params carry the gateway's", async () => {
  const tool = capture();
  const cases: [RemoteToolAnswer | RemoteToolRefusal, string][] = [
    [
      { ok: false, code: "tool_error", message: "Issue not found." },
      "Issue not found.",
    ],
    [
      { ok: false, code: "invalid_params", message: "issue is required." },
      "issue is required.",
    ],
    [
      { ok: false, code: "unknown_tool", message: "SENTINEL" },
      "The gateway no longer offers jira_get_issue.",
    ],
    [
      { ok: false, code: "result_too_large", message: "SENTINEL" },
      "The gateway tool's result is too large.",
    ],
    [
      { ok: false, code: "timeout", message: "SENTINEL" },
      "The gateway tool timed out.",
    ],
    [
      { ok: false, code: "cancelled", message: "SENTINEL" },
      "The call was cancelled.",
    ],
    [
      { ok: false, code: "failed", message: "SENTINEL" },
      "jira_get_issue failed on the gateway.",
    ],
    [
      new RemoteToolRefusal("tools_unavailable"),
      "The credential gateway runs no tools.",
    ],
    [
      new RemoteToolRefusal("gateway_unavailable"),
      "The credential gateway is unreachable; try again shortly.",
    ],
  ];
  for (const [outcome, text] of cases) {
    answer = () =>
      outcome instanceof RemoteToolRefusal
        ? Promise.reject(outcome)
        : Promise.resolve(outcome);
    await assert.rejects(tool.execute({}, ctx()), { message: text });
  }
  answer = () => Promise.reject(new Error("SENTINEL"));
  await assert.rejects(tool.execute({}, ctx()), {
    message: "The credential gateway is unreachable; try again shortly.",
  });
  // An over-long gateway text is cut.
  answer = () =>
    Promise.resolve({
      ok: false,
      code: "tool_error",
      message: "x".repeat(900),
    });
  await assert.rejects(tool.execute({}, ctx()), (err: Error) => {
    assert.equal(err.message.length, 500);
    return true;
  });
});

test("a retained tool is refused before any port call once removed, turned write, disconnected or disabled", async () => {
  const tool = capture();
  const refused = async (message: string) => {
    await assert.rejects(tool.execute({}, ctx()), { message });
    assert.equal(calls.length, 0);
  };

  applyListing(acceptRemoteTools([listed({ name: "jira_other" })]));
  await refused("The gateway no longer offers jira_get_issue.");
  applyListing(acceptRemoteTools([listed({ effect: "write" })]));
  await refused("The gateway no longer offers jira_get_issue.");
  // The tool stays in the group for the boot.
  assert.ok(remoteToolsFor("jira").some((t) => t.name === "jira_get_issue"));

  applyListing(acceptRemoteTools([listed()]));
  markDisconnected();
  await refused("The credential gateway is unreachable; try again shortly.");

  applyListing(acceptRemoteTools([listed()]));
  await updateJiraSettings({ enabled: false });
  await refused("Jira tools are disabled. Enable them in Settings → Jira.");

  await updateJiraSettings({ enabled: true });
  await tool.execute({}, ctx());
  assert.equal(calls.length, 1);
});

test("a tool is rebuilt only when its descriptor changes", () => {
  const first = capture();
  assert.equal(remoteToolsFor("jira")[0], first);
  applyListing(acceptRemoteTools([listed({ description: "Newer." })]));
  const second = remoteToolsFor("jira")[0]!;
  assert.notEqual(second, first);
  assert.equal(second.description, "Newer.");
});

test("a Slack tool follows the Slack toggle, not Jira's, and passes the edge's text", async () => {
  const slackSearch = listed({
    name: "slack_search",
    description: "Search Slack messages.",
    actionKey: "slack:read",
  });
  applyListing(acceptRemoteTools([listed(), slackSearch]));
  assert.deepEqual(
    remoteToolsFor("slack").map((t) => [t.name, t.sideEffects]),
    [["slack_search", "none"]],
  );
  const tool = remoteToolsFor("slack")[0]!;

  // Slack off, Jira on: refused before any port call.
  updateSlackSettings({ enabled: false });
  await assert.rejects(tool.execute({ query: "x" }, ctx()), {
    message: "Slack tools are disabled. Enable them in Settings → Slack.",
  });
  assert.equal(calls.length, 0);

  // Slack on, Jira off: reaches the port with its name and arguments.
  updateSlackSettings({ enabled: true });
  await updateJiraSettings({ enabled: false });
  const signal = new AbortController().signal;
  await tool.execute({ query: "x" }, ctx(signal));
  assert.deepEqual(calls, [
    { name: "slack_search", args: { query: "x" }, signal },
  ]);

  // The edge's absent-credential text (`gatewayTools/toolCredential.ts`).
  const notConnected =
    "Slack is not connected for this user; connect it on the gateway's page.";
  answer = () =>
    Promise.resolve({ ok: false, code: "tool_error", message: notConnected });
  await assert.rejects(tool.execute({ query: "x" }, ctx()), {
    message: notConnected,
  });
  updateSlackSettings({ enabled: false });
});

test("a Confluence tool follows the Confluence toggle, not Jira's, with its own disabled text", async () => {
  const reads = [
    "confluence_search",
    "confluence_get_page",
    "confluence_lookup",
  ].map((name) =>
    listed({ name, description: `${name}.`, actionKey: "confluence:read" }),
  );
  applyListing(acceptRemoteTools([listed(), ...reads]));
  assert.deepEqual(
    remoteToolsFor("confluence").map((t) => [t.name, t.sideEffects]),
    [
      ["confluence_search", "none"],
      ["confluence_get_page", "none"],
      ["confluence_lookup", "none"],
    ],
  );
  const tool = remoteToolsFor("confluence")[0]!;
  // Built once while its descriptor stays.
  assert.equal(remoteToolsFor("confluence")[0], tool);
  try {
    // Confluence off, Jira on: refused before any port call, in the local
    // tools' own text.
    updateConfluenceSettings({ enabled: false });
    const disabled =
      "Confluence tools are disabled. Enable them in Settings → Confluence.";
    assert.throws(() => getConfluenceToolConfig(), { message: disabled });
    await assert.rejects(tool.execute({ query: "x" }, ctx()), {
      message: disabled,
    });
    assert.equal(calls.length, 0);

    // Confluence on, Jira off: reaches the port with its name and arguments.
    updateConfluenceSettings({ enabled: true });
    await updateJiraSettings({ enabled: false });
    const signal = new AbortController().signal;
    await tool.execute({ query: "x" }, ctx(signal));
    assert.deepEqual(calls, [
      { name: "confluence_search", args: { query: "x" }, signal },
    ]);
  } finally {
    updateConfluenceSettings({ enabled: false });
  }
});
