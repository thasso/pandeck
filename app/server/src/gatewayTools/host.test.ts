/**
 * The edge's tool host (`host.ts`, Task-1397): schema refusals before any
 * run, settlement on schedule whatever a tool ignores, fixed failure texts,
 * and credential outcomes turned into fixed tool errors. Every value is fake.
 */
import assert from "node:assert/strict";
import { afterEach, test, vi } from "vitest";
import { encodeAtlassianCredential } from "./atlassian.ts";
import {
  ToolError,
  type AtlassianToolDescriptor,
  type SlackToolDescriptor,
} from "./descriptor.ts";
import type { CredentialOutcome } from "./toolCredential.ts";
import { createToolHost, type ToolCaller } from "./host.ts";
import { EDGE_TOOLS } from "./tools.ts";

const SENTINEL = "SENTINEL-do-not-echo";
const FAKE = { site: "acme.atlassian.net", email: "a@x.test", token: "fake-1" };

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function tool(
  execute: AtlassianToolDescriptor["execute"],
  extra: Partial<AtlassianToolDescriptor> = {},
): AtlassianToolDescriptor {
  return {
    name: "probe",
    description: "A test tool.",
    inputSchema: {
      type: "object",
      properties: {
        issue: { type: "string", pattern: "^[A-Z]+-\\d+$", maxLength: 20 },
        count: { type: "integer", minimum: 1, maximum: 5, default: 2 },
        flag: { type: "boolean" },
      },
      required: ["issue"],
      additionalProperties: false,
    },
    effect: "read",
    actionKey: "probe:read",
    integration: "atlassian",
    execute,
    ...extra,
  };
}

function caller(
  outcome: () => Promise<CredentialOutcome> = () =>
    Promise.resolve({ ok: true, credential: encodeAtlassianCredential(FAKE) }),
  signal?: AbortSignal,
): ToolCaller {
  return {
    clientId: "client-1",
    credential: () => outcome(),
    ...(signal ? { signal } : {}),
  };
}

test("the registry lists Jira's, Confluence's and Slack's read tools with their schemas, effect and action key", () => {
  const host = createToolHost(EDGE_TOOLS, { log: () => {} });
  assert.deepEqual(
    host.list().map((t) => [t.name, t.effect, t.actionKey]),
    [
      ["jira_get_issue", "read", "jira:read"],
      ["jira_search_issues", "read", "jira:read"],
      ["jira_lookup", "read", "jira:read"],
      ["confluence_search", "read", "confluence:read"],
      ["confluence_get_page", "read", "confluence:read"],
      ["confluence_lookup", "read", "confluence:read"],
      ["slack_search", "read", "slack:read"],
      ["slack_conversation_read", "read", "slack:read"],
      ["slack_thread_read", "read", "slack:read"],
      ["slack_unread", "read", "slack:read"],
    ],
  );
  const [listed] = host.list();
  assert.deepEqual(listed!.inputSchema.required, ["issue"]);
  assert.equal(listed!.inputSchema.additionalProperties, false);
});

test("arguments failing the schema are refused before the tool runs", async () => {
  const execute = vi.fn(async () => ({}));
  const host = createToolHost([tool(execute)], { log: () => {} });
  const cases: [unknown, RegExp][] = [
    [{ issue: "OPS-1", [SENTINEL]: 1 }, /unknown property/],
    [{ issue: 7 }, /issue must be a string/],
    [{}, /issue is required/],
    [{ issue: "../x" }, /issue does not have the expected form/],
    [{ issue: "OPS-1", count: 9 }, /count is out of range/],
    [{ issue: "OPS-1", flag: "yes" }, /flag must be a boolean/],
    [[1], /an object is required/],
  ];
  for (const [args, message] of cases) {
    const answer = await host.call("probe", args, caller());
    assert.equal(answer.ok, false);
    assert.ok(!answer.ok && answer.code === "invalid_params");
    assert.match(answer.message, message);
    assert.doesNotMatch(answer.message, new RegExp(SENTINEL));
  }
  assert.equal(execute.mock.calls.length, 0);
  const unknown = await host.call(SENTINEL, {}, caller());
  assert.deepEqual(unknown, {
    ok: false,
    code: "unknown_tool",
    message: "No such tool.",
  });
});

test("defaults fill in and the result comes back as JSON", async () => {
  const host = createToolHost([tool(async (params) => ({ got: params }))], {
    log: () => {},
  });
  assert.deepEqual(await host.call("probe", { issue: "OPS-1" }, caller()), {
    ok: true,
    text: JSON.stringify({ got: { issue: "OPS-1", count: 2 } }),
  });
});

test("a foreign error is a fixed failure; its text reaches neither the answer nor the log", async () => {
  const lines: string[] = [];
  const host = createToolHost(
    [
      tool(async () => {
        throw new Error(SENTINEL);
      }),
    ],
    { log: (line) => lines.push(line) },
  );
  const answer = await host.call("probe", { issue: "OPS-1" }, caller());
  assert.deepEqual(answer, {
    ok: false,
    code: "failed",
    message: "probe failed.",
  });
  assert.equal(lines.length, 1);
  assert.match(lines[0]!, /^tool probe client client-1 failed \d+ms$/);
  assert.doesNotMatch(lines.join("\n"), new RegExp(SENTINEL));
});

test("a ToolError passes its text; an oversized result is refused", async () => {
  const host = createToolHost(
    [
      tool(async () => {
        throw new ToolError("Fixed edge text.");
      }),
      tool(async () => "x".repeat(50), { name: "big", maxResultChars: 10 }),
    ],
    { log: () => {} },
  );
  assert.deepEqual(await host.call("probe", { issue: "OPS-1" }, caller()), {
    ok: false,
    code: "tool_error",
    message: "Fixed edge text.",
  });
  const big = await host.call("big", { issue: "OPS-1" }, caller());
  assert.ok(!big.ok && big.code === "result_too_large");
});

test("the deadline answers timeout and aborts the tool's signal", async () => {
  let seen: AbortSignal | undefined;
  const host = createToolHost(
    [
      tool(
        (_params, ctx) =>
          new Promise((_resolve, reject) => {
            seen = ctx.signal;
            ctx.signal.addEventListener("abort", () => reject(new Error("x")));
          }),
      ),
    ],
    { deadlineMs: 30, log: () => {} },
  );
  const answer = await host.call("probe", { issue: "OPS-1" }, caller());
  assert.deepEqual(answer, {
    ok: false,
    code: "timeout",
    message: "The tool timed out.",
  });
  assert.equal(seen?.aborted, true);
});

test("a tool that ignores its signal and never settles still times out on schedule", async () => {
  const host = createToolHost([tool(() => new Promise(() => {}))], {
    deadlineMs: 40,
    log: () => {},
  });
  const started = Date.now();
  const answer = await host.call("probe", { issue: "OPS-1" }, caller());
  assert.ok(!answer.ok && answer.code === "timeout");
  assert.ok(Date.now() - started < 1_000, "settled near the deadline");
});

test("a caller abort answers cancelled", async () => {
  const controller = new AbortController();
  const host = createToolHost([tool(() => new Promise(() => {}))], {
    log: () => {},
  });
  const pending = host.call(
    "probe",
    { issue: "OPS-1" },
    caller(undefined, controller.signal),
  );
  setTimeout(() => controller.abort(), 10);
  assert.deepEqual(await pending, {
    ok: false,
    code: "cancelled",
    message: "The call was cancelled.",
  });
});

test("a credential read that never settles times out, or is cancelled", async () => {
  const never = () => new Promise<CredentialOutcome>(() => {});
  const run = vi.fn(async () => ({}));
  const host = createToolHost(
    [
      tool(async (_params, ctx) => {
        await ctx.credential();
        return run();
      }),
    ],
    { deadlineMs: 40, log: () => {} },
  );
  const timedOut = await host.call("probe", { issue: "OPS-1" }, caller(never));
  assert.ok(!timedOut.ok && timedOut.code === "timeout");
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 5);
  const cancelled = await host.call(
    "probe",
    { issue: "OPS-1" },
    caller(never, controller.signal),
  );
  assert.ok(!cancelled.ok && cancelled.code === "cancelled");
  assert.equal(run.mock.calls.length, 0);
});

test("a credential resolved after the abort is dropped before the tool's next step", async () => {
  const fetch = vi.fn(async () => new Response("{}"));
  vi.stubGlobal("fetch", fetch);
  const rejections: unknown[] = [];
  const onRejection = (reason: unknown) => rejections.push(reason);
  process.on("unhandledRejection", onRejection);
  let release!: (outcome: CredentialOutcome) => void;
  let fail!: (err: Error) => void;
  const late = () =>
    new Promise<CredentialOutcome>((resolve) => {
      release = resolve;
    });
  const lateRejection = () =>
    new Promise<CredentialOutcome>((_resolve, reject) => {
      fail = reject;
    });
  const host = createToolHost(EDGE_TOOLS, { deadlineMs: 30, log: () => {} });
  try {
    const answer = await host.call(
      "jira_get_issue",
      { issue: "OPS-73" },
      caller(late),
    );
    assert.ok(!answer.ok && answer.code === "timeout");
    release({ ok: true, credential: encodeAtlassianCredential(FAKE) });
    const second = await host.call(
      "jira_get_issue",
      { issue: "OPS-73" },
      caller(lateRejection),
    );
    assert.ok(!second.ok && second.code === "timeout");
    fail(new Error(SENTINEL));
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(fetch.mock.calls.length, 0, "no Jira request after the abort");
    assert.deepEqual(rejections, []);
  } finally {
    process.off("unhandledRejection", onRejection);
  }
});

test("credential outcomes become fixed tool errors; an undecodable credential is never echoed", async () => {
  const lines: string[] = [];
  const host = createToolHost(EDGE_TOOLS, { log: (line) => lines.push(line) });
  const cases: [CredentialOutcome, string][] = [
    [
      { ok: false, absent: true },
      "Jira is not connected for this user; connect it in Pandeck's Settings.",
    ],
    [
      { ok: false, rejected: true },
      "Atlassian rejected the credential; reconnect Jira on the gateway's page.",
    ],
    [{ ok: false, locked: true }, "The vault is locked."],
    [{ ok: false, unavailable: true }, "The vault did not answer; try again."],
    [
      { ok: true, credential: `{"site":"${SENTINEL}.evil.com"}` },
      "The stored Jira credential is invalid; reconnect Jira in Pandeck's Settings.",
    ],
  ];
  for (const [outcome, message] of cases)
    assert.deepEqual(
      await host.call(
        "jira_get_issue",
        { issue: "OPS-73" },
        caller(() => Promise.resolve(outcome)),
      ),
      { ok: false, code: "tool_error", message },
    );
  assert.doesNotMatch(lines.join("\n"), new RegExp(SENTINEL));
});

const SLACK_VIEW = {
  kind: "slack-oauth",
  teamId: "THOST01",
  workspaceHost: "acme.slack.com",
  userId: "UHOST01",
  scope: "search:read",
  accessToken: "fake-access",
  expiresAt: 4_102_444_800_000,
};

/** A Slack probe: answers the team of the view it was handed. */
function slackTool(): SlackToolDescriptor {
  return {
    name: "slack_probe",
    description: "A test tool.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    effect: "read",
    actionKey: "probe:read",
    integration: "slack",
    execute: async (_params, ctx) => ({
      teamId: (await ctx.credential()).teamId,
    }),
  };
}

test("a Slack tool asks the vault for Slack and gets the decoded view", async () => {
  const asked: string[] = [];
  const atlassian = tool(async (_params, ctx) => ctx.credential());
  const host = createToolHost([slackTool(), atlassian], {
    log: () => {},
  });
  const answer = await host.call(
    "slack_probe",
    {},
    {
      clientId: "client-1",
      credential: (integration) => {
        asked.push(integration);
        return Promise.resolve({
          ok: true,
          credential: JSON.stringify(SLACK_VIEW),
        });
      },
    },
  );
  assert.deepEqual(answer, { ok: true, text: '{"teamId":"THOST01"}' });
  await host.call(
    "probe",
    { issue: "OPS-1" },
    {
      clientId: "client-1",
      credential: (integration) => {
        asked.push(integration);
        return Promise.resolve({ ok: false, absent: true });
      },
    },
  );
  assert.deepEqual(asked, ["slack", "atlassian"]);
});

test("Slack credential outcomes become Slack's fixed texts; a view of the other kind is invalid", async () => {
  const fetch = vi.fn(async () => new Response("{}"));
  vi.stubGlobal("fetch", fetch);
  const lines: string[] = [];
  const host = createToolHost(EDGE_TOOLS, { log: (line) => lines.push(line) });
  const invalid =
    "The stored Slack credential is invalid; reconnect Slack on the gateway's page.";
  const cases: [CredentialOutcome, string][] = [
    [
      { ok: false, absent: true },
      "Slack is not connected for this user; connect it on the gateway's page.",
    ],
    [
      { ok: false, rejected: true },
      "Slack rejected the credential; reconnect Slack on the gateway's page.",
    ],
    [{ ok: false, locked: true }, "The vault is locked."],
    [{ ok: false, unavailable: true }, "The vault did not answer; try again."],
    [
      { ok: true, credential: `{"kind":"slack-oauth","teamId":"${SENTINEL}"}` },
      invalid,
    ],
    // An Atlassian credential handed to a Slack tool.
    [{ ok: true, credential: encodeAtlassianCredential(FAKE) }, invalid],
  ];
  for (const [outcome, message] of cases)
    assert.deepEqual(
      await host.call(
        "slack_search",
        { query: "x" },
        caller(() => Promise.resolve(outcome)),
      ),
      { ok: false, code: "tool_error", message },
    );
  // A Slack view handed to a Jira tool.
  assert.deepEqual(
    await host.call(
      "jira_get_issue",
      { issue: "OPS-73" },
      caller(() =>
        Promise.resolve({ ok: true, credential: JSON.stringify(SLACK_VIEW) }),
      ),
    ),
    {
      ok: false,
      code: "tool_error",
      message:
        "The stored Jira credential is invalid; reconnect Jira in Pandeck's Settings.",
    },
  );
  assert.equal(fetch.mock.calls.length, 0, "no upstream request");
  assert.doesNotMatch(lines.join("\n"), new RegExp(SENTINEL));
});
