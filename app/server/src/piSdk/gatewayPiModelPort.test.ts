/**
 * A leased pi engine's model port (`gatewayPiModelPort.ts`): it serves only
 * the account its lease is for (T1373 AC10). An OpenAI account's port hands
 * out Codex models on the gateway that authenticate with the lease, and never
 * reads the compatible feed. An OpenAI-compatible account's port registers
 * only that account's provider, following its key-less feed onto the
 * gateway's `/compat` with the lease; a URL only control refuses still
 * registers, a structurally refused one registers nothing (AC16). The
 * runtime's auth is guarded per request, so the lease is never paired with
 * another `baseUrl`. Nothing here leaves the process: every request pi would
 * send goes to a recording `fetch`, and the egress observer sees none.
 *
 * Run: pnpm --filter @assistant/server test src/piSdk/gatewayPiModelPort.test.ts
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, test, vi } from "vitest";
import { ModelRegistry } from "@earendil-works/pi-coding-agent";
import {
  COMPAT_KEY_A,
  startEgressObserver,
  type EgressObserver,
} from "../test/gatewayFixtures.ts";
import type { PiEngineModel } from "./piEngine.ts";
import type { PiModelPort } from "./piEngineHost.ts";
import {
  gatewayPiModelPort,
  type CompatProviderFeed,
  type EngineCompatConfig,
} from "./gatewayPiModelPort.ts";

const GATEWAY = "http://127.0.0.1:9";
const CODEX_BASE = `${GATEWAY}/chatgpt/backend-api`;
const CHATGPT_BASE = "https://chatgpt.com/backend-api";
const segment = (value: unknown) =>
  Buffer.from(JSON.stringify(value)).toString("base64url");
// A synthetic lease in the gateway's JWT shape; not a credential.
const FAKE_LEASE = `${segment({ alg: "none", typ: "JWT" })}.${segment({
  "https://api.openai.com/auth": { chatgpt_account_id: "pandeck-gateway" },
})}.fake-lease-secret`;
const ACCESS = { baseUrl: GATEWAY, leaseToken: FAKE_LEASE };
/** An id pi's built-in catalog does not have; the server's catalog does. */
const CATALOG_ID = "gpt-catalog-only";
const BUILTIN_ID = "gpt-5.6-luna";
const COMPAT_A = "http://127.0.0.1:7/v1";
const COMPAT_B = "http://127.0.0.1:8/v1";
const COMPAT_OTHER_PATH = "http://127.0.0.1:8/api/openai/v1/";
/** The OpenAI account a Codex port is for. */
const OWN = "named";
/** Two OpenAI-compatible accounts' ids, which are their providers'. */
const COMPAT_ID_A = "openai-compatible-aaaaaaaaaaaa";
const COMPAT_ID_B = "openai-compatible-bbbbbbbbbbbb";

const root = mkdtempSync(join(tmpdir(), "gateway-port-"));
const watched = ["home", "agent", "data"].map((dir) => join(root, dir));
let egress: EgressObserver;

beforeAll(() => {
  for (const dir of watched) mkdirSync(dir);
  vi.stubEnv("HOME", watched[0]!);
  vi.stubEnv("PI_CODING_AGENT_DIR", watched[1]!);
  vi.stubEnv("DATA_DIR", watched[2]!);
  egress = startEgressObserver([]);
});

afterEach(() => {
  vi.restoreAllMocks();
  assert.deepEqual(egress.attempts, [], "nothing left the process");
});

afterAll(() => {
  egress.close();
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

/** A Codex catalog model as the server's runtime answers it. */
function catalogModel(id: string): PiEngineModel {
  return {
    id,
    name: id,
    api: "openai-codex-responses",
    provider: "openai-codex",
    baseUrl: CHATGPT_BASE,
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200_000,
    maxTokens: 32_000,
  } as PiEngineModel;
}

/** The server's port as a fake: its catalog has a built-in id and one more. */
function serverPort(): PiModelPort & { calls: string[] } {
  const calls: string[] = [];
  const known = new Set([BUILTIN_ID, CATALOG_ID]);
  return {
    calls,
    runtime: () => {
      calls.push("runtime");
      return Promise.reject(new Error("the server runtime is not used"));
    },
    findForProfile: async (profileId, provider, id) => {
      calls.push(`findForProfile ${profileId} ${provider}/${id}`);
      return provider === "openai-codex" && known.has(id)
        ? catalogModel(id)
        : undefined;
    },
    availableForProfile: async () => [],
  };
}

/** A key-less compatible configuration, as the server's feed answers it. */
function compatConfig(baseUrl: string): EngineCompatConfig {
  return {
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
  };
}

/**
 * Account A's feed, driven by the test: `set` changes its config and
 * notifies. Every read and subscription is recorded by account.
 */
function fakeFeed(initial?: EngineCompatConfig) {
  let config = initial;
  const listeners = new Set<() => void>();
  const calls: string[] = [];
  const feed: CompatProviderFeed = {
    current: (id) => {
      calls.push(`current ${id}`);
      return id === COMPAT_ID_A ? config : undefined;
    },
    subscribe(id, listener) {
      calls.push(`subscribe ${id}`);
      if (id !== COMPAT_ID_A) return () => {};
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  return {
    feed,
    listeners,
    calls,
    set(next: EngineCompatConfig | undefined) {
      config = next;
      for (const listener of [...listeners]) listener();
    },
  };
}

/** Every file under the watched HOME, agent dir and DATA_DIR. */
const filesUnderWatched = () =>
  watched.flatMap((dir) =>
    readdirSync(dir, { recursive: true }).map((file) =>
      join(dir, String(file)),
    ),
  );

/** What pi would send for `model`: the request goes to a recording fetch. */
async function sendThrough(
  port: PiModelPort,
  model: PiEngineModel,
): Promise<{
  requests: { url: string; authorization: string | null }[];
  errorMessage: string | undefined;
}> {
  const requests: { url: string; authorization: string | null }[] = [];
  const recording = async (url: unknown, init?: RequestInit) => {
    requests.push({
      url: String(url),
      authorization: new Headers(init?.headers).get("authorization"),
    });
    throw new Error("recorded, not sent");
  };
  const runtime = await port.runtime("default");
  const result = await runtime
    .streamSimple(
      model,
      { messages: [{ role: "user", content: "hi", timestamp: 0 }] },
      { transport: "sse", maxRetries: 0, fetch: recording } as never,
    )
    .result();
  return { requests, errorMessage: result.errorMessage };
}

/** An OpenAI port for {@link OWN} on a fake server catalog and an untouched feed. */
function codexPort(server = serverPort(), feed = fakeFeed()) {
  return gatewayPiModelPort(ACCESS, OWN, { server, compat: feed.feed });
}

/** Account A's port, following `feed`. */
const compatPort = (feed: ReturnType<typeof fakeFeed>) =>
  gatewayPiModelPort(ACCESS, COMPAT_ID_A, {
    server: serverPort(),
    compat: feed.feed,
  });

test("every Codex model of the port's own account is on the gateway, catalog ids included; other providers, accounts and kinds are not served", async () => {
  const server = serverPort();
  const feed = fakeFeed(compatConfig(COMPAT_A));
  const register = vi.spyOn(ModelRegistry.prototype, "registerProvider");
  const port = codexPort(server, feed);
  try {
    assert.equal(port.routing, "gateway");
    for (const id of [BUILTIN_ID, CATALOG_ID]) {
      const model = await port.findForProfile(OWN, "openai-codex", id);
      assert.equal(model?.id, id);
      assert.equal(model?.baseUrl, CODEX_BASE);
      // Another account's id, even for the same provider: not this port's.
      assert.equal(
        await port.findForProfile("default", "openai-codex", id),
        undefined,
      );
    }
    // The server's catalog decides; it was asked for the profile's.
    assert.ok(
      server.calls.includes(`findForProfile ${OWN} openai-codex/${CATALOG_ID}`),
    );
    // An id the server does not know falls back to the gateway's built-in.
    server.findForProfile = async () => undefined;
    const fallback = await port.findForProfile(
      OWN,
      "openai-codex",
      "gpt-5.6-sol",
    );
    assert.equal(fallback?.baseUrl, CODEX_BASE);
    assert.equal(
      await port.findForProfile(OWN, "openai-codex", "no-such-model"),
      undefined,
    );
    assert.equal(
      await port.findForProfile(OWN, "anthropic", "claude-sonnet-4-5"),
      undefined,
    );
    // No compatible provider: the feed is never read or subscribed.
    for (const id of [COMPAT_ID_A, COMPAT_ID_B])
      assert.equal(await port.findForProfile(OWN, id, "m"), undefined);
    assert.equal(
      await port.findForProfile(COMPAT_ID_A, COMPAT_ID_A, "m"),
      undefined,
    );
    assert.deepEqual(await port.availableForProfile(OWN), []);
    assert.deepEqual(feed.calls, []);
    assert.deepEqual(
      register.mock.calls.map(([provider]) => provider),
      ["openai-codex"],
    );
    const runtime = await port.runtime("default");
    assert.equal(await runtime.getAuth(COMPAT_ID_A), undefined);
    assert.ok(
      !server.calls.includes("runtime"),
      "the server runtime is unused",
    );
  } finally {
    port.dispose();
  }
});

test("every Codex model the port returns authenticates with the lease, and creating the port writes no file", async () => {
  const before = filesUnderWatched();
  const port = codexPort();
  try {
    const runtime = await port.runtime("default");
    const models = [
      await port.findForProfile(OWN, "openai-codex", CATALOG_ID),
      await port.findForProfile(OWN, "openai-codex", BUILTIN_ID),
      await port.findForProfile(OWN, "openai-codex", "gpt-5.6-sol"),
    ];
    for (const model of models) {
      assert.ok(model);
      const auth = await runtime.getAuth(model);
      assert.equal(auth?.auth.apiKey, FAKE_LEASE);
      assert.equal(auth?.auth.baseUrl, undefined);
    }
    // pi sends it to the gateway's Codex route with the lease, nowhere else.
    const sent = await sendThrough(port, models[0]!);
    assert.deepEqual(sent.requests, [
      {
        url: `${CODEX_BASE}/codex/responses`,
        authorization: `Bearer ${FAKE_LEASE}`,
      },
    ]);
    assert.deepEqual(filesUnderWatched(), before);
  } finally {
    port.dispose();
  }
});

test("a compatible account's port registers only its own provider on the gateway's /compat with the lease, and its key never reaches the port", async () => {
  const driven = fakeFeed(compatConfig(COMPAT_A));
  const register = vi.spyOn(ModelRegistry.prototype, "registerProvider");
  const port = compatPort(driven);
  try {
    const runtime = await port.runtime("default");
    assert.deepEqual(
      register.mock.calls.map(([provider]) => provider),
      [COMPAT_ID_A],
    );
    assert.deepEqual(driven.calls, [
      `current ${COMPAT_ID_A}`,
      `subscribe ${COMPAT_ID_A}`,
    ]);
    const model = (await port.findForProfile(COMPAT_ID_A, COMPAT_ID_A, "m"))!;
    assert.equal(model.provider, COMPAT_ID_A);
    assert.equal(model.baseUrl, `${GATEWAY}/compat/v1`);
    assert.equal((await runtime.getAuth(model))?.auth.apiKey, FAKE_LEASE);
    const sent = await sendThrough(port, model);
    assert.deepEqual(sent.requests, [
      {
        url: `${GATEWAY}/compat/v1/chat/completions`,
        authorization: `Bearer ${FAKE_LEASE}`,
      },
    ]);
    assert.deepEqual(
      (await port.availableForProfile(COMPAT_ID_A)).map((m) => [
        m.provider,
        m.id,
      ]),
      [[COMPAT_ID_A, "m"]],
    );

    // Nothing of another account or kind: not Codex, not a built-in, not B.
    for (const [id, provider, modelId] of [
      [COMPAT_ID_A, "openai-codex", BUILTIN_ID],
      [COMPAT_ID_A, "anthropic", "claude-sonnet-4-5"],
      [COMPAT_ID_A, COMPAT_ID_B, "m"],
      [COMPAT_ID_B, COMPAT_ID_B, "m"],
      [COMPAT_ID_B, COMPAT_ID_A, "m"],
    ] as const)
      assert.equal(
        await port.findForProfile(id, provider, modelId),
        undefined,
        `${id} ${provider}/${modelId}`,
      );
    assert.deepEqual(await port.availableForProfile(COMPAT_ID_B), []);
    assert.equal(await runtime.getAuth(catalogModel(BUILTIN_ID)), undefined);
    assert.equal(await runtime.getAuth("openai-codex"), undefined);

    // The feed's type admits no key: the engine side cannot be handed one.
    const keyed: EngineCompatConfig = {
      ...compatConfig(COMPAT_A),
      // @ts-expect-error -- `apiKey` is `never` on the engine's config.
      apiKey: COMPAT_KEY_A,
    };
    assert.ok(keyed);
  } finally {
    port.dispose();
  }
});

test("AC16: a URL past control's 2048 bytes still registers and offers its models; a structurally refused one registers nothing", async () => {
  const longPath = `/v1/${"p".repeat(2100)}`;
  const long = fakeFeed(compatConfig(`http://127.0.0.1:7${longPath}`));
  const longPort = compatPort(long);
  try {
    const model = (await longPort.findForProfile(
      COMPAT_ID_A,
      COMPAT_ID_A,
      "m",
    ))!;
    assert.equal(model.baseUrl, `${GATEWAY}/compat${longPath}`);
    assert.equal(
      (await longPort.availableForProfile(COMPAT_ID_A)).length,
      1,
      "the failure is the gateway's 503, not a missing model",
    );
  } finally {
    longPort.dispose();
  }

  for (const refused of [
    "ftp://127.0.0.1:7/v1",
    "http://user:pw@127.0.0.1:7/v1",
    "http://127.0.0.1:7/v1?x=1",
    "http://127.0.0.1:7/v1#f",
  ]) {
    const register = vi.spyOn(ModelRegistry.prototype, "registerProvider");
    const port = compatPort(fakeFeed(compatConfig(refused)));
    try {
      await port.runtime("default");
      assert.equal(register.mock.calls.length, 0, refused);
      assert.equal(
        await port.findForProfile(COMPAT_ID_A, COMPAT_ID_A, "m"),
        undefined,
      );
      assert.deepEqual(await port.availableForProfile(COMPAT_ID_A), []);
    } finally {
      port.dispose();
      register.mockRestore();
    }
  }
});

test("the compatible registration follows the feed: unchanged and same-base-path changes keep it, a base-path change re-registers, none or an invalid URL removes it, dispose unsubscribes", async () => {
  const driven = fakeFeed(compatConfig(COMPAT_A));
  const port = compatPort(driven);
  const runtime = await port.runtime("default");
  const register = vi.spyOn(ModelRegistry.prototype, "registerProvider");
  const unregister = vi.spyOn(ModelRegistry.prototype, "unregisterProvider");
  const find = () => port.findForProfile(COMPAT_ID_A, COMPAT_ID_A, "m");

  const held = (await find())!;
  assert.equal((await runtime.getAuth(held))?.auth.apiKey, FAKE_LEASE);

  // A notification with the feed unchanged (a key rotation): nothing churns.
  driven.set(compatConfig(COMPAT_A));
  assert.equal(register.mock.calls.length, 0);
  assert.equal((await runtime.getAuth(held))?.auth.apiKey, FAKE_LEASE);

  // Another origin at the same base path: the gateway follows the push, so
  // the held model keeps its auth (RD-G3b2-4).
  driven.set(compatConfig(COMPAT_B));
  assert.equal(register.mock.calls.length, 0);
  assert.equal((await runtime.getAuth(held))?.auth.apiKey, FAKE_LEASE);

  // Another base path: re-registered; the held model gets no auth, the new
  // one does.
  driven.set(compatConfig(COMPAT_OTHER_PATH));
  assert.equal(register.mock.calls.length, 1);
  assert.equal(register.mock.calls[0]![0], COMPAT_ID_A);
  assert.equal(await runtime.getAuth(held), undefined);
  const moved = (await find())!;
  assert.equal(moved.baseUrl, `${GATEWAY}/compat/api/openai/v1`);
  assert.equal((await runtime.getAuth(moved))?.auth.apiKey, FAKE_LEASE);

  // A URL the gateway would refuse, then none: unregistered, nothing
  // authenticates.
  for (const invalid of [
    "ftp://127.0.0.1:7/v1",
    "http://user:pw@127.0.0.1:7/v1",
    "http://127.0.0.1:7/v1?x=1",
    "http://127.0.0.1:7/v1#f",
    "not a url",
  ]) {
    driven.set(compatConfig(COMPAT_A));
    driven.set(compatConfig(invalid));
    assert.equal(await find(), undefined);
    assert.equal(await runtime.getAuth(held), undefined, invalid);
  }
  driven.set(undefined);
  assert.equal(await find(), undefined);
  assert.equal(await runtime.getAuth(moved), undefined);
  const unregistered = unregister.mock.calls.length;
  driven.set(undefined);
  assert.equal(unregister.mock.calls.length, unregistered);

  assert.equal(driven.listeners.size, 1);
  port.dispose();
  port.dispose();
  assert.equal(driven.listeners.size, 0);
  const registered = register.mock.calls.length;
  driven.set(compatConfig(COMPAT_OTHER_PATH));
  assert.equal(
    register.mock.calls.length,
    registered,
    "a disposed port registers nothing",
  );
});

test("after a base-path change, a model held at the old one is refused before any request, and the new one goes to the gateway", async () => {
  const driven = fakeFeed(compatConfig(COMPAT_A));
  const port = compatPort(driven);
  try {
    const runtime = await port.runtime("default");
    const held = (await port.findForProfile(COMPAT_ID_A, COMPAT_ID_A, "m"))!;
    driven.set(compatConfig(COMPAT_OTHER_PATH));
    assert.equal(await runtime.getAuth(held), undefined);
    const stale = await sendThrough(port, held);
    assert.deepEqual(stale.requests, []);
    assert.match(
      stale.errorMessage ?? "",
      new RegExp(`Provider is not configured: ${COMPAT_ID_A}`),
    );
    const moved = (await port.findForProfile(COMPAT_ID_A, COMPAT_ID_A, "m"))!;
    const fresh = await sendThrough(port, moved);
    assert.deepEqual(
      fresh.requests.map((r) => [r.url, r.authorization]),
      [
        [
          `${GATEWAY}/compat/api/openai/v1/chat/completions`,
          `Bearer ${FAKE_LEASE}`,
        ],
      ],
    );
  } finally {
    port.dispose();
  }
});

test("a Codex model not on the gateway, such as a catalog object at chatgpt.com, gets no lease and sends nothing", async () => {
  const port = codexPort();
  try {
    const runtime = await port.runtime("default");
    for (const id of [BUILTIN_ID, CATALOG_ID]) {
      const foreign = catalogModel(id);
      assert.equal(await runtime.getAuth(foreign), undefined);
      const sent = await sendThrough(port, foreign);
      assert.deepEqual(sent.requests, []);
      assert.match(
        sent.errorMessage ?? "",
        /Provider is not configured: openai-codex/,
      );
    }
    // By provider id, auth resolves as pi resolves it.
    assert.equal(
      (await runtime.getAuth("openai-codex"))?.auth.apiKey,
      FAKE_LEASE,
    );
  } finally {
    port.dispose();
  }
});
