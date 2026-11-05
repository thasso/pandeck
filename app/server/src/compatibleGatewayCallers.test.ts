/**
 * Gateway on, the server's actual callers lease an OpenAI-compatible account
 * like any other (T1373 AC12): a one-shot runs through `/compat` on its
 * server lease, and an engine open is granted an engine lease before the
 * Worker answers. A fake loopback endpoint and fixture keys only.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, test } from "vitest";

const home = mkdtempSync(join(tmpdir(), "compatible-gateway-callers-"));
process.env.HOME = home;
const {
  createCredentialProfile,
  deleteCredentialProfile,
  patchOpenAiCompatibleEndpoint,
  testOpenAiCompatibleProfile,
} = await import("./credentialProfiles.ts");
const { startGatewayLink } = await import("./gatewayLink.ts");
const { runOneShot } = await import("./harnesses/oneShot.ts");
const { openEngineChannel } = await import("./workers/engineClient.ts");
const { COMPAT_KEY_A, startFakeCompatEndpoint } =
  await import("./test/gatewayFixtures.ts");

afterAll(() => rmSync(home, { recursive: true, force: true }));

test("AC12: gateway on, a compatible account's one-shot and engine open are each granted a lease, and nothing refuses its kind", async () => {
  const endpoint = await startFakeCompatEndpoint(["fixture"], "leased answer");
  const profile = createCredentialProfile({
    provider: "openai-compatible",
    name: "Leased endpoint",
  });
  patchOpenAiCompatibleEndpoint(profile.id, {
    baseUrl: endpoint.baseUrl,
    apiKey: COMPAT_KEY_A,
  });
  // Setup by the direct path: Test discovers the models at the endpoint.
  assert.equal((await testOpenAiCompatibleProfile(profile.id)).status.ok, true);
  const lines: string[] = [];
  const link = startGatewayLink({
    stateDir: join(home, "gateway"),
    port: 0,
    log: (line) => lines.push(line),
    upstreams: { "openai-codex": { connect: { host: "127.0.0.1", port: 9 } } },
    claudeTokenEndpoint: { connect: { host: "127.0.0.1", port: 9 } },
  });
  try {
    assert.equal(await link.ready, true, lines.join("\n"));
    const result = await runOneShot({
      model: { provider: profile.id, modelId: "fixture" },
      credentialProfileId: profile.id,
      thinkingLevel: "off",
      systemPrompt: "Fixture",
      prompt: "Fixture prompt",
      timeoutMs: 20_000,
      timeoutMessage: "The fixture timed out.",
    });
    assert.equal(result.text, "leased answer");
    // Forwarded by the gateway with the pushed key; discovery is apart.
    assert.deepEqual(
      endpoint.seen
        .filter((seen) => seen.method === "POST")
        .map((seen) => [seen.url, seen.authorization]),
      [["/v1/chat/completions", `Bearer ${COMPAT_KEY_A}`]],
    );
    assert.equal(link.gateway!.stats.forwarded, 1);

    await assert.rejects(
      openEngineChannel(
        {
          request: () => Promise.reject(new Error("fixture: no Worker")),
          ended: new Promise(() => {}),
        } as never,
        "pi",
        {},
        () => {
          throw new Error("the fixture Worker never opens");
        },
        { profileId: profile.id, sessionId: "leased-engine" },
      ),
      { message: "fixture: no Worker" },
    );
    const records = link.gateway!.leases.records();
    const server = records.find((record) => record.kind === "server");
    assert.equal(server?.profileId, profile.id);
    assert.equal(server?.provider, "openai-compatible");
    assert.equal(server?.revoked, undefined);
    const engine = records.find((record) => record.kind === "engine");
    assert.equal(engine?.profileId, profile.id);
    assert.equal(engine?.provider, "openai-compatible");
    // The failed open ended its lease.
    assert.equal(engine?.revoked, "session-ended");
    for (const line of lines)
      assert.ok(!line.includes(COMPAT_KEY_A), `a log line leaks: ${line}`);
  } finally {
    await link.close();
    deleteCredentialProfile(profile.id);
    await endpoint.close();
  }
});
