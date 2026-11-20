/**
 * The edge's Slack reads (Task-1454): every core failure answers a fixed,
 * edge-owned text. Sentinels sit in the input, in Slack's `error` field and
 * body, in headers and in the token; no answer or log line holds one. Every
 * value is fake.
 */
import assert from "node:assert/strict";
import { afterEach, beforeEach, test, vi } from "vitest";
import { clearSlackMetadataCaches } from "../slackRead.ts";
import type { ToolDescriptor } from "./descriptor.ts";
import { createToolHost, type ToolCaller } from "./host.ts";
import { slackReadFailure } from "./slackRead.ts";
import { EDGE_TOOLS } from "./tools.ts";

const SENTINEL = "sentinel-do-not-echo";
const TOKEN = "fake-slack-access-sentinel-do-not-echo";
const VIEW = {
  kind: "slack-oauth",
  teamId: "TEDGE01",
  workspaceHost: "acme.slack.com",
  userId: "UEDGE01",
  scope: "search:read,channels:history",
  accessToken: TOKEN,
  expiresAt: 4_102_444_800_000,
};

type Handler = () => Response | Record<string, unknown>;
let handlers: Record<string, Handler> = {};
let lines: string[] = [];

beforeEach(() => {
  clearSlackMetadataCaches();
  lines = [];
  handlers = {
    "users.info": () => ({ ok: true, user: { id: VIEW.userId } }),
  };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string) => {
      const method = String(input).replace("https://slack.com/api/", "");
      const handler = handlers[method];
      if (!handler) throw new Error(`unexpected ${method}`);
      const answer = handler();
      return answer instanceof Response
        ? answer
        : new Response(JSON.stringify(answer));
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const caller: ToolCaller = {
  clientId: "client-1",
  credential: () =>
    Promise.resolve({ ok: true, credential: JSON.stringify(VIEW) }),
};

async function failsWith(name: string, args: object, message: string) {
  // Each row asks Slack afresh, the profile timezone included.
  clearSlackMetadataCaches();
  const host = createToolHost(EDGE_TOOLS, { log: (line) => lines.push(line) });
  const answer = await host.call(name, args, caller);
  assert.deepEqual(answer, { ok: false, code: "tool_error", message }, name);
  const seen = JSON.stringify(answer) + lines.join("\n");
  assert.ok(!seen.includes(SENTINEL), `${name}: ${message}`);
  assert.ok(!seen.includes(TOKEN));
}

const list =
  (...channels: object[]): Handler =>
  () => ({ ok: true, channels });
const members =
  (...users: object[]): Handler =>
  () => ({ ok: true, members: users });

test("input refusals answer the local wording without the input", async () => {
  await failsWith("slack_search", { query: "   " }, "query must not be empty.");
  await failsWith(
    "slack_thread_read",
    { conversation: " # ", threadTs: "1700000000.000100" },
    "conversation must not be empty.",
  );
  await failsWith("slack_unread", { person: "@" }, "person must not be empty.");
  await failsWith(
    "slack_thread_read",
    { conversation: "C1", threadTs: SENTINEL },
    "threadTs must be a Slack timestamp such as 1717426730.123456.",
  );
  await failsWith(
    "slack_conversation_read",
    { conversation: "C1", date: SENTINEL },
    "date must be YYYY-MM-DD.",
  );
  await failsWith(
    "slack_conversation_read",
    { conversation: "C1", oldest: SENTINEL },
    "oldest and latest must be a Slack timestamp, epoch seconds or RFC3339.",
  );
});

test("resolution refusals name no candidate and echo no input", async () => {
  handlers["conversations.list"] = list(
    { id: "C1", name: SENTINEL },
    { id: "C2", name: SENTINEL.toUpperCase() },
  );
  handlers["users.list"] = members(
    { id: "U1", name: `${SENTINEL}-twin` },
    { id: "U2", name: `${SENTINEL}-twin` },
    { id: "U3", name: `${SENTINEL}-gone`, deleted: true },
  );
  await failsWith(
    "slack_conversation_read",
    { conversation: SENTINEL },
    "That conversation name matches more than one conversation; use a conversation id.",
  );
  await failsWith(
    "slack_conversation_read",
    { conversation: `${SENTINEL}-nowhere` },
    "No accessible Slack conversation matches; use a channel or DM id, an accessible channel name, or an unambiguous person name.",
  );
  await failsWith(
    "slack_unread",
    { person: `${SENTINEL}-twin` },
    "That name matches more than one Slack user; use a user id.",
  );
  await failsWith(
    "slack_unread",
    { person: `${SENTINEL}-gone` },
    "That name matches only deactivated Slack users.",
  );
  await failsWith(
    "slack_unread",
    { person: `${SENTINEL}-nobody` },
    "No Slack user matches that name.",
  );
});

test("Slack's error codes answer by kind, never by their text", async () => {
  const refusal = (error: string): Handler => {
    return () => ({ ok: false, error, detail: SENTINEL, echoed: TOKEN });
  };
  for (const code of [
    "not_authed",
    "invalid_auth",
    "token_revoked",
    "token_expired",
    "account_inactive",
  ]) {
    handlers["search.messages"] = refusal(code);
    await failsWith(
      "slack_search",
      { query: "x" },
      "Slack rejected the credential; reconnect Slack on the gateway's page.",
    );
  }
  handlers["search.messages"] = refusal("missing_scope");
  await failsWith(
    "slack_search",
    { query: "x" },
    "Slack refused: the connection lacks a permission this read needs; reconnect Slack on the gateway's page.",
  );
  for (const code of ["channel_not_found", "not_in_channel"]) {
    handlers["conversations.history"] = refusal(code);
    await failsWith(
      "slack_conversation_read",
      { conversation: "C1" },
      "Slack found no such conversation for this user.",
    );
  }
  handlers["conversations.replies"] = refusal("thread_not_found");
  await failsWith(
    "slack_thread_read",
    { conversation: "C1", threadTs: "1700000000.000100" },
    "Slack found no such thread in that conversation.",
  );
  handlers["search.messages"] = refusal("ratelimited");
  await failsWith(
    "slack_search",
    { query: "x" },
    "Slack is rate-limiting search.messages; try again in a minute.",
  );
  handlers["search.messages"] = refusal(`${SENTINEL}_code`);
  await failsWith(
    "slack_search",
    { query: "x" },
    "Slack refused search.messages.",
  );
  // The profile timezone read fails the call the same way.
  handlers["users.info"] = refusal("invalid_auth");
  await failsWith(
    "slack_search",
    { query: "x" },
    "Slack rejected the credential; reconnect Slack on the gateway's page.",
  );
});

test("rate limits, statuses and unreadable answers have fixed texts", async () => {
  const limited =
    (retryAfter?: string): Handler =>
    () =>
      new Response(SENTINEL, {
        status: 429,
        ...(retryAfter !== undefined
          ? { headers: { "retry-after": retryAfter } }
          : {}),
      });
  handlers["conversations.list"] = limited("30");
  await failsWith(
    "slack_unread",
    {},
    "Slack is rate-limiting conversations.list; retry after 30 seconds.",
  );
  for (const malformed of [`${SENTINEL}`, "0", "99999", "-5", undefined]) {
    handlers["conversations.list"] = limited(malformed);
    await failsWith(
      "slack_unread",
      {},
      "Slack is rate-limiting conversations.list; try again in a minute.",
    );
  }
  handlers["search.messages"] = () =>
    new Response(`${SENTINEL} ${TOKEN}`, { status: 502 });
  await failsWith("slack_search", { query: "x" }, "Slack answered HTTP 502.");
  handlers["search.messages"] = () => new Response(`<${SENTINEL}>`);
  await failsWith(
    "slack_search",
    { query: "x" },
    "Slack's answer could not be read.",
  );
});

test("aborts and unknown errors are thrown on for the host to classify", () => {
  const abort = new Error("aborted");
  abort.name = "AbortError";
  const unknown = new Error(SENTINEL);
  for (const err of [abort, unknown])
    assert.throws(
      () => slackReadFailure(err),
      (thrown: unknown) => thrown === err,
    );
});

test("a descriptor's credential is its own integration's", () => {
  const base = {
    name: "probe",
    description: "A test tool.",
    inputSchema: {
      type: "object" as const,
      properties: {},
      additionalProperties: false as const,
    },
    effect: "read" as const,
    actionKey: "probe:read",
  };
  const slackProbe: ToolDescriptor = {
    ...base,
    integration: "slack",
    async execute(_params, ctx) {
      // @ts-expect-error A Slack access view has no cloud id.
      return (await ctx.credential()).cloudId;
    },
  };
  const atlassianProbe: ToolDescriptor = {
    ...base,
    integration: "atlassian",
    async execute(_params, ctx) {
      // @ts-expect-error An Atlassian credential has no workspace host.
      return (await ctx.credential()).workspaceHost;
    },
  };
  assert.deepEqual(
    [slackProbe.integration, atlassianProbe.integration],
    ["slack", "atlassian"],
  );
});
