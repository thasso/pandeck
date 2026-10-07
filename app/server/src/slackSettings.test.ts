import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, test, vi } from "vitest";

// config.ts captures integration secrets during module initialization. Supply a
// harmless test-only Slack app identity before slackSettings.ts reads it.
vi.mock("./config.ts", async (importActual) => {
  const actual = await importActual<typeof import("./config.ts")>();
  return {
    ...actual,
    SLACK_STATIC_CONFIG: {
      ...actual.SLACK_STATIC_CONFIG,
      workspaceHost: "example.slack.test",
      teamId: "T-test",
      clientId: "slack-client-id-sentinel",
      clientSecret: "slack-client-secret-sentinel",
      appToken: "",
      userScopes: ["search:read"],
      botScopes: ["chat:write"],
    },
  };
});

const { DATA_DIR } = await import("./config.ts");
const {
  createSlackOAuthStartUrl,
  getSlackPublicApiConfig,
  getSlackSettings,
  getSlackToolConfig,
  handleSlackOAuthCallback,
  testSlackSettings,
  updateSlackSettings,
} = await import("./slackSettings.ts");

const originalFetch = globalThis.fetch;

afterEach(() => {
  delete process.env.SLACK_TOKEN;
  delete process.env.SLACK_USER_TOKEN;
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

test("public Slack API projection ignores the ambiguous legacy token environment variable", () => {
  updateSlackSettings({ enabled: true, clearUserToken: true });
  process.env.SLACK_TOKEN = "xoxb-ambiguous";
  assert.throws(
    () => getSlackPublicApiConfig(),
    /Missing Slack personal user token/,
  );
  assert.throws(() => getSlackToolConfig("user"), /Missing Slack user token/);

  process.env.SLACK_USER_TOKEN = "xoxp-personal";
  assert.equal(getSlackPublicApiConfig().token, "xoxp-personal");
});

test("browser settings expose only end-user connection flags", () => {
  updateSlackSettings({
    enabled: true,
    userToken: "xoxp-personal",
    botToken: "xoxb-bot",
  });
  assert.deepEqual(Object.keys(getSlackSettings()).sort(), [
    "botTokenConfigured",
    "connected",
    "enabled",
    "oauthClientConfigured",
    "userTokenConfigured",
  ]);
});

test("Slack API projections select the personal or bot OAuth token", () => {
  updateSlackSettings({
    enabled: true,
    userToken: "xoxp-personal",
    botToken: "xoxb-bot",
  });

  assert.equal(getSlackPublicApiConfig().token, "xoxp-personal");
  assert.equal(getSlackToolConfig("user").token, "xoxp-personal");
  assert.equal(getSlackToolConfig("bot").token, "xoxb-bot");
});

test("OAuth state is single-use and rejects replayed callbacks", async () => {
  const authorize = new URL(
    createSlackOAuthStartUrl("https://pa.example.test"),
  );
  const state = authorize.searchParams.get("state")!;
  let exchanges = 0;
  globalThis.fetch = vi.fn(async () => {
    exchanges += 1;
    return new Response(
      JSON.stringify({
        ok: true,
        access_token: "xoxb-new",
        scope: "chat:write",
        bot_user_id: "B1",
        team: { id: authorize.searchParams.get("team") },
        authed_user: {
          id: "U1",
          scope: "search:read",
          access_token: "xoxp-new",
        },
      }),
    );
  }) as typeof fetch;

  const first = await handleSlackOAuthCallback(
    new URLSearchParams({ code: "code", state }),
    "https://pa.example.test",
  );
  const replay = await handleSlackOAuthCallback(
    new URLSearchParams({ code: "code", state }),
    "https://pa.example.test",
  );
  assert.equal(first.ok, true);
  assert.equal(replay.ok, false);
  assert.equal(exchanges, 1);
});

test("OAuth rejects expired state before token exchange", async () => {
  const authorize = new URL(
    createSlackOAuthStartUrl("https://pa.example.test"),
  );
  const state = authorize.searchParams.get("state")!;
  const path = join(DATA_DIR, "settings", "slack.json");
  const saved = JSON.parse(readFileSync(path, "utf8")) as Record<
    string,
    unknown
  >;
  saved.oauthStateCreatedAt = Date.now() - 11 * 60 * 1000;
  writeFileSync(path, JSON.stringify(saved));
  globalThis.fetch = vi.fn(async () => {
    throw new Error("must not exchange expired state");
  }) as typeof fetch;

  const result = await handleSlackOAuthCallback(
    new URLSearchParams({ code: "code", state }),
    "https://pa.example.test",
  );
  assert.equal(result.ok, false);
  assert.equal(vi.mocked(globalThis.fetch).mock.calls.length, 0);
});

test("OAuth rejects a token exchange for the wrong workspace", async () => {
  const authorize = new URL(
    createSlackOAuthStartUrl("https://pa.example.test"),
  );
  globalThis.fetch = vi.fn(
    async () =>
      new Response(
        JSON.stringify({
          ok: true,
          access_token: "xoxb-new",
          team: { id: "T-wrong" },
          authed_user: { id: "U1", access_token: "xoxp-new" },
        }),
      ),
  ) as typeof fetch;
  const result = await handleSlackOAuthCallback(
    new URLSearchParams({
      code: "code",
      state: authorize.searchParams.get("state")!,
    }),
    "https://pa.example.test",
  );
  assert.equal(result.ok, false);
  assert.match(result.message, /different workspace/);
});

test("Slack health checks authenticate both OAuth tokens and verify personal search", async () => {
  updateSlackSettings({
    enabled: true,
    userToken: "xoxp-personal",
    botToken: "xoxb-bot",
  });
  const requests: Array<{ url: string; authorization: string | null }> = [];
  globalThis.fetch = vi.fn(
    async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      requests.push({
        url,
        authorization: new Headers(init?.headers).get("Authorization"),
      });
      if (url.endsWith("/auth.test"))
        return new Response(
          JSON.stringify({ ok: true, user: "tester", team: "workspace" }),
        );
      if (url.endsWith("/search.messages"))
        return new Response(
          JSON.stringify({ ok: true, messages: { total: 0 } }),
        );
      throw new Error(`Unexpected request: ${url}`);
    },
  ) as typeof fetch;

  await testSlackSettings();

  assert.deepEqual(requests, [
    {
      url: "https://slack.com/api/auth.test",
      authorization: "Bearer xoxp-personal",
    },
    {
      url: "https://slack.com/api/auth.test",
      authorization: "Bearer xoxb-bot",
    },
    {
      url: "https://slack.com/api/search.messages",
      authorization: "Bearer xoxp-personal",
    },
  ]);
});

test("connected needs both OAuth tokens, and disconnect clears both", () => {
  updateSlackSettings({ userToken: "xoxp-fixture", clearBotToken: true });
  assert.equal(getSlackSettings().connected, false);
  updateSlackSettings({ botToken: "xoxb-fixture" });
  assert.equal(getSlackSettings().connected, true);
  const settings = updateSlackSettings({ disconnect: true });
  assert.equal(settings.connected, false);
  assert.equal(settings.userTokenConfigured, false);
  assert.equal(settings.botTokenConfigured, false);
});
