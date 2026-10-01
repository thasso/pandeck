import assert from "node:assert/strict";
import { afterEach, test, vi } from "vitest";
import {
  getConfluenceSettings,
  getConfluenceToolConfig,
  testConfluenceSettings,
  updateConfluenceSettings,
} from "./confluenceSettings.ts";
import { updateJiraSettings } from "./jiraSettings.ts";

const originalFetch = globalThis.fetch;

function withJiraCredentials(): void {
  updateJiraSettings({
    enabled: true,
    atlassianEmail: "me@example.com",
    atlassianToken: "secret-token",
  });
}

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
  updateConfluenceSettings({ enabled: false });
  updateJiraSettings({
    enabled: false,
    atlassianEmail: "",
    clearAtlassianToken: true,
  });
});

test("the projection carries the static host and the shared-credential state", () => {
  withJiraCredentials();
  const projection = updateConfluenceSettings({ enabled: true });
  assert.equal(projection.enabled, true);
  assert.ok(projection.confluenceHost);
  assert.equal(projection.credentialsAvailable, true);
  // Confluence stores no secret of its own, and never echoes Jira's.
  assert.doesNotMatch(JSON.stringify(projection), /secret-token/);
});

test("credentialsAvailable follows the Jira integration", () => {
  updateConfluenceSettings({ enabled: true });
  assert.equal(getConfluenceSettings().credentialsAvailable, false);
  withJiraCredentials();
  assert.equal(getConfluenceSettings().credentialsAvailable, true);
  updateJiraSettings({ enabled: false });
  assert.equal(getConfluenceSettings().credentialsAvailable, false);
});

test("the tool config names the setting that is missing", () => {
  withJiraCredentials();
  updateConfluenceSettings({ enabled: false });
  assert.throws(() => getConfluenceToolConfig(), /Settings → Confluence/);

  updateConfluenceSettings({ enabled: true });
  updateJiraSettings({ enabled: false });
  assert.throws(() => getConfluenceToolConfig(), /Settings → Jira/);

  withJiraCredentials();
  const config = getConfluenceToolConfig();
  assert.equal(config.atlassianEmail, "me@example.com");
  assert.equal(config.atlassianToken, "secret-token");
  assert.ok(config.host);
});

test("the connection test reports the authenticated user", async () => {
  withJiraCredentials();
  globalThis.fetch = vi.fn(
    async () =>
      new Response(JSON.stringify({ accountId: "abc", displayName: "Ada" }), {
        status: 200,
      }),
  ) as unknown as typeof fetch;
  const status = await testConfluenceSettings();
  assert.equal(status.ok, true);
  assert.equal(status.accountId, "abc");
  assert.match(status.message, /Ada/);
});

test("a site that refuses the identity call still counts as reachable", async () => {
  withJiraCredentials();
  let call = 0;
  globalThis.fetch = vi.fn(async () => {
    call += 1;
    // First the current-user call is refused, then the space listing answers.
    return call === 1
      ? new Response("no scope", { status: 403 })
      : new Response(JSON.stringify({ results: [] }), { status: 200 });
  }) as unknown as typeof fetch;
  const status = await testConfluenceSettings();
  assert.equal(status.ok, true);
  assert.match(status.message, /reachable/);
});

test("without Jira credentials the test points at the Jira page", async () => {
  const status = await testConfluenceSettings();
  assert.equal(status.ok, false);
  assert.match(status.message, /Settings → Jira/);
});
