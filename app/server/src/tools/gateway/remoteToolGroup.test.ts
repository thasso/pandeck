/**
 * The gateway Jira tools (Task-1398): a call reaches the port only while the
 * gateway is connected, Jira is on and the latest listing still offers the
 * tool as a read tool; answers and refusals become fixed text, except the
 * gateway's own `tool_error` and `invalid_params` texts.
 */
import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "vitest";
import { updateJiraSettings } from "../../jiraSettings.ts";
import type { ToolCallContext } from "../../mcp/tool.ts";
import {
  RemoteToolRefusal,
  acceptRemoteTools,
  applyListing,
  installRemoteToolPort,
  markDisconnected,
  type RemoteToolAnswer,
} from "../../remoteTools.ts";
import { remoteJiraTools } from "./remoteToolGroup.ts";

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
  const tool = remoteJiraTools().find((t) => t.name === "jira_get_issue");
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
  assert.ok(remoteJiraTools().some((t) => t.name === "jira_get_issue"));

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
  assert.equal(remoteJiraTools()[0], first);
  applyListing(acceptRemoteTools([listed({ description: "Newer." })]));
  const second = remoteJiraTools()[0]!;
  assert.notEqual(second, first);
  assert.equal(second.description, "Newer.");
});
