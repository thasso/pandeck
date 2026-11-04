/**
 * The server runtimes' credential guard (`serverCredentialPairing.ts` over
 * `credentialPairing.ts`): an OpenAI-compatible model held across a settings
 * change gets its key only while the registration's endpoint is on the
 * model's own origin. A rotation, a cleared key and a path change on the same
 * origin are followed as before; a key-less endpoint is never refused; and a
 * request already resolving its key keeps the registration it started on.
 * Nothing leaves the process: every request pi would send goes to a recording
 * `fetch`.
 *
 * Run: pnpm --filter @assistant/server test src/piSdk/credentialPairing.test.ts
 */
import assert from "node:assert/strict";
import { afterAll, afterEach, beforeAll, test } from "vitest";
import { ModelRegistry, ModelRuntime } from "@earendil-works/pi-coding-agent";
import {
  InMemoryCredentialStore,
  InMemoryModelsStore,
} from "@earendil-works/pi-ai";
import { OPENAI_COMPATIBLE_PROVIDER_ID } from "@assistant/shared";
import { OPENAI_COMPATIBLE_KEYLESS } from "../openAiCompatibleSettings.ts";
import {
  COMPAT_KEY_A,
  COMPAT_KEY_B,
  startEgressObserver,
  type EgressObserver,
} from "../test/gatewayFixtures.ts";
import type { PiEngineModel } from "./piEngine.ts";
import { guardServerRuntime } from "./serverCredentialPairing.ts";

/** Endpoint A, the same origin at another path, and B on another port. */
const A = "http://127.0.0.1:7/v1";
const A_OTHER_PATH = "http://127.0.0.1:7/api/v1";
const B = "http://127.0.0.1:8/v1";
const MODEL = "m";
/** A Codex model in pi's built-in data. */
const CODEX_MODEL = "gpt-5.6-luna";
const NOT_CONFIGURED = /Provider is not configured: openai-compatible/;

let egress: EgressObserver;

beforeAll(() => {
  egress = startEgressObserver([]);
});

afterEach(() => {
  assert.deepEqual(egress.attempts, [], "nothing left the process");
});

afterAll(() => {
  egress.close();
});

/**
 * A credential store whose reads wait at a gate while one is set: pi awaits
 * the read after it has taken the provider and its configured key.
 */
class GatedCredentialStore extends InMemoryCredentialStore {
  gate: Promise<void> | undefined;
  /** Resolves once a read is waiting at the gate. */
  waiting: Promise<void> | undefined;
  private reached: (() => void) | undefined;

  hold(): () => void {
    let release!: () => void;
    this.gate = new Promise((resolve) => (release = resolve));
    this.waiting = new Promise((resolve) => (this.reached = resolve));
    return () => {
      this.gate = undefined;
      release();
    };
  }

  override async read(
    ...args: Parameters<InMemoryCredentialStore["read"]>
  ): ReturnType<InMemoryCredentialStore["read"]> {
    const gate = this.gate;
    if (gate) {
      this.reached?.();
      await gate;
    }
    return super.read(...args);
  }
}

/** A guarded in-memory runtime, as `models.ts` guards its own. */
async function guardedRuntime(credentials = new InMemoryCredentialStore()) {
  const runtime = guardServerRuntime(
    await ModelRuntime.create({
      credentials,
      modelsStore: new InMemoryModelsStore(),
      modelsPath: null,
      refreshOnCreate: false,
    }),
  );
  return { runtime, registry: new ModelRegistry(runtime) };
}

/** The compatible provider at `baseUrl` with `apiKey`, as settings register it. */
function register(registry: ModelRegistry, baseUrl: string, apiKey: string) {
  registry.registerProvider(OPENAI_COMPATIBLE_PROVIDER_ID, {
    name: "Fixture",
    baseUrl,
    apiKey,
    api: "openai-completions",
    models: [
      {
        id: MODEL,
        name: MODEL,
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 100_000,
        maxTokens: 4_000,
      },
    ],
  });
}

function find(registry: ModelRegistry) {
  const model = registry.find(OPENAI_COMPATIBLE_PROVIDER_ID, MODEL);
  assert.ok(model, "the compatible model is registered");
  return model as PiEngineModel;
}

interface Sent {
  requests: { url: string; authorization: string | null }[];
  errorMessage: string | undefined;
}

/** Starts what pi would send for `model`; the request goes to a recording fetch. */
function startSend(runtime: ModelRuntime, model: PiEngineModel): Promise<Sent> {
  const requests: Sent["requests"] = [];
  const recording = async (url: unknown, init?: RequestInit) => {
    requests.push({
      url: String(url),
      authorization: new Headers(init?.headers).get("authorization"),
    });
    throw new Error("recorded, not sent");
  };
  return runtime
    .streamSimple(
      model,
      { messages: [{ role: "user", content: "hi", timestamp: 0 }] },
      { maxRetries: 0, fetch: recording } as never,
    )
    .result()
    .then((result) => ({ requests, errorMessage: result.errorMessage }));
}

/** The one request pi sent for `model`, as url and key. */
async function sentOnce(runtime: ModelRuntime, model: PiEngineModel) {
  const sent = await startSend(runtime, model);
  assert.equal(sent.requests.length, 1, JSON.stringify(sent));
  return sent.requests[0]!;
}

/** pi refused before it connected. */
async function assertRefused(runtime: ModelRuntime, model: PiEngineModel) {
  const sent = await startSend(runtime, model);
  assert.deepEqual(sent.requests, [], "nothing was sent");
  assert.match(sent.errorMessage ?? "", NOT_CONFIGURED);
}

test("a held model keeps its key on its own origin and is refused once the endpoint moves to another", async () => {
  const { runtime, registry } = await guardedRuntime();
  register(registry, A, COMPAT_KEY_A);
  const held = find(registry);

  // (a) Unchanged.
  assert.deepEqual(await sentOnce(runtime, held), {
    url: `${A}/chat/completions`,
    authorization: `Bearer ${COMPAT_KEY_A}`,
  });

  // (b) A rotation at the same endpoint is followed.
  register(registry, A, COMPAT_KEY_B);
  assert.deepEqual(await sentOnce(runtime, held), {
    url: `${A}/chat/completions`,
    authorization: `Bearer ${COMPAT_KEY_B}`,
  });

  // (d) A path change on the same origin keeps the key, sent to the held path.
  register(registry, A_OTHER_PATH, COMPAT_KEY_A);
  assert.deepEqual(await sentOnce(runtime, held), {
    url: `${A}/chat/completions`,
    authorization: `Bearer ${COMPAT_KEY_A}`,
  });

  // (c) Another origin: the held model is refused; one found anew reaches B.
  register(registry, B, COMPAT_KEY_B);
  await assertRefused(runtime, held);
  assert.deepEqual(await sentOnce(runtime, find(registry)), {
    url: `${B}/chat/completions`,
    authorization: `Bearer ${COMPAT_KEY_B}`,
  });
});

test("other providers and a provider-id lookup resolve as on an unguarded runtime", async () => {
  // (f) A Codex model away from its registration's origin, and a string.
  const guarded = await guardedRuntime();
  const plain = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    modelsStore: new InMemoryModelsStore(),
    modelsPath: null,
    refreshOnCreate: false,
  });
  for (const runtime of [guarded.runtime, plain]) {
    const registry = new ModelRegistry(runtime);
    registry.registerProvider("openai-codex", {
      baseUrl: A,
      apiKey: COMPAT_KEY_A,
    });
    register(registry, A, COMPAT_KEY_A);
  }
  const codex = guarded.registry.find("openai-codex", CODEX_MODEL);
  assert.ok(codex);
  const elsewhere = { ...codex, baseUrl: B } as PiEngineModel;
  const guardedAuth = await guarded.runtime.getAuth(elsewhere);
  assert.equal(guardedAuth?.auth.apiKey, COMPAT_KEY_A);
  assert.deepEqual(guardedAuth, await plain.getAuth(elsewhere));
  for (const provider of ["openai-codex", OPENAI_COMPATIBLE_PROVIDER_ID])
    assert.deepEqual(
      await guarded.runtime.getAuth(provider),
      await plain.getAuth(provider),
      provider,
    );
});

test("with no registration pi answers Unknown provider, as today", async () => {
  // (h)
  const { runtime, registry } = await guardedRuntime();
  register(registry, A, COMPAT_KEY_A);
  const held = find(registry);
  registry.unregisterProvider(OPENAI_COMPATIBLE_PROVIDER_ID);
  const sent = await startSend(runtime, held);
  assert.deepEqual(sent.requests, []);
  assert.equal(sent.errorMessage, "Unknown provider: openai-compatible");
});

test("a key-less endpoint pairs no credential: never refused, and a real key is never admitted as key-less", async () => {
  // (i) A key-less endpoint moves to another key-less origin.
  const keyless = await guardedRuntime();
  register(keyless.registry, A, OPENAI_COMPATIBLE_KEYLESS);
  const heldKeyless = find(keyless.registry);
  register(keyless.registry, B, OPENAI_COMPATIBLE_KEYLESS);
  assert.deepEqual(await sentOnce(keyless.runtime, heldKeyless), {
    url: `${A}/chat/completions`,
    authorization: "Bearer none",
  });

  // (ii) A cleared key at the same endpoint.
  const cleared = await guardedRuntime();
  register(cleared.registry, A, COMPAT_KEY_A);
  const heldCleared = find(cleared.registry);
  register(cleared.registry, A, OPENAI_COMPATIBLE_KEYLESS);
  assert.deepEqual(await sentOnce(cleared.runtime, heldCleared), {
    url: `${A}/chat/completions`,
    authorization: "Bearer none",
  });

  // (iii) From key-less at A to a real key at B: the model held at A is refused.
  const keyed = await guardedRuntime();
  register(keyed.registry, A, OPENAI_COMPATIBLE_KEYLESS);
  const heldAtA = find(keyed.registry);
  register(keyed.registry, B, COMPAT_KEY_B);
  await assertRefused(keyed.runtime, heldAtA);
});

test("a request resolving its key keeps the registration it started on, whatever lands meanwhile", async () => {
  // Each change lands while pi awaits the credential read, after it took the
  // provider and its key: the request goes to A with A's key, never refused.
  const changes: [string, string, string][] = [
    ["a rotation", A, COMPAT_KEY_B],
    ["a cleared key", A, OPENAI_COMPATIBLE_KEYLESS],
    ["a path change on the same origin", A_OTHER_PATH, COMPAT_KEY_A],
    ["another origin", B, COMPAT_KEY_B],
  ];
  for (const [change, baseUrl, apiKey] of changes) {
    const credentials = new GatedCredentialStore();
    const { runtime, registry } = await guardedRuntime(credentials);
    register(registry, A, COMPAT_KEY_A);
    const held = find(registry);
    const release = credentials.hold();
    const pending = startSend(runtime, held);
    await credentials.waiting;
    register(registry, baseUrl, apiKey);
    release();
    assert.deepEqual(
      (await pending).requests,
      [
        {
          url: `${A}/chat/completions`,
          authorization: `Bearer ${COMPAT_KEY_A}`,
        },
      ],
      change,
    );

    // The next request follows the new registration.
    if (baseUrl === B) await assertRefused(runtime, held);
    else
      assert.deepEqual(
        await sentOnce(runtime, held),
        {
          url: `${A}/chat/completions`,
          authorization: `Bearer ${apiKey}`,
        },
        change,
      );
  }
});
