import assert from "node:assert/strict";
import { afterEach, beforeEach, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  exec: vi.fn(),
  exists: vi.fn(() => false),
  presence: vi.fn(),
  gateway: false,
  relay: undefined as { port: number } | undefined,
}));
vi.mock("node:fs", () => ({ existsSync: mocks.exists }));
vi.mock("./spawnBroker.ts", () => ({ brokerExecFile: mocks.exec }));
vi.mock("./config.ts", () => ({
  get GATEWAY_ENABLED() {
    return mocks.gateway;
  },
  get GATEWAY_RELAY() {
    return mocks.relay;
  },
}));
vi.mock("./credentialProfiles.ts", () => ({
  claudeConfigDir: (id: string) => `/fixtures/${id}`,
  claudeProfileEnvironment: (id: string) => ({
    HOME: "/fixtures/home",
    PATH: "/bin",
    CLAUDE_CONFIG_DIR: `/fixtures/${id}`,
    ANTHROPIC_API_KEY: "must-not-leak",
    CLAUDE_CODE_OAUTH_TOKEN: "must-not-leak",
    ASSISTANT_TOKEN: "must-not-leak",
  }),
  credentialProfileById: (id: string) => ({ id, provider: "claude" }),
  credentialProfilesOfKind: () => [],
  setClaudeStoredLoginPresence: mocks.presence,
}));
const { refreshClaudeCredentialStatus } =
  await import("./claudeCredentialStatus.ts");
const originalPlatform = process.platform;

beforeEach(() => {
  Object.defineProperty(process, "platform", { value: "darwin" });
  mocks.exec.mockReset();
  mocks.exists.mockReturnValue(false);
  mocks.presence.mockClear();
  mocks.gateway = false;
  mocks.relay = undefined;
});
afterEach(() =>
  Object.defineProperty(process, "platform", { value: originalPlatform }),
);

function result(status: unknown, error: unknown = null) {
  return { stdout: JSON.stringify(status), stderr: "", error };
}

test.each(["claude-default", "named-profile"])(
  "recognizes %s Keychain OAuth using only its isolated CLI environment",
  async (id) => {
    mocks.exec.mockResolvedValue(
      result({
        loggedIn: true,
        authMethod: "claude.ai",
        email: "not-retained@example.test",
      }),
    );
    await refreshClaudeCredentialStatus(id);
    assert.deepEqual(mocks.presence.mock.calls, [[id, true]]);
    const request = mocks.exec.mock.calls[0]![0];
    assert.deepEqual(request.args, ["auth", "status", "--json"]);
    assert.equal(request.env.HOME, "/fixtures/home");
    assert.equal(request.env.CLAUDE_CONFIG_DIR, `/fixtures/${id}`);
    assert.doesNotMatch(JSON.stringify(request), /must-not-leak/);
    assert.doesNotMatch(
      JSON.stringify(mocks.presence.mock.calls),
      /not-retained/,
    );
  },
);

test.each([
  result({ loggedIn: true, authMethod: "api_key" }),
  result({ loggedIn: false, authMethod: "none" }, { code: 1 }),
])(
  "API keys and logout do not count as a saved subscription login",
  async (response) => {
    mocks.exec.mockResolvedValue(response);
    await refreshClaudeCredentialStatus("claude-default");
    assert.deepEqual(mocks.presence.mock.calls, [["claude-default", false]]);
  },
);

test.each([
  { stdout: "not JSON", stderr: "", error: null },
  result({}, null),
  result({ loggedIn: false }, { code: "ABORT_ERR" }),
])(
  "a failed or malformed status probe is not evidence of logout",
  async (response) => {
    mocks.exec.mockResolvedValue(response);
    await refreshClaudeCredentialStatus("claude-default");
    assert.equal(mocks.presence.mock.calls.length, 0);
  },
);

test("uses file presence without starting a CLI, and never probes on Linux", async () => {
  mocks.exists.mockReturnValue(true);
  await refreshClaudeCredentialStatus("claude-default");
  assert.equal(mocks.exec.mock.calls.length, 0);
  assert.deepEqual(mocks.presence.mock.calls, [["claude-default", false]]);
  Object.defineProperty(process, "platform", { value: "linux" });
  mocks.exists.mockReturnValue(false);
  await refreshClaudeCredentialStatus("claude-default");
  assert.equal(mocks.exec.mock.calls.length, 0);
});

test.each(["gateway", "relay"])(
  "%s mode never probes a local Keychain or changes remote readiness",
  async (mode) => {
    if (mode === "gateway") mocks.gateway = true;
    else mocks.relay = { port: 8788 };
    await refreshClaudeCredentialStatus("claude-default");
    assert.equal(mocks.exec.mock.calls.length, 0);
    assert.equal(mocks.presence.mock.calls.length, 0);
  },
);

test("concurrent probes for one profile share one bounded subprocess", async () => {
  let complete!: (value: ReturnType<typeof result>) => void;
  mocks.exec.mockReturnValue(
    new Promise((resolve) => {
      complete = resolve;
    }),
  );
  const first = refreshClaudeCredentialStatus("claude-default");
  const second = refreshClaudeCredentialStatus("claude-default");
  assert.equal(mocks.exec.mock.calls.length, 1);
  complete(result({ loggedIn: true, authMethod: "claude.ai" }));
  await Promise.all([first, second]);
  assert.equal(mocks.presence.mock.calls.length, 1);
});
