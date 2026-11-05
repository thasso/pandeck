import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, test } from "vitest";

const home = mkdtempSync(join(tmpdir(), "compatible-gateway-callers-"));
process.env.HOME = home;
const { createCredentialProfile } = await import("./credentialProfiles.ts");
const { readOpenAiCompatibleEndpoint, writeOpenAiCompatibleEndpoint } =
  await import("./openAiCompatibleAccounts.ts");
const {
  startGatewayLink,
  GatewayAccountKindUnsupportedError,
  GATEWAY_ACCOUNT_KIND_UNSUPPORTED_TEXT,
} = await import("./gatewayLink.ts");
const { runOneShot } = await import("./harnesses/oneShot.ts");
const { openEngineChannel } = await import("./workers/engineClient.ts");

afterAll(() => rmSync(home, { recursive: true, force: true }));

test("gateway-on actual helper and engine open refuse endpoint accounts before any lease, control request or Worker attachment", async () => {
  const profile = createCredentialProfile({
    provider: "openai-compatible",
    name: "Refused endpoint",
  });
  writeOpenAiCompatibleEndpoint(profile.id, {
    ...readOpenAiCompatibleEndpoint(profile.id),
    baseUrl: "http://127.0.0.1:9/v1",
    models: [
      {
        id: "fixture",
        name: "Fixture",
        input: ["text"],
        reasoning: false,
        contextWindow: 32000,
        maxTokens: 4000,
      },
    ],
  });
  const lines: string[] = [];
  const link = startGatewayLink({
    stateDir: join(home, "gateway"),
    port: 0,
    log: (line) => lines.push(line),
    upstreams: { "openai-codex": { connect: { host: "127.0.0.1", port: 9 } } },
    claudeTokenEndpoint: { connect: { host: "127.0.0.1", port: 9 } },
  });
  try {
    assert.equal(await link.ready, true);
    const controlRequests = lines.filter((line) =>
      line.includes("control.request"),
    ).length;
    await assert.rejects(
      runOneShot({
        model: { provider: profile.id, modelId: "fixture" },
        credentialProfileId: profile.id,
        thinkingLevel: "off",
        systemPrompt: "Fixture",
        prompt: "Must refuse before execution",
        timeoutMs: 1000,
        timeoutMessage: "Unexpected execution",
      }),
      { message: GATEWAY_ACCOUNT_KIND_UNSUPPORTED_TEXT },
    );
    await assert.rejects(
      openEngineChannel(
        {} as never,
        "pi",
        {},
        () => {
          throw new Error("Must refuse before attaching a Worker engine");
        },
        { profileId: profile.id, sessionId: "refused-engine" },
      ),
      GatewayAccountKindUnsupportedError,
    );
    assert.equal(link.gateway!.leases.records().length, 0);
    assert.equal(
      lines.filter((line) => line.includes("control.request")).length,
      controlRequests,
    );
    assert.equal(
      lines.some((line) => line.includes("lease.granted")),
      false,
    );
  } finally {
    await link.close();
  }
});
