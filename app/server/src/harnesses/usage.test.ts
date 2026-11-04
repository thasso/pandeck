/**
 * Which path Claude usage takes (G4b): the CLI child with the switch off,
 * exactly as before, and the gateway alone with it on, never falling back to
 * the CLI when the gateway cannot grant a lease. Every upstream is a fake.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test, vi } from "vitest";
import type { ClaudeQueryParams, ClaudeSdkSeam } from "../claudeSdk/sdkSeam.ts";
import { setClaudeSdkUsageSeam } from "../claudeSdk/usageQuery.ts";
import {
  claudeConfigDir,
  claudeProfileEnvironment,
  createCredentialProfile,
  deleteCredentialProfile,
} from "../credentialProfiles.ts";
import { GATEWAY_UNAVAILABLE_TEXT, startGatewayLink } from "../gatewayLink.ts";
import { analyzeProviderError, runFailureFacts } from "../providerErrors.ts";
import { MEASURED_USAGE } from "../test/claudeUsageFixtures.ts";
import { startFakeUpstreams } from "../test/gatewayFixtures.ts";
import { startGatewayLinkForTests } from "../test/gatewayLink.ts";
import { fetchClaudeAccountUsage } from "./usage.ts";

/** The CLI's usage control request, answered by a fake seam that records. */
function recordingSeam(): {
  factory: ReturnType<typeof vi.fn<() => Promise<ClaudeSdkSeam>>>;
  params: ClaudeQueryParams[];
  usageOptions: unknown[];
} {
  const params: ClaudeQueryParams[] = [];
  const usageOptions: unknown[] = [];
  const seam = {
    query: (p: ClaudeQueryParams) => {
      params.push(p);
      return {
        async *[Symbol.asyncIterator]() {},
        close: () => {},
        usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: async (
          options: unknown,
        ) => {
          usageOptions.push(options);
          return { rate_limits_available: false };
        },
      };
    },
  } as unknown as ClaudeSdkSeam;
  return {
    factory: vi.fn(() => Promise.resolve(seam)),
    params,
    usageOptions,
  };
}

// Synthetic fixture values; none is a real credential.
const FAKE_ACCESS = "fake-claude-access";
const FAKE_REFRESH = "fake-claude-refresh";

const profiles: string[] = [];

function claudeProfile(name: string): string {
  const { id } = createCredentialProfile({ name, provider: "claude" });
  profiles.push(id);
  writeFileSync(
    join(claudeConfigDir(id), ".credentials.json"),
    JSON.stringify({
      claudeAiOauth: {
        accessToken: `${FAKE_ACCESS}`,
        refreshToken: `${FAKE_REFRESH}`,
        expiresAt: Date.now() + 86_400_000,
        subscriptionType: "max",
      },
    }),
  );
  return id;
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  for (const id of profiles.splice(0)) deleteCredentialProfile(id);
});

test("AC8: with the switch off, Claude usage runs the CLI child as before and sends nothing itself", async () => {
  const id = claudeProfile("Usage switch off");
  const seam = recordingSeam();
  setClaudeSdkUsageSeam(seam.factory);
  const fetchSpy = vi.fn();
  vi.stubGlobal("fetch", fetchSpy);

  await fetchClaudeAccountUsage(id, 20_000);
  assert.equal(seam.factory.mock.calls.length, 1);
  assert.deepEqual(seam.params[0]?.options?.env, claudeProfileEnvironment(id));
  assert.deepEqual(seam.usageOptions, [{ skipBehaviors: true }]);
  assert.equal(fetchSpy.mock.calls.length, 0);
});

test("AC8: with the switch on, Claude usage starts no CLI child", async () => {
  const id = claudeProfile("Usage switch on");
  const seam = recordingSeam();
  setClaudeSdkUsageSeam(seam.factory);
  const upstreams = await startFakeUpstreams({
    claude: (_seen, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(MEASURED_USAGE));
    },
  });
  const gateway = await startGatewayLinkForTests({
    upstreams: upstreams.overrides,
  });
  try {
    const snapshot = await fetchClaudeAccountUsage(id, 20_000);
    assert.equal(snapshot.rateLimitsAvailable, true);
    assert.equal(seam.factory.mock.calls.length, 0);
    assert.deepEqual(
      upstreams.anthropic.map((seen) => [seen.method, seen.url]),
      [["GET", "/api/oauth/usage"]],
    );
  } finally {
    await gateway.close();
    await upstreams.close();
  }
});

test.each(["failed", "not ready"] as const)(
  "AC9: a gateway that has %s fails Claude usage with U7's text, never falling back to the CLI",
  async (state) => {
    const id = claudeProfile(`Usage gateway ${state}`);
    const seam = recordingSeam();
    setClaudeSdkUsageSeam(seam.factory);
    if (state === "not ready")
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let endStart = (): void => {};
    const dir = mkdtempSync(join(tmpdir(), "usage-link-"));
    const link = startGatewayLink({
      stateDir: join(dir, "state"),
      port: 0,
      log: () => {},
      start: () =>
        state === "failed"
          ? Promise.reject(new Error("the fixture's gateway did not start"))
          : new Promise((_resolve, reject) => {
              endStart = () => reject(new Error("the test ends the start"));
            }),
    });
    try {
      const read = fetchClaudeAccountUsage(id, 20_000);
      let outcome: { err: unknown } | undefined;
      void read.then(
        () => (outcome = { err: undefined }),
        (err: unknown) => (outcome = { err }),
      );
      // A link that is not ready answers after its 10 s readiness timer.
      while (!outcome) {
        await new Promise<void>((resolve) => setImmediate(resolve));
        if (state === "not ready") await vi.advanceTimersByTimeAsync(1_000);
      }
      const { err } = outcome;
      assert.ok(err instanceof Error);
      assert.equal(err.message, GATEWAY_UNAVAILABLE_TEXT);
      assert.ok(!runFailureFacts(analyzeProviderError(err.message)).loginDeath);
      assert.equal(seam.factory.mock.calls.length, 0, "no CLI fallback");
    } finally {
      vi.useRealTimers();
      endStart();
      await link.close();
      rmSync(dir, { recursive: true, force: true });
    }
  },
);
