/**
 * The pi factory with and without the open's gateway access
 * (`docs/workers.md` "pi engines use the lease"): without it, the server's
 * own port runs the engine exactly as before; with it, the engine's gateway
 * port resolves every model, a reopened transcript's included, turns are
 * pinned to SSE, the port's feed subscription ends with the engine, and
 * nothing the engine side reads from the feed holds the compatible key.
 *
 * Real pi sessions; nothing here sends a prompt, so no request leaves the
 * process.
 *
 * Run: pnpm --filter @assistant/server test src/piSdk/piEngineHostedGateway.test.ts
 */
import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, afterEach, test, vi } from "vitest";
import type { HostedEngineHost } from "../workerProtocol/engineMethods.ts";

const tmp = mkdtempSync(join(tmpdir(), "pi-hosted-gateway-"));
process.env.ASSISTANT_CWD = tmp;
process.env.DATA_DIR = join(tmp, "data");
mkdirSync(join(tmp, "data", "settings"), { recursive: true });

/** The compatible settings as a settings write leaves them. */
function writeCompatSettings(baseUrl: string, apiKey: string): void {
  writeFileSync(
    join(tmp, "data", "settings", "openai-compatible.json"),
    JSON.stringify({
      enabled: true,
      name: "Fixture",
      baseUrl,
      apiKey,
      models: [
        {
          id: "chosen",
          name: "chosen",
          input: ["text"],
          contextWindow: 100_000,
          maxTokens: 4_000,
          reasoning: false,
        },
      ],
    }),
  );
}
writeCompatSettings("http://127.0.0.1:9/v1", "fixture");

await import("../hub.ts");
const { ModelRuntime } = await import("@earendil-works/pi-coding-agent");
const { sessionStore } = await import("../db/sessionStore.ts");
const { createPiHostedEngineFactory, hostedPiEngine } =
  await import("./piEngineHosted.ts");
const { nativePiSessionForTests } = await import("./piEngine.ts");
const { serverPiModelPort } = await import("./piModelPort.ts");
const { compatProviderFeed, notifyCompatProviderChanged } =
  await import("./compatProviderFeed.ts");
const { COMPAT_KEY_A, COMPAT_KEY_B, COMPAT_KEY_C } =
  await import("../test/gatewayFixtures.ts");
type CompatProviderFeed = import("./gatewayPiModelPort.ts").CompatProviderFeed;
const { piPersonaOptions } = await import("./piEngineStart.ts");
const { SKILLS_RUNTIME_DIR } = await import("../config.ts");
const { skillSetHash } = await import("../skills/skillRuntimeMaterializer.ts");
const { currentIntegrationToolGates } = await import("../tools/toolPolicy.ts");
const { canonicalPiSessionPath } = await import("../sessionStorage.ts");
const { childProcessEnv } = await import("../subprocessEnv.ts");
const {
  inProcessBackgroundWorkForTests,
  materializeSkillsThroughWorker,
  persistSessionOutput,
} = await import("../workers/inProcessWorker.ts");

afterEach(() => vi.restoreAllMocks());
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const GATEWAY = "http://127.0.0.1:9";
const CODEX_BASE = `${GATEWAY}/chatgpt/backend-api`;
const segment = (value: unknown) =>
  Buffer.from(JSON.stringify(value)).toString("base64url");
// A synthetic lease in the gateway's JWT shape; not a credential.
const FAKE_LEASE = `${segment({ alg: "none", typ: "JWT" })}.${segment({
  "https://api.openai.com/auth": { chatgpt_account_id: "pandeck-gateway" },
})}.fake-lease-secret`;
/** A Codex id only the server's catalog has, not pi's built-in data. */
const CATALOG_ID = "gpt-catalog-only";

type ServerPort = typeof serverPiModelPort;
type Model = NonNullable<ReturnType<ServerPort["find"]>>;

/**
 * The server's port, recording each call; its catalog also has
 * {@link CATALOG_ID}, as a profile's `models-store.json` would.
 */
function recordingServerPort(): ServerPort & { calls: string[] } {
  const calls: string[] = [];
  const catalog = (provider: string, id: string): Model | undefined => {
    if (provider !== "openai-codex" || id !== CATALOG_ID) return undefined;
    const builtin = serverPiModelPort.find("openai-codex", "gpt-5.6-luna");
    assert.ok(builtin, "pi's built-in Codex catalog has gpt-5.6-luna");
    return { ...builtin, id: CATALOG_ID, name: CATALOG_ID };
  };
  return {
    calls,
    runtime(profileId) {
      calls.push(`runtime ${profileId}`);
      return serverPiModelPort.runtime(profileId);
    },
    async findForProfile(profileId, provider, id) {
      calls.push(`findForProfile ${provider}/${id}`);
      return (
        catalog(provider, id) ??
        serverPiModelPort.findForProfile(profileId, provider, id)
      );
    },
    find(provider, id) {
      calls.push(`find ${provider}/${id}`);
      return catalog(provider, id) ?? serverPiModelPort.find(provider, id);
    },
  };
}

/** Counts the feed's live subscriptions. */
function watchFeed(): { live: () => number; subscribed: () => number } {
  let live = 0;
  let subscribed = 0;
  const subscribe = compatProviderFeed.subscribe.bind(compatProviderFeed);
  vi.spyOn(compatProviderFeed, "subscribe").mockImplementation((listener) => {
    live += 1;
    subscribed += 1;
    const unsubscribe = subscribe(listener);
    return () => {
      live -= 1;
      unsubscribe();
    };
  });
  return { live: () => live, subscribed: () => subscribed };
}

let engineIds = 0;

function host(gateway: boolean): HostedEngineHost {
  engineIds += 1;
  return {
    engineId: 9000 + engineIds,
    ...(gateway
      ? { gateway: { baseUrl: GATEWAY, leaseToken: FAKE_LEASE } }
      : {}),
    childEnv: childProcessEnv,
    callAppTool: () => Promise.reject(new Error("no app tools here")),
    sessionHooks: {} as HostedEngineHost["sessionHooks"],
    persistOutput: persistSessionOutput,
    backgroundWork: inProcessBackgroundWorkForTests(),
    materializeSkills: materializeSkillsThroughWorker,
  } as HostedEngineHost;
}

const conditions = {
  attachments: false,
  slack: false,
  google: false,
  tempo: false,
  knowledgeBase: false,
  projectRegistryPointer: false,
  memoryWrite: false,
};

function agentOn(model: string) {
  return {
    name: "gateway-agent",
    blob: "3".repeat(40),
    persona: "developer" as const,
    provider: "openai-codex",
    model,
    effort: "low" as const,
    runtimeSource: "definition" as const,
    denyTools: [],
    skills: [],
    body: "Run on the catalog model.",
  };
}

function spec(
  transcript: Record<string, unknown>,
  extra: { agent?: ReturnType<typeof agentOn>; model?: object } = {},
) {
  return {
    kind: "developer",
    credentialProfileId: "default",
    transcript,
    start: {
      conditions,
      skillNames: [],
      ...(extra.agent ? { agent: extra.agent } : {}),
    },
    skillsDir: join(SKILLS_RUNTIME_DIR, skillSetHash([]), "skills"),
    persona: piPersonaOptions("developer", "default", conditions, extra.agent),
    integrationGates: currentIntegrationToolGates(),
    mode: "build",
    ...(extra.model ? { model: extra.model } : {}),
  };
}

/**
 * A persisted transcript whose branch selected `provider/modelId`, with one
 * user turn and one reply, and its thinking level already recorded.
 */
function transcript(id: string, provider: string, modelId: string): string {
  const file = canonicalPiSessionPath(id);
  mkdirSync(dirname(file), { recursive: true });
  const at = new Date().toISOString();
  const message = (
    entryId: string,
    parentId: string,
    body: Record<string, unknown>,
  ) => ({
    type: "message",
    id: entryId,
    parentId,
    timestamp: at,
    message: { ...body, timestamp: Date.now() },
  });
  writeFileSync(
    file,
    [
      { type: "session", version: 3, id, timestamp: at, cwd: tmp },
      {
        type: "model_change",
        id: `${id}-model`,
        parentId: null,
        timestamp: at,
        provider,
        modelId,
      },
      {
        type: "thinking_level_change",
        id: `${id}-thinking`,
        parentId: `${id}-model`,
        timestamp: at,
        thinkingLevel: "low",
      },
      message(`${id}-user`, `${id}-thinking`, { role: "user", content: "hi" }),
      message(`${id}-reply`, `${id}-user`, {
        role: "assistant",
        content: [{ type: "text", text: "hello" }],
        api: "openai-codex-responses",
        provider,
        model: modelId,
        usage: {
          input: 1,
          output: 1,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 2,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "stop",
      }),
    ]
      .map((entry) => JSON.stringify(entry))
      .join("\n") + "\n",
  );
  sessionStore.upsert({ id, harness: "pi", agentType: "developer" });
  return file;
}

async function open(
  factory: ReturnType<typeof createPiHostedEngineFactory>,
  openSpec: ReturnType<typeof spec>,
  gateway: boolean,
) {
  const engineHost = host(gateway);
  const hosted = await factory(openSpec, engineHost);
  const local = hostedPiEngine(engineHost.engineId);
  assert.ok(local, "the engine is hosted");
  return { hosted, native: nativePiSessionForTests(local) };
}

test("without gateway access the server's port runs the engine as before: its runtime, its find, pi's transport, no feed", async () => {
  const feed = watchFeed();
  const server = recordingServerPort();
  const factory = createPiHostedEngineFactory({
    models: server,
    compat: compatProviderFeed,
  });
  const { hosted, native } = await open(
    factory,
    spec(
      { type: "new", cwd: tmp },
      { model: { provider: "openai-compatible", id: "chosen" } },
    ),
    false,
  );
  try {
    assert.ok(server.calls.includes("runtime default"), server.calls.join());
    assert.equal(
      native.modelRuntime,
      await serverPiModelPort.runtime("default"),
    );
    // The server's runtime keeps its own origin guard
    // (`serverCredentialPairing.ts`), whatever the switch; no lease guard.
    assert.notEqual(
      native.modelRuntime.getAuth,
      ModelRuntime.prototype.getAuth,
    );
    assert.equal(native.agent.transport, "auto");
    await hosted.command(
      "setModel",
      [{ provider: "openai-compatible", id: "chosen" }],
      1,
    );
    assert.ok(server.calls.includes("find openai-compatible/chosen"));
    assert.equal(feed.subscribed(), 0);
  } finally {
    await hosted.dispose({});
  }
});

test("a gateway engine reopens a catalog-id transcript on that model, rebased, with no new entry, pinned to SSE, and setModel resolves through its port", async () => {
  const feed = watchFeed();
  const server = recordingServerPort();
  const factory = createPiHostedEngineFactory({
    models: server,
    compat: compatProviderFeed,
  });
  const file = transcript("gateway-reopen", "openai-codex", CATALOG_ID);
  const before = readFileSync(file, "utf8");
  const { hosted, native } = await open(
    factory,
    spec({ type: "open", file, expectedId: "gateway-reopen" }),
    true,
  );
  try {
    assert.equal(native.model?.id, CATALOG_ID);
    assert.equal(native.model?.baseUrl, CODEX_BASE);
    assert.equal(native.thinkingLevel, "low");
    assert.equal(readFileSync(file, "utf8"), before, "no entry was added");
    assert.ok(
      server.calls.includes(`findForProfile openai-codex/${CATALOG_ID}`),
    );
    assert.ok(!server.calls.some((call) => call.startsWith("runtime")));
    // The engine's own runtime, guarded, holding only the lease.
    assert.notEqual(
      native.modelRuntime,
      await serverPiModelPort.runtime("default"),
    );
    assert.notEqual(
      native.modelRuntime.getAuth,
      ModelRuntime.prototype.getAuth,
    );
    assert.equal(
      (await native.modelRuntime.getAuth(native.model!))?.auth.apiKey,
      FAKE_LEASE,
    );
    assert.equal(native.agent.transport, "sse");
    assert.equal(feed.live(), 1);

    await hosted.command(
      "setModel",
      [{ provider: "openai-codex", id: "gpt-5.6-sol" }],
      1,
    );
    assert.ok(server.calls.includes("find openai-codex/gpt-5.6-sol"));
    assert.equal(native.model?.id, "gpt-5.6-sol");
    assert.equal(native.model?.baseUrl, CODEX_BASE);
    await hosted.command(
      "setModel",
      [{ provider: "openai-compatible", id: "chosen" }],
      2,
    );
    // On the gateway's /compat, with the lease (G3b-2).
    assert.equal(native.model?.baseUrl, `${GATEWAY}/compat/v1`);
    assert.equal(
      (await native.modelRuntime.getAuth(native.model!))?.auth.apiKey,
      FAKE_LEASE,
    );
    assert.equal(native.agent.transport, "sse");
  } finally {
    await hosted.dispose({});
  }
  assert.equal(feed.live(), 0, "disposing the engine ends its subscription");
});

test("a gateway agent session with messages restores its catalog model through the port and is not refused", async () => {
  const factory = createPiHostedEngineFactory({
    models: recordingServerPort(),
    compat: compatProviderFeed,
  });
  const file = transcript("gateway-agent", "openai-codex", CATALOG_ID);
  const { hosted, native } = await open(
    factory,
    spec(
      { type: "open", file, expectedId: "gateway-agent" },
      { agent: agentOn(CATALOG_ID) },
    ),
    true,
  );
  try {
    assert.equal(native.model?.id, CATALOG_ID);
    assert.equal(native.model?.baseUrl, CODEX_BASE);
  } finally {
    await hosted.dispose({});
  }
});

test("when the port has no model for the restored id, pi's own restore runs: an agent still refuses the fallback, and the port is released", async () => {
  const feed = watchFeed();
  const factory = createPiHostedEngineFactory({
    models: recordingServerPort(),
    compat: compatProviderFeed,
  });
  const file = transcript("gateway-gone", "openai-codex", "gpt-gone");
  await assert.rejects(
    open(
      factory,
      spec(
        { type: "open", file, expectedId: "gateway-gone" },
        { agent: agentOn("gpt-gone") },
      ),
      true,
    ),
    /Agent "gateway-agent" cannot run: Could not restore model openai-codex\/gpt-gone/,
  );
  assert.equal(feed.subscribed(), 1);
  assert.equal(feed.live(), 0, "a failed open releases its port");

  // Without an agent, pi falls back as it does today, on the engine's runtime.
  const { hosted, native } = await open(
    factory,
    spec({ type: "open", file, expectedId: "gateway-gone" }),
    true,
  );
  try {
    assert.notEqual(native.model?.id, "gpt-gone");
    if (native.model?.provider === "openai-codex")
      assert.equal(native.model.baseUrl, CODEX_BASE);
  } finally {
    await hosted.dispose({});
  }
});

test("AC22: across a leased open, a key rotation and an endpoint change, nothing the factory or port reads from the feed holds the key", async () => {
  writeCompatSettings("http://127.0.0.1:9/v1", COMPAT_KEY_A);
  const read: unknown[] = [];
  const recording: CompatProviderFeed = {
    current() {
      const value = compatProviderFeed.current();
      read.push(value);
      return value;
    },
    subscribe: (listener) => compatProviderFeed.subscribe(listener),
  };
  const factory = createPiHostedEngineFactory({
    models: recordingServerPort(),
    compat: recording,
  });
  const { hosted, native } = await open(
    factory,
    spec(
      { type: "new", cwd: tmp },
      { model: { provider: "openai-compatible", id: "chosen" } },
    ),
    true,
  );
  try {
    assert.equal(native.model?.baseUrl, `${GATEWAY}/compat/v1`);
    writeCompatSettings("http://127.0.0.1:9/v1", COMPAT_KEY_B);
    notifyCompatProviderChanged();
    // Same base path, new origin and key: the held model follows.
    writeCompatSettings("http://127.0.0.2:9/v1", COMPAT_KEY_C);
    notifyCompatProviderChanged();
    assert.equal(
      (await native.modelRuntime.getAuth(native.model!))?.auth.apiKey,
      FAKE_LEASE,
    );
    assert.ok(read.length >= 3, `the feed was read ${read.length} times`);
    const text = JSON.stringify(read);
    for (const key of [COMPAT_KEY_A, COMPAT_KEY_B, COMPAT_KEY_C])
      assert.ok(!text.includes(key), `the engine side read ${key}`);
  } finally {
    await hosted.dispose({});
    writeCompatSettings("http://127.0.0.1:9/v1", "fixture");
  }
});
