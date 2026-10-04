import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, test, vi } from "vitest";

// A refresh needs a configured OAuth client; config.ts reads it at import.
vi.mock("./config.ts", async (importActual) => ({
  ...(await importActual<typeof import("./config.ts")>()),
  GOOGLE_OAUTH_CLIENT_ID: "test-client",
  GOOGLE_OAUTH_CLIENT_SECRET: "test-client-value",
}));

const { DATA_DIR } = await import("./config.ts");
const { ensureGoogleAccessToken, getGoogleSettings, updateGoogleSettings } =
  await import("./googleSettings.ts");

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

test("a refresh that finishes after a disconnect does not reconnect", async () => {
  mkdirSync(join(DATA_DIR, "settings"), { recursive: true });
  writeFileSync(
    join(DATA_DIR, "settings", "google.json"),
    JSON.stringify({
      enabled: true,
      refreshToken: "rt-1",
      accessToken: "stale",
      accessTokenExpiresAt: Date.now() - 1000,
    }),
  );
  let release = () => {};
  const gate = new Promise<void>((resolve) => (release = resolve));
  globalThis.fetch = vi.fn(async () => {
    await gate;
    return new Response(
      JSON.stringify({ access_token: "fresh", expires_in: 3600 }),
      { status: 200 },
    );
  }) as unknown as typeof fetch;

  const pending = ensureGoogleAccessToken();
  await new Promise((resolve) => setTimeout(resolve, 10));
  updateGoogleSettings({ clearTokens: true });
  release();
  assert.equal(await pending, "fresh");
  assert.equal(getGoogleSettings().refreshTokenConfigured, false);
  // Nor is the refreshed access token kept for a grant the user removed.
  const stored = JSON.parse(
    readFileSync(join(DATA_DIR, "settings", "google.json"), "utf8"),
  ) as { accessToken?: string };
  assert.equal(stored.accessToken, "");
});
