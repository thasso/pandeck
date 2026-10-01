import assert from "node:assert/strict";
import { afterEach, test, vi } from "vitest";
import {
  getJiraCredsIfAvailable,
  getJiraSettings,
  getJiraToolConfig,
  isJiraConfigured,
  testJiraSettings,
  updateJiraSettings,
} from "./jiraSettings.ts";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
  // Reset to a clean disabled/empty state so tests don't leak into each other.
  updateJiraSettings({
    enabled: false,
    atlassianEmail: "",
    clearAtlassianToken: true,
  });
});

test("public projection hides the token and exposes the static host", () => {
  const projection = updateJiraSettings({
    enabled: true,
    atlassianEmail: "me@example.com",
    atlassianToken: "secret-token",
  });
  assert.equal(projection.enabled, true);
  assert.equal(projection.atlassianEmail, "me@example.com");
  assert.equal(projection.atlassianTokenConfigured, true);
  assert.ok(projection.jiraHost); // static deployment host
  // The raw token must never appear in the public projection.
  assert.doesNotMatch(JSON.stringify(projection), /secret-token/);
  assert.equal(
    (projection as unknown as Record<string, unknown>).atlassianToken,
    undefined,
  );
});

test("clearAtlassianToken removes the stored token", () => {
  updateJiraSettings({
    enabled: true,
    atlassianEmail: "me@example.com",
    atlassianToken: "secret-token",
  });
  const cleared = updateJiraSettings({ clearAtlassianToken: true });
  assert.equal(cleared.atlassianTokenConfigured, false);
  assert.throws(
    () => getJiraToolConfig(),
    /Missing Atlassian email or API token/,
  );
});

test("getJiraToolConfig throws when disabled and returns creds when enabled+configured", () => {
  updateJiraSettings({
    enabled: false,
    atlassianEmail: "me@example.com",
    atlassianToken: "t",
  });
  assert.throws(() => getJiraToolConfig(), /disabled/);

  updateJiraSettings({
    enabled: true,
    atlassianEmail: "me@example.com",
    atlassianToken: "t",
  });
  const config = getJiraToolConfig();
  assert.equal(config.atlassianEmail, "me@example.com");
  assert.equal(config.atlassianToken, "t");
  assert.equal(config.jiraHost, getJiraSettings().jiraHost);
});

test("getJiraCredsIfAvailable and isJiraConfigured reflect enable + creds", () => {
  updateJiraSettings({
    enabled: false,
    atlassianEmail: "me@example.com",
    atlassianToken: "t",
  });
  assert.equal(getJiraCredsIfAvailable(), null);
  assert.equal(isJiraConfigured(), false);

  updateJiraSettings({ enabled: true });
  assert.ok(getJiraCredsIfAvailable());
  assert.equal(isJiraConfigured(), true);

  updateJiraSettings({ clearAtlassianToken: true });
  assert.equal(getJiraCredsIfAvailable(), null);
  assert.equal(isJiraConfigured(), false);
});

test("testJiraSettings reports the authenticated user on success and failure otherwise", async () => {
  updateJiraSettings({
    enabled: true,
    atlassianEmail: "me@example.com",
    atlassianToken: "t",
  });

  globalThis.fetch = vi.fn(
    async () =>
      new Response(
        JSON.stringify({ accountId: "acc-123", displayName: "Ada" }),
        { status: 200 },
      ),
  ) as unknown as typeof fetch;
  const ok = await testJiraSettings();
  assert.equal(ok.ok, true);
  assert.equal(ok.accountId, "acc-123");
  assert.equal(ok.displayName, "Ada");

  globalThis.fetch = vi.fn(
    async () => new Response("nope", { status: 401 }),
  ) as unknown as typeof fetch;
  const bad = await testJiraSettings();
  assert.equal(bad.ok, false);
  assert.match(bad.message, /HTTP 401/);
});
