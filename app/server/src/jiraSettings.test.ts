import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, test, vi } from "vitest";
import {
  getJiraCredsIfAvailable,
  getJiraSettings,
  getJiraToolConfig,
  isJiraConfigured,
  testJiraSettings,
  updateJiraSettings,
} from "./jiraSettings.ts";
import { DATA_DIR } from "./config.ts";
import {
  IntegrationRefusal,
  installRemoteIntegrationPort,
  type IntegrationStatus,
  type RemoteIntegrationPort,
} from "./remoteIntegrations.ts";

const originalFetch = globalThis.fetch;

afterEach(async () => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
  // Reset to a clean disabled/empty state so tests don't leak into each other.
  await updateJiraSettings({
    enabled: false,
    atlassianEmail: "",
    clearAtlassianToken: true,
  });
});

test("public projection hides the token and exposes the static host", async () => {
  const projection = await updateJiraSettings({
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

test("clearAtlassianToken removes the stored token", async () => {
  await updateJiraSettings({
    enabled: true,
    atlassianEmail: "me@example.com",
    atlassianToken: "secret-token",
  });
  const cleared = await updateJiraSettings({ clearAtlassianToken: true });
  assert.equal(cleared.atlassianTokenConfigured, false);
  assert.throws(
    () => getJiraToolConfig(),
    /Missing Atlassian email or API token/,
  );
});

test("getJiraToolConfig throws when disabled and returns creds when enabled+configured", async () => {
  await updateJiraSettings({
    enabled: false,
    atlassianEmail: "me@example.com",
    atlassianToken: "t",
  });
  assert.throws(() => getJiraToolConfig(), /disabled/);

  await updateJiraSettings({
    enabled: true,
    atlassianEmail: "me@example.com",
    atlassianToken: "t",
  });
  const config = getJiraToolConfig();
  assert.equal(config.atlassianEmail, "me@example.com");
  assert.equal(config.atlassianToken, "t");
  assert.equal(config.jiraHost, getJiraSettings().jiraHost);
});

test("getJiraCredsIfAvailable and isJiraConfigured reflect enable + creds", async () => {
  await updateJiraSettings({
    enabled: false,
    atlassianEmail: "me@example.com",
    atlassianToken: "t",
  });
  assert.equal(getJiraCredsIfAvailable(), null);
  assert.equal(isJiraConfigured(), false);

  await updateJiraSettings({ enabled: true });
  assert.ok(getJiraCredsIfAvailable());
  assert.equal(isJiraConfigured(), true);

  await updateJiraSettings({ clearAtlassianToken: true });
  assert.equal(getJiraCredsIfAvailable(), null);
  assert.equal(isJiraConfigured(), false);
});

test("testJiraSettings reports the authenticated user on success and failure otherwise", async () => {
  await updateJiraSettings({
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

// --- client mode (Task-1397) ----------------------------------------------

const JIRA_FILE = join(DATA_DIR, "settings", "jira.json");

function fakePort(status: IntegrationStatus = { connected: false }) {
  const calls: { method: string; args: unknown[] }[] = [];
  let answer: IntegrationStatus | Error = status;
  const port: RemoteIntegrationPort = {
    set: async (input) => {
      calls.push({ method: "set", args: [input] });
      if (answer instanceof Error) throw answer;
      return answer;
    },
    clear: async () => {
      calls.push({ method: "clear", args: [] });
      if (answer instanceof Error) throw answer;
    },
    status: async (check) => {
      calls.push({ method: "status", args: [check] });
      if (answer instanceof Error) throw answer;
      return answer;
    },
  };
  const uninstall = installRemoteIntegrationPort(port);
  return {
    calls,
    uninstall,
    answer: (next: IntegrationStatus | Error) => {
      answer = next;
    },
  };
}

test("client mode: a token goes to the gateway with the deployment's site; jira.json gets no email or token", async () => {
  await updateJiraSettings({
    enabled: false,
    atlassianEmail: "local@example.com",
    atlassianToken: "local-token-kept",
  });
  const before = readFileSync(JIRA_FILE, "utf8");
  const port = fakePort({
    connected: true,
    site: "example.atlassian.net",
    email: "me@example.com",
  });
  try {
    const projection = await updateJiraSettings({
      enabled: true,
      atlassianEmail: "me@example.com",
      atlassianToken: "fake-gateway-token",
    });
    assert.deepEqual(port.calls, [
      {
        method: "set",
        args: [
          {
            site: getJiraSettings().jiraHost,
            email: "me@example.com",
            token: "fake-gateway-token",
          },
        ],
      },
    ]);
    assert.deepEqual(projection, {
      enabled: true,
      jiraHost: getJiraSettings().jiraHost,
      atlassianEmail: "me@example.com",
      atlassianTokenConfigured: true,
      credentialStore: "gateway",
    });
    const stored = JSON.parse(readFileSync(JIRA_FILE, "utf8")) as Record<
      string,
      unknown
    >;
    // Only `enabled` changed; the old local values stay untouched.
    assert.deepEqual(stored, {
      ...(JSON.parse(before) as Record<string, unknown>),
      enabled: true,
    });
    assert.ok(!readFileSync(JIRA_FILE, "utf8").includes("fake-gateway-token"));
    assert.throws(
      () => getJiraToolConfig(),
      /In gateway client mode Jira runs on the gateway\./,
    );
    assert.equal(getJiraCredsIfAvailable(), null);
    assert.equal(isJiraConfigured(), false);

    await updateJiraSettings({ clearAtlassianToken: true });
    assert.equal(port.calls.at(-1)!.method, "clear");
    assert.equal(getJiraSettings().atlassianTokenConfigured, false);
  } finally {
    port.uninstall();
  }
  assert.equal(getJiraSettings().credentialStore, "local");
});

test("client mode: an email change needs the token again; a clear wins over email and token", async () => {
  const port = fakePort({
    connected: true,
    site: "example.atlassian.net",
    email: "old@x.test",
  });
  try {
    await updateJiraSettings({ atlassianToken: "fake-first" });
    port.calls.length = 0;
    const before = readFileSync(JIRA_FILE, "utf8");
    await assert.rejects(
      updateJiraSettings({ enabled: true, atlassianEmail: "new@x.test" }),
      /^Error: Jira: enter the API token again to change the email\.$/,
    );
    assert.equal(port.calls.length, 0);
    assert.equal(readFileSync(JIRA_FILE, "utf8"), before);

    await updateJiraSettings({
      atlassianEmail: "new@x.test",
      atlassianToken: "fake-ignored",
      clearAtlassianToken: true,
    });
    assert.deepEqual(
      port.calls.map((call) => call.method),
      ["clear"],
    );

    port.calls.length = 0;
    await updateJiraSettings({
      atlassianEmail: "new@x.test",
      atlassianToken: "fake-new",
    });
    assert.deepEqual(port.calls, [
      {
        method: "set",
        args: [
          {
            site: getJiraSettings().jiraHost,
            email: "new@x.test",
            token: "fake-new",
          },
        ],
      },
    ]);
  } finally {
    port.uninstall();
  }
});

test("client mode: refusals throw fixed texts before enabled is written; the test maps codes and problems", async () => {
  const port = fakePort();
  try {
    const before = readFileSync(JIRA_FILE, "utf8");
    port.answer(new IntegrationRefusal("integration_rejected"));
    await assert.rejects(
      updateJiraSettings({ enabled: true, atlassianToken: "fake-x" }),
      /^Error: Jira: Atlassian rejected the email and API token\.$/,
    );
    port.answer(new Error("SENTINEL foreign text"));
    await assert.rejects(
      updateJiraSettings({ enabled: true, atlassianToken: "fake-x" }),
      /^Error: Jira: the credential gateway is unreachable; try again shortly\.$/,
    );
    assert.equal(readFileSync(JIRA_FILE, "utf8"), before);

    const cases: [IntegrationStatus | Error, string][] = [
      [
        { connected: false, problem: "vault_locked" },
        "The gateway's vault is locked.",
      ],
      [
        { connected: false, problem: "vault_unavailable" },
        "The gateway's vault did not answer; try again.",
      ],
      [
        { connected: false, problem: "invalid" },
        "The gateway's Jira credential is invalid; enter the API token again.",
      ],
      [
        {
          connected: false,
          site: "example.atlassian.net",
          problem: "rejected",
        },
        "Atlassian rejected the email and API token.",
      ],
      [{ connected: false }, "Missing Atlassian email or API token."],
      [
        new IntegrationRefusal("gateway_unavailable"),
        "Jira: the credential gateway is unreachable; try again shortly.",
      ],
    ];
    for (const [answer, message] of cases) {
      port.answer(answer);
      const status = await testJiraSettings();
      assert.equal(status.ok, false);
      assert.equal(status.message, message);
    }
    port.answer({
      connected: true,
      site: "example.atlassian.net",
      email: "a@x.test",
      displayName: "Ada",
      accountId: "acc-1",
    });
    const ok = await testJiraSettings();
    assert.equal(ok.ok, true);
    assert.equal(ok.message, "Ada authenticated. accountId=acc-1");
    assert.deepEqual(port.calls.at(-1), { method: "status", args: [true] });
  } finally {
    port.uninstall();
  }
});

test("client mode without a deployment site refuses with the fixed text and calls nothing", async () => {
  vi.resetModules();
  vi.doMock("./config.ts", async (original) => ({
    ...(await original<typeof import("./config.ts")>()),
    JIRA_HOST: "",
  }));
  try {
    const settings = await import("./jiraSettings.ts");
    const remote = await import("./remoteIntegrations.ts");
    const calls: string[] = [];
    const uninstall = remote.installRemoteIntegrationPort({
      set: async () => {
        calls.push("set");
        return { connected: true };
      },
      clear: async () => {
        calls.push("clear");
      },
      status: async () => {
        calls.push("status");
        return { connected: true };
      },
    });
    try {
      await assert.rejects(
        settings.updateJiraSettings({ atlassianToken: "fake-x" }),
        /No Atlassian site configured/,
      );
      assert.match(
        (await settings.testJiraSettings()).message,
        /No Atlassian site configured/,
      );
      assert.deepEqual(calls, []);
    } finally {
      uninstall();
    }
  } finally {
    vi.doUnmock("./config.ts");
    vi.resetModules();
  }
});
