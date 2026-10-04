import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, test, vi } from "vitest";

// Inject Tempo OAuth client creds (config.ts computes these at import from env/app.json,
// neither of which is set in the temp test CWD). Everything else stays real, incl. the
// temp-dir DATA_DIR and the default JIRA_HOST.
vi.mock("./config.ts", async (importActual) => ({
  ...(await importActual<typeof import("./config.ts")>()),
  TEMPO_OAUTH_CLIENT_ID: "test-client",
  TEMPO_OAUTH_CLIENT_SECRET: "test-secret",
}));

const { DATA_DIR, JIRA_HOST } = await import("./config.ts");
const {
  createTempoOAuthStartUrl,
  handleTempoOAuthCallback,
  getTempoSettings,
  getTempoToolConfig,
  testTempoSettings,
  updateTempoSettings,
} = await import("./tempoSettings.ts");

const TEMPO_FILE = join(DATA_DIR, "settings", "tempo.json");
const originalFetch = globalThis.fetch;

function writeTempoFile(obj: Record<string, unknown>): void {
  mkdirSync(join(DATA_DIR, "settings"), { recursive: true });
  writeFileSync(TEMPO_FILE, JSON.stringify(obj), "utf8");
}

beforeEach(() => {
  writeTempoFile({ enabled: false });
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

test("no migration: a legacy combined tempo.json resets to clean defaults", () => {
  writeTempoFile({
    enabled: true,
    apiBaseUrl: "https://api.tempo.io/999",
    authorAccountId: "legacy-acc",
    // legacy combined-shape markers that must trigger a full reset:
    tempoToken: "legacy-tempo",
    atlassianEmail: "legacy@example.com",
    atlassianToken: "legacy-jira",
    jiraHost: "legacy.atlassian.net",
  });
  const settings = getTempoSettings();
  assert.equal(settings.enabled, false);
  assert.equal(settings.apiBaseUrl, "https://api.tempo.io/4");
  assert.equal(settings.authorAccountId, "");
  assert.equal(settings.refreshTokenConfigured, false);
});

test("createTempoOAuthStartUrl builds the instance-hosted authorize URL with tenant_user + state", () => {
  const url = new URL(createTempoOAuthStartUrl("https://pa.example.net"));
  assert.equal(url.host, JIRA_HOST);
  assert.equal(
    url.pathname,
    "/plugins/servlet/ac/io.tempo.jira/oauth-authorize/",
  );
  assert.equal(url.searchParams.get("client_id"), "test-client");
  assert.equal(url.searchParams.get("response_type"), "code");
  assert.equal(url.searchParams.get("access_type"), "tenant_user");
  assert.ok((url.searchParams.get("state") ?? "").length > 10);
  assert.equal(
    url.searchParams.get("redirect_uri"),
    "https://pa.example.net/api/tempo/oauth/callback",
  );
});

test("handleTempoOAuthCallback rejects a mismatched state and accepts a matching one", async () => {
  const state = new URL(
    createTempoOAuthStartUrl("https://pa.example.net"),
  ).searchParams.get("state")!;

  const bad = await handleTempoOAuthCallback(
    new URLSearchParams({ code: "c", state: "wrong" }),
  );
  assert.equal(bad.ok, false);
  assert.match(bad.message, /state did not match/i);

  globalThis.fetch = vi.fn(
    async () =>
      new Response(
        JSON.stringify({
          access_token: "at-1",
          refresh_token: "rt-1",
          expires_in: 3600,
        }),
        { status: 200 },
      ),
  ) as unknown as typeof fetch;
  const ok = await handleTempoOAuthCallback(
    new URLSearchParams({ code: "c", state }),
    "https://pa.example.net",
  );
  assert.equal(ok.ok, true);
  assert.equal(getTempoSettings().refreshTokenConfigured, true);
});

test("getTempoToolConfig refreshes an expired access token via the refresh token", async () => {
  writeTempoFile({
    enabled: true,
    apiBaseUrl: "https://api.tempo.io/4",
    accessToken: "stale",
    refreshToken: "rt-1",
    accessTokenExpiresAt: Date.now() - 1000, // expired
  });
  const tokenCall = vi.fn(
    async () =>
      new Response(
        JSON.stringify({
          access_token: "fresh",
          refresh_token: "rt-2",
          expires_in: 3600,
        }),
        { status: 200 },
      ),
  );
  globalThis.fetch = tokenCall as unknown as typeof fetch;

  const config = await getTempoToolConfig();
  assert.equal(config.accessToken, "fresh");
  assert.ok(tokenCall.mock.calls.length >= 1);
  // rotated refresh token persisted
  assert.equal(getTempoSettings().refreshTokenConfigured, true);
});

test("a malformed refresh response fails loudly instead of returning the stale token", async () => {
  writeTempoFile({
    enabled: true,
    apiBaseUrl: "https://api.tempo.io/4",
    accessToken: "stale",
    refreshToken: "rt-1",
    accessTokenExpiresAt: Date.now() - 1000,
  });
  // 2xx but missing access_token/expires_in.
  globalThis.fetch = vi.fn(async (input: unknown) => {
    const url = String(input);
    if (url.includes("/oauth/token"))
      return new Response(JSON.stringify({ token_type: "bearer" }), {
        status: 200,
      });
    return new Response("{}", { status: 200 });
  }) as unknown as typeof fetch;

  const status = await testTempoSettings();
  assert.equal(status.ok, false);
  assert.match(status.message, /refresh failed/i);
  // getTempoToolConfig should also throw rather than hand out the stale token.
  await assert.rejects(
    () => getTempoToolConfig(),
    /access_token or expires_in/,
  );
});

test("disconnect via clearTokens drops authorization", () => {
  writeTempoFile({
    enabled: true,
    accessToken: "at",
    refreshToken: "rt",
    accessTokenExpiresAt: Date.now() + 100000,
  });
  const cleared = updateTempoSettings({ clearTokens: true });
  assert.equal(cleared.refreshTokenConfigured, false);
});

test("a refresh that finishes after a disconnect does not reconnect", async () => {
  writeTempoFile({
    enabled: true,
    apiBaseUrl: "https://api.tempo.io/4",
    accessToken: "stale",
    refreshToken: "rt-1",
    accessTokenExpiresAt: Date.now() - 1000,
  });
  let release = () => {};
  const gate = new Promise<void>((resolve) => (release = resolve));
  globalThis.fetch = vi.fn(async () => {
    await gate;
    return new Response(
      JSON.stringify({
        access_token: "fresh",
        refresh_token: "rt-2",
        expires_in: 3600,
      }),
      { status: 200 },
    );
  }) as unknown as typeof fetch;

  const pending = getTempoToolConfig();
  await new Promise((resolve) => setTimeout(resolve, 10));
  updateTempoSettings({ clearTokens: true });
  release();
  await pending;
  assert.equal(getTempoSettings().refreshTokenConfigured, false);
});
