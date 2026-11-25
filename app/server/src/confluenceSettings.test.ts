import assert from "node:assert/strict";
import { afterEach, test, vi } from "vitest";
import {
  getConfluenceSettings,
  getConfluenceToolConfig,
  testConfluenceSettings,
  updateConfluenceSettings,
} from "./confluenceSettings.ts";
import { updateJiraSettings } from "./jiraSettings.ts";
import {
  installRemoteIntegrationPort,
  rememberAtlassianStatus,
  type IntegrationStatus,
} from "./remoteIntegrations.ts";
import { installRemoteToolPort } from "./remoteTools.ts";

const originalFetch = globalThis.fetch;

async function withJiraCredentials(): Promise<void> {
  await updateJiraSettings({
    enabled: true,
    atlassianEmail: "me@example.com",
    atlassianToken: "secret-token",
  });
}

afterEach(async () => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
  updateConfluenceSettings({ enabled: false });
  await updateJiraSettings({
    enabled: false,
    atlassianEmail: "",
    clearAtlassianToken: true,
  });
});

test("the projection carries the static host and the shared-credential state", async () => {
  await withJiraCredentials();
  const projection = updateConfluenceSettings({ enabled: true });
  assert.equal(projection.enabled, true);
  assert.ok(projection.confluenceHost);
  assert.equal(projection.credentialsAvailable, true);
  // Confluence stores no secret of its own, and never echoes Jira's.
  assert.doesNotMatch(JSON.stringify(projection), /secret-token/);
});

test("outside client mode the projection has exactly its three fields", async () => {
  await withJiraCredentials();
  updateConfluenceSettings({ enabled: true });
  const projection = getConfluenceSettings();
  assert.deepEqual(Object.keys(projection).sort(), [
    "confluenceHost",
    "credentialsAvailable",
    "enabled",
  ]);
  assert.equal("credentialStore" in projection, false);
});

test("credentialsAvailable follows the Jira integration", async () => {
  updateConfluenceSettings({ enabled: true });
  assert.equal(getConfluenceSettings().credentialsAvailable, false);
  await withJiraCredentials();
  assert.equal(getConfluenceSettings().credentialsAvailable, true);
  await updateJiraSettings({ enabled: false });
  assert.equal(getConfluenceSettings().credentialsAvailable, false);
});

test("the tool config names the setting that is missing", async () => {
  await withJiraCredentials();
  updateConfluenceSettings({ enabled: false });
  assert.throws(() => getConfluenceToolConfig(), /Settings → Confluence/);

  updateConfluenceSettings({ enabled: true });
  await updateJiraSettings({ enabled: false });
  assert.throws(() => getConfluenceToolConfig(), /Settings → Jira/);

  await withJiraCredentials();
  const config = getConfluenceToolConfig();
  assert.equal(config.atlassianEmail, "me@example.com");
  assert.equal(config.atlassianToken, "secret-token");
  assert.ok(config.host);
});

test("the connection test reports the authenticated user", async () => {
  await withJiraCredentials();
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
  await withJiraCredentials();
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

// --- client mode (Task-1439 P3) --------------------------------------------

/** The gateway's last Atlassian answers the cache is seeded with. */
const GATEWAY_STATES: [string, IntegrationStatus, boolean][] = [
  [
    "stored",
    {
      connected: true,
      kind: "oauth",
      site: "gateway-site.atlassian.net",
      email: "gateway-user@example.com",
    },
    true,
  ],
  // A refused OAuth record names no site, yet is stored.
  ["rejected", { connected: false, kind: "oauth", problem: "rejected" }, true],
  ["nothing stored", { connected: false }, false],
];

/**
 * Client mode with tripwire ports: every gateway RPC and every fetch is
 * recorded and refused. Disposed before the file's local cleanup runs, which
 * would otherwise reach the integration port through Settings → Jira.
 */
async function withTripwires(
  status: IntegrationStatus,
  run: () => Promise<void>,
): Promise<string[]> {
  const calls: string[] = [];
  const refuse = (what: string) => {
    calls.push(what);
    return Promise.reject(new Error(`tripwire: ${what}`));
  };
  globalThis.fetch = vi.fn((input: unknown) =>
    refuse(`fetch ${String(input)}`),
  ) as unknown as typeof fetch;
  const uninstallIntegrations = installRemoteIntegrationPort({
    status: () => refuse("integrations.status"),
    set: () => refuse("integrations.set"),
    clear: () => refuse("integrations.clear"),
  });
  const uninstallTools = installRemoteToolPort({
    callFile: (name) => refuse(`tools.callFile ${name}`),
    call: (name) => refuse(`tools.call ${name}`),
    prepare: (name) => refuse(`tools.prepare ${name}`),
    apply: (name) => refuse(`tools.apply ${name}`),
  });
  try {
    // Seeded directly, never through a port.
    rememberAtlassianStatus(status);
    await run();
  } finally {
    uninstallTools();
    uninstallIntegrations();
    globalThis.fetch = originalFetch;
  }
  return calls;
}

for (const [label, status, stored] of GATEWAY_STATES) {
  test(`client mode, ${label}: Settings answers from the gateway's status with no call`, async () => {
    // A local credential that client mode must not read.
    await withJiraCredentials();
    updateConfluenceSettings({ enabled: true });
    const calls = await withTripwires(status, async () => {
      const projection = getConfluenceSettings();
      assert.deepEqual(projection, {
        enabled: true,
        confluenceHost: projection.confluenceHost,
        credentialsAvailable: stored,
        credentialStore: "gateway",
      });
      // Minimal and secret-free: no email, site or token.
      assert.doesNotMatch(
        JSON.stringify(projection),
        /@example\.com|gateway-site|secret-token/,
      );
    });
    assert.deepEqual(calls, []);
  });

  test(`client mode, ${label}: the connection test makes no call and answers fixed text`, async () => {
    await withJiraCredentials();
    const calls = await withTripwires(status, async () => {
      const status = await testConfluenceSettings();
      assert.equal(status.ok, stored);
      assert.equal(typeof status.checkedAt, "number");
      assert.equal(
        status.message,
        stored
          ? "Confluence uses this Pandeck's gateway Atlassian connection; test it under Settings → Jira."
          : "No Atlassian connection on the gateway. Connect Atlassian under Settings → Jira.",
      );
      assert.equal(status.accountId, undefined);
      assert.equal(status.displayName, undefined);
    });
    assert.deepEqual(calls, []);
  });
}
