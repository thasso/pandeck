import assert from "node:assert/strict";
import { afterEach, test, vi } from "vitest";
import { slackHuddleHistoryTool } from "./slackHuddleTools.ts";

vi.mock("../../slackSettings.ts", () => ({
  getSlackHuddleConfig: () => ({
    enabled: true,
    workspaceHost: "example.slack.com",
    teamId: "T1",
    timezone: "Europe/Berlin",
    defaultMaxResults: 20,
    clientToken: "xoxc-browser-secret",
    clientCookieD: "cookie-secret",
    userToken: "xoxp-personal-secret",
    accountUserId: "U1",
    source: "experimental-browser-session",
  }),
}));

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

function response(value: unknown) {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

const context = {
  toolCallId: "huddle-test",
  session: {
    sessionId: "s",
    harness: "pi" as const,
    agentType: "assistant" as const,
  },
};

test("reads bounded Huddle history with isolated browser auth and personal-OAuth metadata enrichment", async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  globalThis.fetch = vi.fn(
    async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, ...(init !== undefined ? { init } : {}) });
      if (url.includes("/api/huddles.history"))
        return response({
          ok: true,
          huddles: [
            {
              id: "H1",
              date_start: 1783926000,
              date_end: 1783927800,
              channels: ["C1"],
              thread_root_ts: "1783926000.000001",
              created_by: "U2",
              participant_history: ["U1", "U2"],
              huddle_link: "https://example.slack.com/huddle/T1-C1-H1",
            },
          ],
        });
      if (url.endsWith("/conversations.replies"))
        return response({
          ok: true,
          messages: [
            {
              room: {
                participants_events: {
                  U1: {
                    joined: true,
                    date_start: 1783926000,
                    nested: { secret: "must-not-pass" },
                  },
                },
              },
            },
          ],
        });
      if (url.endsWith("/conversations.info"))
        return response({ ok: true, channel: { id: "C1", name: "product" } });
      if (url.endsWith("/users.info")) {
        const id = new URLSearchParams(String(init?.body ?? "")).get("user");
        return response({
          ok: true,
          user: {
            id,
            profile: { display_name: id === "U1" ? "Alice" : "Alex" },
          },
        });
      }
      throw new Error(`Unexpected request: ${url}`);
    },
  ) as typeof fetch;

  const result = await slackHuddleHistoryTool.execute(
    { date: "2026-07-13", maxResults: 5, detailLevel: "full" },
    context,
  );
  const payload = JSON.parse(
    result.content[0]!.type === "text" ? result.content[0]!.text : "{}",
  ) as any;

  assert.equal(payload.returned, 1);
  assert.equal(payload.identity.credential, "experimental_browser_session");
  assert.equal(payload.huddles[0].durationMinutes, 30);
  assert.equal(payload.huddles[0].selfAttendance.status, "joined");
  assert.deepEqual(
    payload.huddles[0].participants.map((item: any) => [
      item.label,
      item.status,
    ]),
    [
      ["Alice", "joined"],
      ["Alex", "joined"],
    ],
  );
  assert.equal(payload.huddles[0].conversation.label, "#product");
  assert.deepEqual(payload.huddles[0].participantEvents.U1, {
    joined: true,
    start: 1783926000,
    end: null,
  });
  assert.doesNotMatch(
    JSON.stringify(payload),
    /browser-secret|cookie-secret|personal-secret|must-not-pass|nested/,
  );

  const browserCall = calls.find((call) =>
    call.url.includes("/api/huddles.history"),
  );
  assert.equal(
    (browserCall?.init?.headers as Record<string, string>).Authorization,
    "Bearer xoxc-browser-secret",
  );
  assert.equal(
    (browserCall?.init?.headers as Record<string, string>).Cookie,
    "d=cookie-secret",
  );
  const oauthCalls = calls.filter((call) =>
    call.url.startsWith("https://slack.com/api/"),
  );
  assert.ok(oauthCalls.length > 0);
  assert.ok(
    oauthCalls.every(
      (call) =>
        (call.init?.headers as Record<string, string>).Authorization ===
        "Bearer xoxp-personal-secret",
    ),
  );
});

test("reports partial metadata enrichment instead of claiming completeness after a failed lookup", async () => {
  globalThis.fetch = vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    if (url.includes("/api/huddles.history"))
      return response({
        ok: true,
        huddles: [
          {
            id: "H2",
            date_start: 1783926000,
            channels: ["C2"],
            participant_history: [],
          },
        ],
      });
    if (url.endsWith("/conversations.info"))
      return new Response("unavailable", { status: 503 });
    throw new Error(`Unexpected request: ${url}`);
  }) as typeof fetch;

  const result = await slackHuddleHistoryTool.execute({}, context);
  const payload = JSON.parse(
    result.content[0]!.type === "text" ? result.content[0]!.text : "{}",
  ) as any;
  assert.equal(payload.completeness.metadataEnrichment, "partial");
  assert.equal(payload.completeness.metadataFailures, 1);
});

test("propagates personal-OAuth rate limits instead of silently degrading", async () => {
  globalThis.fetch = vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    if (url.includes("/api/huddles.history"))
      return response({
        ok: true,
        huddles: [{ id: "H3", date_start: 1783926000, channels: ["C3"] }],
      });
    if (url.endsWith("/conversations.info"))
      return new Response(JSON.stringify({ ok: false, error: "ratelimited" }), {
        status: 429,
      });
    throw new Error(`Unexpected request: ${url}`);
  }) as typeof fetch;

  await assert.rejects(
    () => slackHuddleHistoryTool.execute({}, context),
    /HTTP 429/,
  );
});

test("rejects declared oversized Huddle responses before reading the body", async () => {
  globalThis.fetch = vi.fn(
    async () =>
      new Response("{}", {
        status: 200,
        headers: { "content-length": "2000001" },
      }),
  ) as typeof fetch;
  await assert.rejects(
    () => slackHuddleHistoryTool.execute({}, context),
    /byte safety limit/,
  );
});

test("rejects malformed dates before loading Huddle history", async () => {
  globalThis.fetch = vi.fn() as typeof fetch;
  await assert.rejects(
    () => slackHuddleHistoryTool.execute({ date: "13-07-2026" }, context),
    /YYYY-MM-DD/,
  );
  assert.equal(vi.mocked(globalThis.fetch).mock.calls.length, 0);
});
