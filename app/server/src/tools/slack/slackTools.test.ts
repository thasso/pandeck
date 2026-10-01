import assert from "node:assert/strict";
import { beforeEach, describe, test, vi } from "vitest";

const slackConfig = vi.hoisted(() => ({ grantedUserScopes: [] as string[] }));
vi.mock("../../slackSettings.ts", () => ({
  getSlackPublicApiConfig: () => ({
    enabled: true,
    token: "xoxp-personal",
    tokenMode: "user",
    workspaceHost: "example.slack.com",
    teamId: "T1",
    timezone: "Europe/Berlin",
    defaultMaxResults: 20,
    source: "personal-user-oauth",
    grantedUserScopes: slackConfig.grantedUserScopes,
  }),
}));

import {
  clearSlackMetadataCaches,
  slackConversationReadTool,
  slackFileReadTool,
  slackSearchTool,
  slackThreadReadTool,
  slackUnreadTool,
} from "./slackTools.ts";

const ctx = {
  toolCallId: "call",
  session: {
    sessionId: "session",
    harness: "pi" as const,
    agentType: "assistant" as const,
  },
  signal: new AbortController().signal,
};
const response = (
  body: unknown,
  status = 200,
  headers?: Record<string, string>,
) =>
  new Response(JSON.stringify(body), {
    status,
    ...(headers !== undefined ? { headers } : {}),
  });
const bodyOf = (call: unknown[]) =>
  new URLSearchParams(String((call[1] as RequestInit).body));

beforeEach(() => {
  vi.restoreAllMocks();
  clearSlackMetadataCaches();
  slackConfig.grantedUserScopes = [];
});

describe("public Slack capability tools", () => {
  test("exposes distinct personal OAuth capabilities", () => {
    assert.deepEqual(
      [
        slackSearchTool,
        slackConversationReadTool,
        slackThreadReadTool,
        slackUnreadTool,
        slackFileReadTool,
      ].map((tool) => tool.name),
      [
        "slack_search",
        "slack_conversation_read",
        "slack_thread_read",
        "slack_unread",
        "slack_file_read",
      ],
    );
    for (const tool of [
      slackSearchTool,
      slackConversationReadTool,
      slackThreadReadTool,
      slackUnreadTool,
      slackFileReadTool,
    ]) {
      assert.doesNotMatch(
        JSON.stringify(tool.parameters),
        /huddle|later|browser|tokenMode/i,
      );
    }
  });

  test("search preserves permalinks, identity, and expands a matched reply thread", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (url) => {
        const method = String(url).split("/").pop();
        if (method === "search.messages")
          return response({
            ok: true,
            messages: {
              total: 1,
              matches: [
                {
                  ts: "1717426731.000002",
                  thread_ts: "1717426730.000001",
                  user: "U1",
                  text: "reply",
                  permalink:
                    "https://example.slack.com/archives/C1/p1717426731000002",
                  channel: { id: "C1", name: "product" },
                },
              ],
            },
          });
        if (method === "users.info")
          return response({
            ok: true,
            user: { profile: { display_name: "Alex" } },
          });
        if (method === "conversations.replies")
          return response({
            ok: true,
            messages: [
              { ts: "1717426730.000001", user: "U1", text: "root" },
              {
                ts: "1717426731.000002",
                thread_ts: "1717426730.000001",
                user: "U1",
                text: "reply",
              },
            ],
          });
        throw new Error(`unexpected ${method}`);
      });
    const result = await slackSearchTool.execute(
      { query: "reply", expandThreads: true },
      ctx,
    );
    const payload = result.details as any;
    assert.equal(payload.identity.credential, "personal_user_oauth");
    assert.equal(
      payload.matches[0].message.permalink,
      "https://example.slack.com/archives/C1/p1717426731000002",
    );
    assert.equal(payload.matches[0].thread.length, 2);
    assert.equal(
      fetchMock.mock.calls[0]?.[1]?.headers &&
        (fetchMock.mock.calls[0][1]!.headers as Record<string, string>)
          .authorization,
      "Bearer xoxp-personal",
    );
  });

  test("thread requires a root timestamp and paginates replies", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (url, init) => {
        const method = String(url).split("/").pop();
        const body = new URLSearchParams(String(init?.body));
        if (method === "conversations.replies" && !body.get("cursor"))
          return response({
            ok: true,
            messages: [{ ts: "1717426730.000001", text: "root" }],
            response_metadata: { next_cursor: "next" },
          });
        if (method === "conversations.replies")
          return response({
            ok: true,
            messages: [
              {
                ts: "1717426731.000002",
                thread_ts: "1717426730.000001",
                text: "reply",
              },
            ],
          });
        throw new Error(`unexpected ${method}`);
      });
    const result = await slackThreadReadTool.execute(
      { conversation: "C1", threadTs: "1717426730.000001" },
      ctx,
    );
    const payload = result.details as any;
    assert.equal(payload.threadTs, "1717426730.000001");
    assert.equal(payload.returned, 2);
    assert.equal(bodyOf(fetchMock.mock.calls[1]!).get("cursor"), "next");
  });

  test("stops pagination when Slack repeats an empty-page cursor", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async () =>
        response({
          ok: true,
          messages: [],
          response_metadata: { next_cursor: "same" },
        }),
      );
    const result = await slackThreadReadTool.execute(
      { conversation: "C1", threadTs: "1717426730.000001" },
      ctx,
    );
    assert.equal((result.details as any).returned, 0);
    assert.equal(fetchMock.mock.calls.length, 2);
  });

  test("aggregates channels, DMs, and MPIMs while preserving marker uncertainty", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (url, init) => {
        const method = String(url).split("/").pop();
        const body = new URLSearchParams(String(init?.body));
        if (method === "conversations.list" && !body.get("cursor"))
          return response({
            ok: true,
            channels: [
              {
                id: "C1",
                name: "product",
                last_read: "1717426730.000001",
                unread_count: 1,
                latest: { ts: "1717426740.000001" },
              },
              {
                id: "D1",
                is_im: true,
                user: "U1",
                last_read: "1717426730.000001",
                unread_count: 1,
                latest: { ts: "1717426750.000001" },
              },
            ],
            response_metadata: { next_cursor: "page-2" },
          });
        if (method === "conversations.list")
          return response({
            ok: true,
            channels: [
              {
                id: "G1",
                name: "mpdm-alex--bea-1",
                is_mpim: true,
                members: ["U1", "U2"],
                unread_count: 2,
              },
            ],
          });
        if (method === "users.info")
          return response({
            ok: true,
            user: {
              profile: {
                display_name: body.get("user") === "U1" ? "Alex" : "Bea",
              },
            },
          });
        if (method === "conversations.history")
          return response({
            ok: true,
            messages: [
              {
                ts:
                  body.get("channel") === "D1"
                    ? "1717426750.000001"
                    : "1717426740.000001",
                user: "U1",
                text: "unread",
              },
            ],
          });
        throw new Error(`unexpected ${method}`);
      });
    const result = await slackUnreadTool.execute({ maxResults: 10 }, ctx);
    const payload = result.details as any;
    assert.deepEqual(payload.conversations.map((item: any) => item.id).sort(), [
      "C1",
      "D1",
    ]);
    assert.equal(
      payload.conversations.find((item: any) => item.id === "D1").name,
      "Alex",
    );
    assert.equal(payload.uncertainConversations[0].id, "G1");
    assert.equal(payload.uncertainConversations[0].name, "Alex, Bea");
    assert.equal(
      payload.uncertainConversations[0].slackName,
      "mpdm-alex--bea-1",
    );
    assert.equal(
      payload.uncertainConversations[0].reason,
      "missing_last_read_marker",
    );
    assert.equal(bodyOf(fetchMock.mock.calls[1]!).get("cursor"), "page-2");
  });

  test("filters unread DMs by person and expands visible unread thread replies", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (url, init) => {
        const method = String(url).split("/").pop();
        const body = new URLSearchParams(String(init?.body));
        if (method === "users.list")
          return response({
            ok: true,
            members: [
              { id: "U1", profile: { display_name: "Alex" } },
              { id: "U2", profile: { display_name: "Bea" } },
            ],
          });
        if (method === "conversations.list")
          return response({
            ok: true,
            channels: [
              {
                id: "D1",
                is_im: true,
                user: "U1",
                last_read: "1717426730.000001",
                unread_count: 2,
              },
              {
                id: "D2",
                is_im: true,
                user: "U2",
                last_read: "1717426730.000001",
                unread_count: 1,
              },
            ],
          });
        if (method === "users.info")
          return response({
            ok: true,
            user: {
              profile: {
                display_name: body.get("user") === "U1" ? "Alex" : "Bea",
              },
            },
          });
        if (method === "conversations.history")
          return response({
            ok: true,
            messages: [
              {
                ts: "1717426740.000001",
                user: "U1",
                text: "root",
                reply_count: 2,
              },
              { ts: "1717426741.000001", user: "U1", text: "second root" },
            ],
          });
        if (method === "conversations.replies")
          return response({
            ok: true,
            messages: [
              { ts: "1717426740.000001", text: "root" },
              {
                ts: "1717426730.000000",
                thread_ts: "1717426740.000001",
                user: "U1",
                text: "older by one microsecond",
              },
              {
                ts: "1717426730.000002",
                thread_ts: "1717426740.000001",
                user: "U1",
                text: "newer by one microsecond",
              },
            ],
          });
        throw new Error(`unexpected ${method}`);
      });
    const result = await slackUnreadTool.execute(
      {
        person: "Alex",
        includeThreads: true,
        maxThreadMessages: 2,
        maxResults: 3,
        maxPerConversation: 2,
      },
      ctx,
    );
    const payload = result.details as any;
    assert.equal(payload.returnedConversations, 1);
    assert.equal(payload.conversations[0].id, "D1");
    assert.equal(payload.returned, 2);
    assert.equal(payload.conversations[0].returned, 2);
    assert.equal(payload.conversations[0].messages.length, 1);
    assert.equal(payload.conversations[0].messages[0].unreadReplies.length, 1);
    assert.equal(
      payload.conversations[0].messages[0].unreadReplies[0].text,
      "newer by one microsecond",
    );
    const repliesCall = fetchMock.mock.calls.find(([url]) =>
      String(url).endsWith("conversations.replies"),
    );
    assert.equal(bodyOf(repliesCall!).get("limit"), "3"); // two requested replies plus the required root
    assert.equal(
      payload.completeness.threadReplies,
      "best_effort_for_visible_unread_roots",
    );
  });

  test("bounds conversation enrichment before participant lookups", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (url, init) => {
        const method = String(url).split("/").pop();
        const body = new URLSearchParams(String(init?.body));
        if (method === "conversations.list")
          return response({
            ok: true,
            channels: [
              {
                id: "D-bound-1",
                is_im: true,
                user: "U-bound-1",
                unread_count: 3,
                last_read: "1717426730.000001",
              },
              {
                id: "D-bound-2",
                is_im: true,
                user: "U-bound-2",
                unread_count: 2,
                last_read: "1717426730.000001",
              },
              {
                id: "D-bound-3",
                is_im: true,
                user: "U-bound-3",
                unread_count: 1,
                last_read: "1717426730.000001",
              },
            ],
          });
        if (method === "users.info")
          return response({
            ok: true,
            user: { profile: { display_name: body.get("user") } },
          });
        if (method === "conversations.history")
          return response({ ok: true, messages: [] });
        throw new Error(`unexpected ${method}`);
      });
    await slackUnreadTool.execute({ maxConversations: 1 }, ctx);
    assert.equal(
      fetchMock.mock.calls.filter(([url]) => String(url).endsWith("users.info"))
        .length,
      1,
    );
    assert.equal(
      fetchMock.mock.calls.filter(([url]) =>
        String(url).endsWith("conversations.history"),
      ).length,
      1,
    );
  });

  test("returns an empty aggregate and propagates unread rate limits", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      response({ ok: true, channels: [] }),
    );
    const empty = await slackUnreadTool.execute({}, ctx);
    assert.equal((empty.details as any).returned, 0);
    assert.deepEqual((empty.details as any).conversations, []);

    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      response({}, 429, { "retry-after": "9" }),
    );
    await assert.rejects(
      slackUnreadTool.execute({}, ctx),
      /retry after 9 seconds/,
    );
  });

  test("propagates rate limits and aborts during user normalization", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url) =>
      String(url).endsWith("search.messages")
        ? response({
            ok: true,
            messages: {
              matches: [
                {
                  ts: "1717426730.000001",
                  user: "U-rate",
                  text: "test",
                  channel: { id: "C1" },
                },
              ],
            },
          })
        : response({}, 429, { "retry-after": "7" }),
    );
    await assert.rejects(
      slackSearchTool.execute({ query: "test" }, ctx),
      /retry after 7 seconds/,
    );

    const controller = new AbortController();
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
      if (String(url).endsWith("search.messages"))
        return response({
          ok: true,
          messages: {
            matches: [
              {
                ts: "1717426730.000002",
                user: "U-abort",
                text: "test",
                channel: { id: "C1" },
              },
            ],
          },
        });
      controller.abort();
      throw new DOMException("aborted", "AbortError");
    });
    await assert.rejects(
      slackSearchTool.execute(
        { query: "test" },
        { ...ctx, signal: controller.signal },
      ),
      /aborted/i,
    );
  });

  test("resolves an unambiguous person to a DM and rejects duplicate or deleted names", async () => {
    let users: any[] = [
      { id: "U1", name: "alex", profile: { display_name: "Alex Doe" } },
    ];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
      const method = String(url).split("/").pop();
      if (method === "conversations.list")
        return response({
          ok: true,
          channels: [{ id: "D1", is_im: true, user: "U1" }],
        });
      if (method === "users.list")
        return response({ ok: true, members: users });
      if (method === "conversations.history")
        return response({ ok: true, messages: [] });
      throw new Error(`unexpected ${method}`);
    });
    const dm = await slackConversationReadTool.execute(
      { conversation: "Alex Doe" },
      ctx,
    );
    assert.equal((dm.details as any).conversation.id, "D1");
    assert.equal((dm.details as any).conversation.name, "Alex Doe");

    clearSlackMetadataCaches();
    users = [
      { id: "U1", profile: { display_name: "Alex" } },
      { id: "U2", profile: { display_name: "Alex" } },
    ];
    await assert.rejects(
      slackConversationReadTool.execute({ conversation: "Alex" }, ctx),
      /ambiguous.*U1.*U2/i,
    );
    clearSlackMetadataCaches();
    users = [
      { id: "U3", deleted: true, profile: { display_name: "Former Alex" } },
    ];
    await assert.rejects(
      slackConversationReadTool.execute({ conversation: "Former Alex" }, ctx),
      /deleted users.*U3/i,
    );
  });

  test("resolves authors, user mentions, channel references, and user groups while retaining IDs", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
      const method = String(url).split("/").pop();
      const body = new URLSearchParams(String(init?.body));
      if (method === "search.messages")
        return response({
          ok: true,
          messages: {
            matches: [
              {
                ts: "1717426730.000001",
                user: "U1",
                text: "Ask <@U2> in <#C2> and <!subteam^S1>",
                channel: { id: "C1", name: "general" },
              },
            ],
          },
        });
      if (method === "users.info")
        return response({
          ok: true,
          user: {
            id: body.get("user"),
            profile: {
              display_name: body.get("user") === "U1" ? "Alex" : "Bea",
            },
          },
        });
      if (method === "conversations.list")
        return response({
          ok: true,
          channels: [{ id: "C2", name: "product" }],
        });
      if (method === "usergroups.list")
        return response({
          ok: true,
          usergroups: [{ id: "S1", handle: "engineers" }],
        });
      throw new Error(`unexpected ${method}`);
    });
    const found = await slackSearchTool.execute({ query: "Ask" }, ctx);
    const message = (found.details as any).matches[0].message;
    assert.equal(message.userId, "U1");
    assert.equal(message.userName, "Alex");
    assert.equal(message.text, "Ask @Bea in #product and @engineers");
    assert.deepEqual(message.references, [
      { type: "user", id: "U2", label: "Bea" },
      { type: "channel", id: "C2", label: "product" },
      { type: "user_group", id: "S1", label: "engineers" },
    ]);
  });

  test("keeps per-user metadata separate from the complete discovery cache", async () => {
    let usersListCalls = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
      const method = String(url).split("/").pop();
      const body = new URLSearchParams(String(init?.body));
      if (method === "search.messages")
        return response({
          ok: true,
          messages: {
            matches: [
              {
                ts: "1717426730.000001",
                user: "U1",
                text: "hello",
                channel: { id: "C1" },
              },
            ],
          },
        });
      if (method === "users.info")
        return response({
          ok: true,
          user: { id: body.get("user"), profile: { display_name: "First" } },
        });
      if (method === "conversations.list")
        return response({
          ok: true,
          channels: [{ id: "D2", is_im: true, user: "U2" }],
        });
      if (method === "users.list") {
        usersListCalls++;
        return response({
          ok: true,
          members: [{ id: "U2", profile: { display_name: "Second" } }],
        });
      }
      if (method === "conversations.history")
        return response({ ok: true, messages: [] });
      throw new Error(`unexpected ${method}`);
    });
    await slackSearchTool.execute({ query: "hello" }, ctx);
    const dm = await slackConversationReadTool.execute(
      { conversation: "Second" },
      ctx,
    );
    assert.equal((dm.details as any).conversation.id, "D2");
    assert.equal(usersListCalls, 1);
  });

  test("bounds metadata lookups before resolving message references", async () => {
    const mentions = Array.from(
      { length: 75 },
      (_, index) => `<@U${index}>`,
    ).join(" ");
    let infoCalls = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
      const method = String(url).split("/").pop();
      const body = new URLSearchParams(String(init?.body));
      if (method === "search.messages")
        return response({
          ok: true,
          messages: {
            matches: [
              {
                ts: "1717426730.000001",
                text: mentions,
                channel: { id: "C1" },
              },
            ],
          },
        });
      if (method === "users.info") {
        infoCalls++;
        return response({
          ok: true,
          user: {
            id: body.get("user"),
            profile: { display_name: body.get("user") },
          },
        });
      }
      throw new Error(`unexpected ${method}`);
    });
    const found = await slackSearchTool.execute({ query: "mentions" }, ctx);
    assert.equal(infoCalls, 50);
    assert.equal(
      (found.details as any).matches[0].message.references.length,
      50,
    );
    assert.match(
      (found.details as any).matches[0].message.text,
      /Unknown user \(U50\)/,
    );
  });

  test("does not suppress person lookup failures during conversation resolution", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
      const method = String(url).split("/").pop();
      if (method === "conversations.list")
        return response({ ok: true, channels: [] });
      if (method === "users.list")
        return response({}, 429, { "retry-after": "4" });
      throw new Error(`unexpected ${method}`);
    });
    await assert.rejects(
      slackConversationReadTool.execute({ conversation: "Alex" }, ctx),
      /retry after 4 seconds/,
    );
  });

  test("matches email only with users:read.email and caches unavailable user groups", async () => {
    let groupCalls = 0;
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (url, init) => {
        const method = String(url).split("/").pop();
        const body = new URLSearchParams(String(init?.body));
        if (method === "users.list")
          return response({
            ok: true,
            members: [
              {
                id: "U1",
                name: "alex",
                profile: { display_name: "Alex", email: "alex@example.com" },
              },
            ],
          });
        if (method === "conversations.list")
          return response({
            ok: true,
            channels: [{ id: "D1", is_im: true, user: "U1" }],
          });
        if (method === "conversations.history")
          return response({
            ok: true,
            messages: [
              { ts: "1717426730.000001", text: "<!subteam^S1> <!subteam^S1>" },
            ],
          });
        if (method === "usergroups.list") {
          groupCalls++;
          return response({ ok: false, error: "missing_scope" });
        }
        if (method === "users.info")
          return response({
            ok: true,
            user: { id: body.get("user"), profile: { display_name: "Alex" } },
          });
        throw new Error(`unexpected ${method}`);
      });
    await assert.rejects(
      slackConversationReadTool.execute(
        { conversation: "alex@example.com" },
        ctx,
      ),
      /Could not resolve Slack conversation/,
    );
    clearSlackMetadataCaches();
    slackConfig.grantedUserScopes = ["users:read.email"];
    await slackConversationReadTool.execute(
      { conversation: "alex@example.com" },
      ctx,
    );
    await slackConversationReadTool.execute({ conversation: "D1" }, ctx);
    assert.equal(groupCalls, 1);
    assert.ok(
      fetchMock.mock.calls.some(([url]) => String(url).endsWith("users.list")),
    );
  });

  test("normalizes Block Kit, legacy attachments, and file metadata without private URLs", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url) =>
      String(url).endsWith("search.messages")
        ? response({
            ok: true,
            messages: {
              matches: [
                {
                  ts: "1717426730.000001",
                  channel: { id: "C1" },
                  text: "file",
                  files: [
                    {
                      id: "F1",
                      name: "notes.txt",
                      mimetype: "text/plain",
                      size: 12,
                      url_private: "https://files.slack.com/secret",
                    },
                  ],
                  blocks: [
                    {
                      type: "section",
                      block_id: "b1",
                      accessory: {
                        type: "button",
                        text: "Open",
                        url: "https://example.com/doc",
                      },
                      elements: [
                        {
                          type: "button",
                          url: "https://files.slack.com/private/signed?sig=secret",
                        },
                      ],
                    },
                  ],
                  attachments: [
                    {
                      id: 1,
                      service_name: "Example",
                      title: "Preview",
                      title_link: "https://example.com/preview",
                      image_url: "https://example.com/image.png",
                      thumb_url:
                        "https://cdn.example.com/private?X-Amz-Signature=secret",
                      text: "details",
                    },
                  ],
                },
              ],
            },
          })
        : Promise.reject(new Error(`unexpected ${String(url)}`)),
    );
    const result = await slackSearchTool.execute({ query: "file" }, ctx);
    const message = (result.details as any).matches[0].message;
    assert.equal(message.files[0].id, "F1");
    assert.equal(message.files[0].size, 12);
    assert.equal(message.blocks[0].links[0].url, "https://example.com/doc");
    assert.equal(message.attachments[0].serviceName, "Example");
    assert.equal(message.attachments[0].thumbnailLink, undefined);
    assert.doesNotMatch(
      JSON.stringify(message),
      /files\.slack\.com|url_private|X-Amz|secret/,
    );
  });

  test("reads authenticated text files through bounded redirects and redacts private URLs", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (url) => {
        if (String(url).endsWith("files.info"))
          return response({
            ok: true,
            file: {
              id: "F1",
              name: "notes.txt",
              mimetype: "text/plain",
              size: 20,
              permalink: "https://example.slack.com/files/F1",
              url_private_download: "https://files.slack.com/private/F1",
            },
          });
        if (String(url) === "https://files.slack.com/private/F1")
          return new Response(null, {
            status: 302,
            headers: { location: "https://downloads.slack-edge.com/F1" },
          });
        if (String(url) === "https://downloads.slack-edge.com/F1")
          return new Response("abcdef", {
            status: 200,
            headers: { "content-type": "text/plain" },
          });
        throw new Error(`unexpected ${String(url)}`);
      });
    const result = await slackFileReadTool.execute(
      {
        fileId: "F1",
        conversation: "C1",
        messageTs: "1717426730.000001",
        maxCharacters: 4,
      },
      ctx,
    );
    const payload = result.details as any;
    assert.equal(payload.content, "abc…");
    assert.equal(payload.contentTruncated, true);
    assert.equal(payload.origin.conversation, "C1");
    assert.equal(
      (fetchMock.mock.calls[1]![1]!.headers as Record<string, string>)
        .authorization,
      "Bearer xoxp-personal",
    );
    assert.equal(fetchMock.mock.calls[1]![1]!.redirect, "manual");
    assert.doesNotMatch(JSON.stringify(payload), /private\/F1|xoxp/);
  });

  test("rejects unsafe initial and redirect download destinations before sending authorization", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    for (const unsafeUrl of [
      "https://evil.example/F1",
      "https://127.0.0.1/F1",
      "https://user:pass@files.slack.com/F1",
    ]) {
      fetchMock.mockResolvedValueOnce(
        response({
          ok: true,
          file: { id: "F1", mimetype: "text/plain", url_private: unsafeUrl },
        }),
      );
      await assert.rejects(
        slackFileReadTool.execute({ fileId: "F1" }, ctx),
        /unsafe private file URL/,
      );
    }
    assert.equal(
      fetchMock.mock.calls.length,
      3,
      "only files.info requests are made for unsafe initial URLs",
    );

    fetchMock.mockResolvedValueOnce(
      response({
        ok: true,
        file: {
          id: "F2",
          mimetype: "text/plain",
          url_private: "https://files.slack.com/private/F2",
        },
      }),
    );
    fetchMock.mockResolvedValueOnce(
      new Response(null, {
        status: 302,
        headers: { location: "https://evil.example/stolen" },
      }),
    );
    await assert.rejects(
      slackFileReadTool.execute({ fileId: "F2" }, ctx),
      /redirected to an unsafe URL/,
    );
    assert.equal(
      fetchMock.mock.calls.length,
      5,
      "unsafe redirect destination receives no request",
    );
    const downloadCalls = fetchMock.mock.calls.filter(
      ([url]) => !String(url).endsWith("files.info"),
    );
    assert.deepEqual(
      downloadCalls.map(([url]) => new URL(String(url)).hostname),
      ["files.slack.com"],
    );
  });

  test("degrades unsupported, oversized, and inaccessible files safely", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    fetchMock.mockResolvedValueOnce(
      response({
        ok: true,
        file: {
          id: "Fpdf",
          name: "doc.pdf",
          mimetype: "application/pdf",
          size: 5,
          url_private: "https://files.slack.com/private/pdf",
        },
      }),
    );
    fetchMock.mockResolvedValueOnce(
      new Response("%PDF-", {
        status: 200,
        headers: { "content-type": "application/pdf" },
      }),
    );
    const pdf = await slackFileReadTool.execute({ fileId: "Fpdf" }, ctx);
    assert.equal((pdf.details as any).status, "saved_attachment");
    assert.equal((pdf.details as any).attachment.mimeType, "application/pdf");
    assert.equal((pdf.details as any).attachment.size, 5);
    assert.ok(
      (pdf.details as any).attachment.id,
      "staged attachment has an id",
    );
    assert.equal(
      fetchMock.mock.calls.length,
      2,
      "binary is downloaded then staged off-context",
    );
    assert.doesNotMatch(
      JSON.stringify(pdf.details),
      /%PDF-/,
      "raw bytes are not returned inline",
    );

    fetchMock.mockResolvedValueOnce(
      response({
        ok: true,
        file: {
          id: "Fmeta",
          mimetype: "text/plain",
          size: 1000,
          url_private: "https://files.slack.com/private/meta",
        },
      }),
    );
    const metadataBig = await slackFileReadTool.execute(
      { fileId: "Fmeta", maxDownloadBytes: 10 },
      ctx,
    );
    assert.equal((metadataBig.details as any).status, "download_limit_reached");
    assert.equal(
      fetchMock.mock.calls.length,
      3,
      "trusted metadata size prevents a download (PDF above used files.info + download)",
    );

    let cancelled = false;
    const oversizedStream = new ReadableStream({
      cancel() {
        cancelled = true;
      },
    });
    fetchMock.mockResolvedValueOnce(
      response({
        ok: true,
        file: {
          id: "Fbig",
          mimetype: "text/plain",
          url_private: "https://files.slack.com/private/big",
        },
      }),
    );
    fetchMock.mockResolvedValueOnce(
      new Response(oversizedStream, {
        status: 200,
        headers: { "content-type": "text/plain", "content-length": "1000" },
      }),
    );
    const big = await slackFileReadTool.execute(
      { fileId: "Fbig", maxDownloadBytes: 10 },
      ctx,
    );
    assert.equal((big.details as any).status, "download_limit_reached");
    assert.equal((big.details as any).downloadedBytes, 0);
    assert.equal(cancelled, true);

    fetchMock.mockResolvedValueOnce(
      response({ ok: false, error: "file_not_found" }),
    );
    const missing = await slackFileReadTool.execute(
      { fileId: "Fmissing" },
      ctx,
    );
    assert.equal((missing.details as any).status, "inaccessible_or_deleted");
  });

  test("uses exact local-midnight bounds across Berlin DST transitions", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(response({ ok: true, messages: [] }));
    await slackConversationReadTool.execute(
      { conversation: "C1", date: "2026-03-29" },
      ctx,
    );
    const body = bodyOf(fetchMock.mock.calls[0]!);
    assert.equal(
      body.get("oldest"),
      String(Date.parse("2026-03-28T23:00:00Z") / 1000),
    );
    assert.equal(
      body.get("latest"),
      String(Date.parse("2026-03-29T22:00:00Z") / 1000),
    );
  });
});
