import assert from "node:assert/strict";
import { beforeEach, describe, test, vi } from "vitest";
import { createSlackMetadataCache } from "./slackMetadataCache.ts";
import {
  SlackAnswerError,
  SlackApiError,
  SlackHttpError,
  SlackReadRefusal,
  clearSlackMetadataCaches,
  runSlackConversationRead,
  runSlackSearch,
  runSlackThreadRead,
  runSlackUnread,
  slackProfileTimeZone,
  type SlackReadCache,
  type SlackReadConfig,
  type SlackReadRefusalCode,
} from "./slackRead.ts";

const config = (over: Partial<SlackReadConfig> = {}): SlackReadConfig => ({
  token: "xoxp-token-a",
  teamId: "T1",
  workspaceHost: "example.slack.com",
  timezone: "UTC",
  defaultMaxResults: 20,
  grantedUserScopes: [],
  source: "test",
  cacheKey: "T1:UA",
  unreadListMaxAgeMs: 0,
  ...over,
});

/** A production-sized cache on a clock the test moves. */
function clockedCache(maxUsersPerKey = 10_000) {
  const clock = { now: 0 };
  const cache: SlackReadCache = createSlackMetadataCache({
    maxKeys: 32,
    maxUsersPerKey,
    ttlMs: 300_000,
    now: () => clock.now,
  });
  return { clock, cache };
}

type Answer = Response | Record<string, unknown>;
type Handler = (params: URLSearchParams, token: string) => Answer;
interface Call {
  url: string;
  method: string;
  init: RequestInit;
  params: URLSearchParams;
  token: string;
}

/** Stubs the global fetch with one handler per Web API method. */
function stubSlack(handlers: Record<string, Handler>) {
  const calls: Call[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = String(input);
    const method = url.replace(/^https:\/\/slack\.com\/api\//, "");
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const token = (headers.authorization ?? "").replace(/^Bearer /, "");
    const params = new URLSearchParams(String(init?.body));
    calls.push({ url, method, init: init ?? {}, params, token });
    const handler = handlers[method];
    if (!handler) throw new Error(`unexpected Slack method ${method}`);
    const answer = handler(params, token);
    return answer instanceof Response
      ? answer
      : new Response(JSON.stringify(answer), { status: 200 });
  });
  return {
    calls,
    count: (method: string, token?: string) =>
      calls.filter(
        (call) =>
          call.method === method &&
          (token === undefined || call.token === token),
      ).length,
  };
}

// Not "general": the resolver reads G + alphanumerics as a group id.
const random = { id: "C1", name: "random" };
const history = () => ({ ok: true, messages: [] });
const listOf =
  (...channels: Array<Record<string, unknown>>) =>
  () => ({ ok: true, channels });

beforeEach(() => {
  vi.restoreAllMocks();
  clearSlackMetadataCaches();
});

describe("Slack read core: per-caller metadata", () => {
  test("one caller's conversation list never resolves another caller's name", async () => {
    const slack = stubSlack({
      "conversations.list": (_params, token) =>
        token === "xoxp-token-a"
          ? { ok: true, channels: [{ id: "C1", name: "alpha" }] }
          : { ok: true, channels: [{ id: "C2", name: "beta" }] },
      "users.list": () => ({ ok: true, members: [] }),
      "conversations.history": history,
    });
    const { cache } = clockedCache();
    const a = config();
    const b = config({ token: "xoxp-token-b", cacheKey: "T1:UB" });

    for (let round = 0; round < 2; round++) {
      const payload = await runSlackConversationRead(
        { conversation: "alpha" },
        a,
        { cache },
      );
      assert.equal((payload.conversation as { id: string }).id, "C1");
      await assert.rejects(
        runSlackConversationRead({ conversation: "alpha" }, b, { cache }),
        (error: unknown) =>
          error instanceof SlackReadRefusal &&
          error.code === "conversation_not_found",
      );
    }
    assert.equal(slack.count("conversations.list", "xoxp-token-a"), 1);
    assert.equal(slack.count("conversations.list", "xoxp-token-b"), 1);
  });

  test("a user dropped past the per-caller cap is asked for again", async () => {
    const slack = stubSlack({
      "conversations.history": () => ({
        ok: true,
        messages: [
          { ts: "1700000004.000000", text: "<@U1>" },
          { ts: "1700000003.000000", text: "<@U2>" },
          { ts: "1700000002.000000", text: "<@U3>" },
          { ts: "1700000001.000000", text: "<@U1>" },
        ],
      }),
      "users.info": (params) => ({
        ok: true,
        user: { id: params.get("user"), name: params.get("user") },
      }),
    });
    const { cache } = clockedCache(2);
    await runSlackConversationRead({ conversation: "C1" }, config(), {
      cache,
    });
    const asked = slack.calls
      .filter((call) => call.method === "users.info")
      .map((call) => call.params.get("user"));
    assert.deepEqual(asked, ["U1", "U2", "U3", "U1"]);
  });
});

describe("Slack read core: conversation-list reuse", () => {
  test("name resolution reuses the list for five minutes", async () => {
    const slack = stubSlack({
      "conversations.list": listOf(random),
      "conversations.history": history,
    });
    const { clock, cache } = clockedCache();
    const read = () =>
      runSlackConversationRead({ conversation: "random" }, config(), {
        cache,
      });
    await read();
    clock.now = 4 * 60_000;
    await read();
    assert.equal(slack.count("conversations.list"), 1);
    clock.now = 5 * 60_000;
    await read();
    assert.equal(slack.count("conversations.list"), 2);
  });

  test("local unread (maximum age 0) lists on every call, same millisecond included", async () => {
    const slack = stubSlack({
      "conversations.list": listOf({
        ...random,
        last_read: "1700000000.000100",
        unread_count: 0,
      }),
      "conversations.history": history,
    });
    const { cache } = clockedCache();
    const local = config({ unreadListMaxAgeMs: 0 });
    await runSlackConversationRead({ conversation: "random" }, local, {
      cache,
    });
    assert.equal(slack.count("conversations.list"), 1);
    await runSlackUnread({}, local, { cache });
    assert.equal(slack.count("conversations.list"), 2);
    await runSlackUnread({}, local, { cache });
    assert.equal(slack.count("conversations.list"), 3);
  });

  test("edge unread (maximum age 60 s) reuses a list younger than a minute", async () => {
    const listed = listOf({
      ...random,
      last_read: "1700000000.000100",
      unread_count: 0,
    });
    const edge = config({ unreadListMaxAgeMs: 60_000 });

    let slack = stubSlack({ "conversations.list": listed });
    let { clock, cache } = clockedCache();
    await runSlackUnread({}, edge, { cache });
    clock.now = 10_000;
    await runSlackUnread({}, edge, { cache });
    assert.equal(slack.count("conversations.list"), 1);
    clock.now = 60_000;
    await runSlackUnread({}, edge, { cache });
    assert.equal(slack.count("conversations.list"), 2);

    vi.restoreAllMocks();
    slack = stubSlack({
      "conversations.list": listed,
      "conversations.history": history,
    });
    ({ clock, cache } = clockedCache());
    await runSlackConversationRead({ conversation: "random" }, edge, {
      cache,
    });
    clock.now = 10_000;
    await runSlackUnread({}, edge, { cache });
    assert.equal(slack.count("conversations.list"), 1);
  });
});

describe("Slack read core: profile timezone", () => {
  test("the profile's zone when Intl knows it, else UTC", async () => {
    const slack = stubSlack({
      "users.info": (params) => {
        switch (params.get("user")) {
          case "U1":
            return { ok: true, user: { id: "U1", tz: "Europe/Berlin" } };
          case "U2":
            return { ok: true, user: { id: "U2" } };
          case "U3":
            return { ok: true, user: { id: "U3", tz: "Not/AZone" } };
          case "U4":
            return { ok: false, error: "user_not_found" };
          default:
            return { ok: false, error: "invalid_auth" };
        }
      },
    });
    const { cache } = clockedCache();
    const zone = (userId: string) =>
      slackProfileTimeZone(config(), userId, { cache });

    assert.equal(await zone("U1"), "Europe/Berlin");
    assert.equal(await zone("U2"), "UTC");
    assert.equal(await zone("U3"), "UTC");
    assert.equal(await zone("U4"), "UTC");
    await assert.rejects(
      zone("U5"),
      (error: unknown) =>
        error instanceof SlackApiError &&
        error.method === "users.info" &&
        error.code === "invalid_auth",
    );
    assert.equal(await zone("U1"), "Europe/Berlin");
    assert.equal(
      slack.calls.filter((call) => call.params.get("user") === "U1").length,
      1,
    );
  });
});

describe("Slack read core: requests and Slack failures", () => {
  test("every request is a POST to slack.com/api with the bearer token and redirects refused", async () => {
    const slack = stubSlack({
      "search.messages": () => ({
        ok: true,
        messages: {
          total: 1,
          matches: [
            {
              ts: "1700000000.000100",
              reply_count: 1,
              channel: { id: "C1", name: "random" },
              text: "<@U1> in <#C9> to <!subteam^S1>",
            },
          ],
        },
      }),
      "users.info": () => ({ ok: true, user: { id: "U1", name: "ada" } }),
      "conversations.list": listOf({ id: "C9", name: "ops" }),
      "usergroups.list": () => ({
        ok: true,
        usergroups: [{ id: "S1", handle: "oncall" }],
      }),
      "conversations.replies": () => ({ ok: true, messages: [] }),
      "conversations.history": history,
    });
    const controller = new AbortController();
    await runSlackSearch(
      { query: "hello", expandThreads: true, nearbyMessages: 1 },
      config(),
      { signal: controller.signal, cache: clockedCache().cache },
    );

    assert.deepEqual(
      [...new Set(slack.calls.map((call) => call.method))].sort(),
      [
        "conversations.history",
        "conversations.list",
        "conversations.replies",
        "search.messages",
        "usergroups.list",
        "users.info",
      ],
    );
    for (const call of slack.calls) {
      assert.equal(call.url, `https://slack.com/api/${call.method}`);
      assert.equal(call.init.method, "POST");
      assert.equal(
        (call.init.headers as Record<string, string>).authorization,
        "Bearer xoxp-token-a",
      );
      assert.equal(call.init.redirect, "error");
      assert.equal(call.init.signal, controller.signal);
    }
  });

  test("a 429 carries the method and a sane Retry-After", async () => {
    const cases: Array<[string | null, number | undefined, string]> = [
      ["30", 30, "30"],
      ["abc", undefined, "abc"],
      ["0", undefined, "0"],
      ["99999", undefined, "99999"],
      // The accepted range is 1-3600 whole seconds.
      ["3600", 3600, "3600"],
      ["3601", undefined, "3601"],
      ["1e2", undefined, "1e2"],
      [null, undefined, "unknown"],
    ];
    for (const [header, retryAfterS, shown] of cases) {
      vi.restoreAllMocks();
      stubSlack({
        "conversations.list": () =>
          new Response("{}", {
            status: 429,
            ...(header !== null ? { headers: { "retry-after": header } } : {}),
          }),
      });
      await assert.rejects(
        runSlackUnread({}, config(), { cache: clockedCache().cache }),
        (error: unknown) => {
          assert.ok(error instanceof SlackHttpError);
          assert.equal(error.method, "conversations.list");
          assert.equal(error.status, 429);
          assert.equal(error.retryAfterS, retryAfterS);
          assert.equal(
            error.message,
            `Slack rate limited conversations.list; retry after ${shown} seconds.`,
          );
          return true;
        },
      );
    }
  });

  test("other statuses, unreadable answers and ok:false keep today's texts", async () => {
    stubSlack({
      "search.messages": () => new Response("upstream broke", { status: 502 }),
    });
    await assert.rejects(
      runSlackSearch({ query: "x" }, config()),
      (error: unknown) => {
        assert.ok(error instanceof SlackHttpError);
        assert.equal(error.status, 502);
        assert.equal(error.retryAfterS, undefined);
        assert.equal(
          error.message,
          "Slack HTTP 502 for search.messages: upstream broke",
        );
        return true;
      },
    );

    vi.restoreAllMocks();
    stubSlack({
      "search.messages": () => new Response("<html>", { status: 200 }),
    });
    await assert.rejects(
      runSlackSearch({ query: "x" }, config()),
      (error: unknown) =>
        error instanceof SlackAnswerError &&
        error.message === "Slack returned invalid JSON for search.messages.",
    );

    vi.restoreAllMocks();
    stubSlack({
      "search.messages": () => ({ ok: false, error: "missing_scope" }),
    });
    await assert.rejects(
      runSlackSearch({ query: "x" }, config()),
      (error: unknown) =>
        error instanceof SlackApiError &&
        error.method === "search.messages" &&
        error.code === "missing_scope" &&
        error.message === "Slack API search.messages failed: missing_scope",
    );

    vi.restoreAllMocks();
    stubSlack({ "conversations.list": listOf({ name: "no-id" }) });
    await assert.rejects(
      runSlackUnread({}, config(), { cache: clockedCache().cache }),
      (error: unknown) =>
        error instanceof SlackAnswerError &&
        error.message === "Slack returned a conversation without an id.",
    );
  });
});

describe("Slack read core: refusals", () => {
  const refuses = async (
    run: Promise<unknown>,
    code: SlackReadRefusalCode,
    message: string,
  ) =>
    assert.rejects(run, (error: unknown) => {
      assert.ok(error instanceof SlackReadRefusal);
      assert.equal(error.code, code);
      assert.equal(error.message, message);
      return true;
    });

  test("input refusals", async () => {
    stubSlack({});
    await refuses(
      runSlackSearch({ query: "  " }, config()),
      "query_empty",
      "query is required.",
    );
    await refuses(
      runSlackThreadRead(
        { conversation: " # ", threadTs: "1700000000.000100" },
        config(),
      ),
      "conversation_empty",
      "conversation is required.",
    );
    await refuses(
      runSlackUnread({ person: "@" }, config()),
      "person_empty",
      "person must not be empty.",
    );
    await refuses(
      runSlackThreadRead({ conversation: "C1", threadTs: "abc" }, config()),
      "ts_invalid",
      "threadTs must be a Slack timestamp such as 1717426730.123456.",
    );
    await refuses(
      runSlackConversationRead(
        { conversation: "C1", date: "2026-1-1" },
        config(),
      ),
      "date_invalid",
      "date must be YYYY-MM-DD.",
    );
    await refuses(
      runSlackConversationRead(
        { conversation: "C1", oldest: "not a time" },
        config(),
      ),
      "time_invalid",
      "Invalid Slack/RFC3339 timestamp: not a time",
    );
  });

  test("conversation and person resolution refusals", async () => {
    stubSlack({
      "conversations.list": listOf(
        { id: "C1", name: "random" },
        { id: "C2", name: "Random" },
      ),
      "users.list": () => ({
        ok: true,
        members: [
          { id: "U1", name: "alex" },
          { id: "U2", name: "alex" },
          { id: "U3", name: "gone", deleted: true },
        ],
      }),
    });
    await refuses(
      runSlackConversationRead({ conversation: "random" }, config()),
      "conversation_ambiguous",
      "Slack conversation 'random' is ambiguous. Candidates: random (C1), Random (C2). Use a conversation id.",
    );
    await refuses(
      runSlackConversationRead({ conversation: "nowhere" }, config()),
      "conversation_not_found",
      "Could not resolve Slack conversation 'nowhere'. Use a channel/DM id, accessible channel name, or an unambiguous person name.",
    );
    await refuses(
      runSlackUnread({ person: "alex" }, config()),
      "person_ambiguous",
      "Slack person 'alex' is ambiguous. Candidates: alex (U1), alex (U2). Use a user id.",
    );
    await refuses(
      runSlackUnread({ person: "gone" }, config()),
      "person_deleted",
      "Slack person 'gone' only matched deleted users: gone (U3, deleted).",
    );
    await refuses(
      runSlackUnread({ person: "nobody" }, config()),
      "person_not_found",
      "Could not resolve Slack person 'nobody'.",
    );
  });
});
