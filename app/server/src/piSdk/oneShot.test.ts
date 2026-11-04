import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, test, vi } from "vitest";
import { OPENAI_COMPATIBLE_PROVIDER_ID } from "@assistant/shared";
import {
  createCredentialProfile,
  deleteCredentialProfile,
  piAgentDir,
} from "../credentialProfiles.ts";
import {
  COMPAT_KEY_A,
  COMPAT_KEY_B,
  fakeCodexStream,
  startEgressObserver,
  startFakeCompatEndpoint,
  startFakeUpstreams,
  startPassThrough,
  type EgressObserver,
  type FakeUpstreams,
  type PassThrough,
  type UpstreamResponder,
} from "../test/gatewayFixtures.ts";
import {
  startGatewayLinkForTests,
  type TestGatewayLink,
} from "../test/gatewayLink.ts";
import type { EngineCompatConfig } from "./gatewayPiModelPort.ts";
import {
  piIncompleteStop,
  PiGatewayModelUnavailableError,
  runPiOneShot,
  type PiRegistryModel,
} from "./oneShot.ts";

/** What the one-shot made: its sessions and ports, observed through the real ones. */
const made = vi.hoisted(() => ({
  sessions: [] as {
    options: { modelRuntime?: unknown; model?: { baseUrl?: string } };
    session: { agent: { transport: string } };
  }[],
  ports: [] as { runtime: Promise<unknown>; disposed: number }[],
  compat: {
    config: undefined as unknown,
    listeners: new Set<() => void>(),
  },
}));

vi.mock("@earendil-works/pi-coding-agent", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@earendil-works/pi-coding-agent")>();
  return {
    ...actual,
    createAgentSession: async (
      options: Parameters<typeof actual.createAgentSession>[0],
    ) => {
      const created = await actual.createAgentSession(options);
      made.sessions.push({
        options: options as never,
        session: created.session as never,
      });
      return created;
    },
  };
});
vi.mock("./gatewayPiModelPort.ts", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("./gatewayPiModelPort.ts")>();
  return {
    ...actual,
    gatewayPiModelPort: (
      ...args: Parameters<typeof actual.gatewayPiModelPort>
    ) => {
      const port = actual.gatewayPiModelPort(...args);
      const record = { runtime: port.runtime("any"), disposed: 0 };
      made.ports.push(record);
      return {
        ...port,
        routing: port.routing,
        dispose() {
          record.disposed += 1;
          port.dispose();
        },
      };
    },
  };
});
// The server's key-less settings feed, driven by the test.
vi.mock("./compatProviderFeed.ts", () => ({
  compatProviderFeed: {
    current: () => made.compat.config,
    subscribe(listener: () => void) {
      made.compat.listeners.add(listener);
      return () => made.compat.listeners.delete(listener);
    },
  },
}));

test("a pi turn that did not end with a complete answer is reported", () => {
  // The output limit cuts the answer off: keeping the text as whole would
  // keep a truncated answer.
  assert.equal(piIncompleteStop("length"), "length");
  assert.equal(piIncompleteStop("error"), "error");
  assert.equal(piIncompleteStop("aborted"), "aborted");
  assert.equal(piIncompleteStop("stop"), undefined);
  assert.equal(piIncompleteStop("toolUse"), undefined);
  assert.equal(piIncompleteStop(undefined), undefined);
});

// Synthetic fixture values; none is a real credential.
const FAKE_ACCESS = "fake-codex-access";
const FAKE_ACCOUNT = "acct-one-shot";
/** In pi's built-in Codex catalog, so the gateway port serves it. */
const CODEX_MODEL_ID = "gpt-5.6-luna";

let upstreams: FakeUpstreams;
let respond: UpstreamResponder = fakeCodexStream("leased answer");
let compatSource: {
  value: { baseUrl: string; apiKey: string } | undefined;
  listeners: Set<() => void>;
};
let gateway: TestGatewayLink;
let front: PassThrough;
let egress: EgressObserver;
let profileId: string;

beforeAll(async () => {
  upstreams = await startFakeUpstreams({
    codex: (seen, res) => respond(seen, res),
  });
  compatSource = { value: undefined, listeners: new Set() };
  gateway = await startGatewayLinkForTests({
    upstreams: upstreams.overrides,
    compat: {
      current: () => compatSource.value,
      subscribe(listener) {
        compatSource.listeners.add(listener);
        return () => compatSource.listeners.delete(listener);
      },
    },
  });
  front = await startPassThrough(gateway.link.gateway!.url);
  profileId = createCredentialProfile({
    provider: "openai-codex",
    name: "One-shot lease",
  }).id;
  writeFileSync(
    join(piAgentDir(profileId), "auth.json"),
    JSON.stringify({
      "openai-codex": {
        type: "oauth",
        access: FAKE_ACCESS,
        refresh: "fake-refresh",
        expires: Date.now() + 86_400_000,
        accountId: FAKE_ACCOUNT,
      },
    }),
  );
  await settled();
  egress = startEgressObserver([
    `127.0.0.1:${new URL(front.url).port}`,
    `127.0.0.1:${gateway.link.gateway!.port}`,
  ]);
});

afterEach(() => {
  made.sessions.length = 0;
  made.ports.length = 0;
  front.seen.length = 0;
  upstreams.reset();
  respond = fakeCodexStream("leased answer");
  assert.deepEqual(egress.unauthorized(), [], "nothing left for elsewhere");
});

afterAll(async () => {
  egress.close();
  deleteCredentialProfile(profileId);
  await front.close();
  await gateway.close();
  await upstreams.close();
});

/** A request made after a push or registry sync is answered after it: requests take one queue. */
async function settled(): Promise<void> {
  await gateway.link.revokeLease("0".repeat(22), "session-ended");
}

/** A Codex model as the server's catalog answers it: at chatgpt.com. */
function catalogModel(provider: string, id: string): PiRegistryModel {
  return {
    id,
    name: id,
    api: "openai-codex-responses",
    provider,
    baseUrl: "https://chatgpt.com/backend-api",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200_000,
    maxTokens: 32_000,
  } as PiRegistryModel;
}

async function leasedRun(
  model: PiRegistryModel,
  timeoutMs = 20_000,
): Promise<Awaited<ReturnType<typeof runPiOneShot>>> {
  const access = await gateway.link.serverAccess(profileId);
  return runPiOneShot({
    model,
    credentialProfileId: profileId,
    thinkingLevel: "off",
    systemPrompt: "system",
    prompt: "prompt",
    timeoutMs,
    timeoutMessage: "The fixture timed out.",
    gateway: { baseUrl: front.url, leaseToken: access.leaseToken },
  });
}

test("AC10: a leased Codex one-shot runs on the port's runtime, rebased onto the gateway over SSE, and the port is disposed", async () => {
  const lease = (await gateway.link.serverAccess(profileId)).leaseToken;
  const result = await leasedRun(catalogModel("openai-codex", CODEX_MODEL_ID));
  assert.equal(result.text, "leased answer");
  assert.equal(result.stopReason, undefined);

  assert.equal(made.ports.length, 1);
  assert.equal(made.ports[0]!.disposed, 1);
  assert.equal(made.sessions.length, 1);
  const { options, session } = made.sessions[0]!;
  assert.equal(options.modelRuntime, await made.ports[0]!.runtime);
  assert.equal(options.model?.baseUrl, `${front.url}/chatgpt/backend-api`);
  assert.equal(session.agent.transport, "sse");

  // pi sent the lease to the gateway, and only the gateway the real token.
  assert.deepEqual(
    front.seen.map((seen) => [seen.method, seen.url]),
    [["POST", "/chatgpt/backend-api/codex/responses"]],
  );
  assert.equal(front.seen[0]!.headers.authorization, `Bearer ${lease}`);
  for (const seen of front.seen) {
    const sent = JSON.stringify(seen.headers) + seen.body;
    assert.ok(!sent.includes(FAKE_ACCESS));
  }
  assert.equal(upstreams.chatgpt.length, 1);
  assert.equal(
    upstreams.chatgpt[0]!.headers.authorization,
    `Bearer ${FAKE_ACCESS}`,
  );
  assert.equal(
    upstreams.chatgpt[0]!.headers["chatgpt-account-id"],
    FAKE_ACCOUNT,
  );
});

test("AC10: the port is disposed after a failed and a timed-out run", async () => {
  respond = (_seen, res) => {
    res.writeHead(500, { "content-type": "application/json" });
    res.end('{"error":{"message":"fixture failure"}}');
  };
  const failed = await leasedRun(catalogModel("openai-codex", CODEX_MODEL_ID));
  assert.equal(failed.stopReason, "error");
  assert.deepEqual(
    made.ports.map((port) => port.disposed),
    [1],
  );

  respond = () => {};
  await assert.rejects(
    leasedRun(catalogModel("openai-codex", CODEX_MODEL_ID), 300),
    { message: "The fixture timed out." },
  );
  assert.deepEqual(
    made.ports.map((port) => port.disposed),
    [1, 1],
  );
});

test("AC10: a provider the port does not serve fails before any session, and the port is disposed", async () => {
  await assert.rejects(
    leasedRun(catalogModel("anthropic", "claude-sonnet-4-5")),
    PiGatewayModelUnavailableError,
  );
  assert.equal(made.sessions.length, 0);
  assert.deepEqual(
    made.ports.map((port) => port.disposed),
    [1],
  );
  assert.equal(front.seen.length, 0);
});

/** The settings change both halves see: the feed key-less, the push with its key. */
function setCompat(baseUrl: string, apiKey: string): void {
  made.compat.config = {
    name: "Fixture",
    baseUrl,
    api: "openai-completions",
    models: [
      {
        id: "m",
        name: "m",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 100_000,
        maxTokens: 4_000,
      },
    ],
  } satisfies EngineCompatConfig;
  for (const listener of [...made.compat.listeners]) listener();
  compatSource.value = { baseUrl, apiKey };
  for (const listener of [...compatSource.listeners]) listener();
}

test("AC12: an OpenAI-compatible one-shot spends the pushed key at /compat, and follows a settings change", async () => {
  const first = await startFakeCompatEndpoint(["m"], "first answer");
  const second = await startFakeCompatEndpoint(["m"], "second answer");
  egress.allow(`127.0.0.1:${new URL(first.baseUrl).port}`);
  egress.allow(`127.0.0.1:${new URL(second.baseUrl).port}`);
  try {
    const lease = (await gateway.link.serverAccess(profileId)).leaseToken;
    const model = {
      ...catalogModel(OPENAI_COMPATIBLE_PROVIDER_ID, "m"),
      api: "openai-completions",
      baseUrl: first.baseUrl,
    } as PiRegistryModel;
    setCompat(first.baseUrl, COMPAT_KEY_A);
    await settled();
    assert.equal((await leasedRun(model)).text, "first answer");
    assert.deepEqual(
      first.seen.map((seen) => [seen.url, seen.authorization]),
      [["/v1/chat/completions", `Bearer ${COMPAT_KEY_A}`]],
    );
    assert.deepEqual(
      front.seen.map((seen) => [seen.url, seen.headers.authorization]),
      [["/compat/v1/chat/completions", `Bearer ${lease}`]],
    );

    // Same base path, another origin and key: the next one-shot follows.
    setCompat(second.baseUrl, COMPAT_KEY_B);
    await settled();
    assert.equal((await leasedRun(model)).text, "second answer");
    assert.equal(first.seen.length, 1);
    assert.deepEqual(
      second.seen.map((seen) => [seen.url, seen.authorization]),
      [["/v1/chat/completions", `Bearer ${COMPAT_KEY_B}`]],
    );
    for (const endpoint of [first, second])
      for (const seen of endpoint.seen)
        assert.ok(!seen.authorization?.includes(lease));
  } finally {
    made.compat.config = undefined;
    compatSource.value = undefined;
    await first.close();
    await second.close();
  }
});
