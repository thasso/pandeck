/**
 * A leased pi engine's model port (`gatewayPiModelPort.ts`): every Codex
 * model it hands out is on the gateway and authenticates with the lease, the
 * OpenAI-compatible provider follows the settings feed, and the runtime's
 * auth is guarded per request, so neither credential is ever paired with
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
import { OPENAI_COMPATIBLE_PROVIDER_ID } from "@assistant/shared";
import {
  COMPAT_KEY_A,
  COMPAT_KEY_B,
  startEgressObserver,
  type EgressObserver,
} from "../test/gatewayFixtures.ts";
import type { PiEngineModel } from "./piEngine.ts";
import type { PiModelPort } from "./piEngineHost.ts";
import {
  gatewayPiModelPort,
  type CompatProviderConfig,
  type CompatProviderFeed,
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
    find: (provider, id) => {
      calls.push(`find ${provider}/${id}`);
      return provider === "openai-codex" && known.has(id)
        ? catalogModel(id)
        : undefined;
    },
  };
}

function compatConfig(baseUrl: string, apiKey: string): CompatProviderConfig {
  return {
    name: "Fixture",
    baseUrl,
    apiKey,
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

/** A feed the test drives: `set` changes the config and notifies. */
function fakeFeed(initial?: CompatProviderConfig) {
  let config = initial;
  const listeners = new Set<() => void>();
  const feed: CompatProviderFeed = {
    current: () => config,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  return {
    feed,
    listeners,
    set(next: CompatProviderConfig | undefined) {
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

test("every Codex model is on the gateway, catalog ids included; other providers are not served", async () => {
  const server = serverPort();
  const port = gatewayPiModelPort(ACCESS, {
    server,
    compat: fakeFeed().feed,
  });
  try {
    assert.equal(port.routing, "gateway");
    for (const id of [BUILTIN_ID, CATALOG_ID]) {
      const named = await port.findForProfile("named", "openai-codex", id);
      assert.equal(named?.id, id);
      assert.equal(named?.baseUrl, CODEX_BASE);
      const byDefault = port.find("openai-codex", id);
      assert.equal(byDefault?.id, id);
      assert.equal(byDefault?.baseUrl, CODEX_BASE);
    }
    // The server's catalog decides; it was asked for the profile's.
    assert.ok(
      server.calls.includes(`findForProfile named openai-codex/${CATALOG_ID}`),
    );
    // An id the server does not know falls back to the gateway's built-in.
    server.find = () => undefined;
    server.findForProfile = async () => undefined;
    const fallback = await port.findForProfile(
      "named",
      "openai-codex",
      "gpt-5.6-sol",
    );
    assert.equal(fallback?.baseUrl, CODEX_BASE);
    assert.equal(port.find("openai-codex", "gpt-5.6-sol")?.baseUrl, CODEX_BASE);
    assert.equal(
      await port.findForProfile("named", "openai-codex", "no-such-model"),
      undefined,
    );
    assert.equal(
      await port.findForProfile("named", "anthropic", "claude-sonnet-4-5"),
      undefined,
    );
    assert.equal(port.find("anthropic", "claude-sonnet-4-5"), undefined);
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
  const port = gatewayPiModelPort(ACCESS, {
    server: serverPort(),
    compat: fakeFeed().feed,
  });
  try {
    const runtime = await port.runtime("default");
    const models = [
      await port.findForProfile("named", "openai-codex", CATALOG_ID),
      await port.findForProfile("named", "openai-codex", BUILTIN_ID),
      port.find("openai-codex", CATALOG_ID),
      port.find("openai-codex", "gpt-5.6-sol"),
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

test("the compatible registration follows the feed: re-registered on a change, removed on none, unchanged skipped, unsubscribed on dispose", async () => {
  const driven = fakeFeed(compatConfig(COMPAT_A, COMPAT_KEY_A));
  const port = gatewayPiModelPort(ACCESS, {
    server: serverPort(),
    compat: driven.feed,
  });
  const runtime = await port.runtime("default");
  const register = vi.spyOn(ModelRegistry.prototype, "registerProvider");
  const unregister = vi.spyOn(ModelRegistry.prototype, "unregisterProvider");

  const atA = port.find(OPENAI_COMPATIBLE_PROVIDER_ID, "m");
  assert.equal(atA?.baseUrl, COMPAT_A);
  assert.equal((await runtime.getAuth(atA!))?.auth.apiKey, COMPAT_KEY_A);

  // The same signature again: no registration.
  driven.set(compatConfig(COMPAT_A, COMPAT_KEY_A));
  assert.equal(register.mock.calls.length, 0);

  // A key rotation on the same endpoint applies to the model already held.
  driven.set(compatConfig(COMPAT_A, COMPAT_KEY_B));
  assert.equal(register.mock.calls.length, 1);
  assert.equal((await runtime.getAuth(atA!))?.auth.apiKey, COMPAT_KEY_B);

  // A new endpoint is recorded; the model held at the old one gets no auth.
  driven.set(compatConfig(COMPAT_B, COMPAT_KEY_B));
  assert.equal(register.mock.calls.length, 2);
  const atB = port.find(OPENAI_COMPATIBLE_PROVIDER_ID, "m");
  assert.equal(atB?.baseUrl, COMPAT_B);
  assert.equal((await runtime.getAuth(atB!))?.auth.apiKey, COMPAT_KEY_B);

  // No configuration: unregistered, and nothing authenticates.
  driven.set(undefined);
  assert.equal(unregister.mock.calls.length, 1);
  assert.equal(port.find(OPENAI_COMPATIBLE_PROVIDER_ID, "m"), undefined);
  assert.equal(await runtime.getAuth(atB!), undefined);
  driven.set(undefined);
  assert.equal(unregister.mock.calls.length, 1);

  assert.equal(driven.listeners.size, 1);
  port.dispose();
  port.dispose();
  assert.equal(driven.listeners.size, 0);
  driven.set(compatConfig(COMPAT_A, COMPAT_KEY_A));
  assert.equal(
    register.mock.calls.length,
    2,
    "a disposed port registers nothing",
  );
});

test("after an endpoint change, a model held at the old endpoint is refused before any request, and the new one gets the new key", async () => {
  const driven = fakeFeed(compatConfig(COMPAT_A, COMPAT_KEY_A));
  const port = gatewayPiModelPort(ACCESS, {
    server: serverPort(),
    compat: driven.feed,
  });
  try {
    const runtime = await port.runtime("default");
    const atA = port.find(OPENAI_COMPATIBLE_PROVIDER_ID, "m")!;
    driven.set(compatConfig(COMPAT_B, COMPAT_KEY_A));
    driven.set(compatConfig(COMPAT_B, COMPAT_KEY_B));
    assert.equal(await runtime.getAuth(atA), undefined);
    const stale = await sendThrough(port, atA);
    assert.deepEqual(stale.requests, []);
    assert.match(
      stale.errorMessage ?? "",
      /Provider is not configured: openai-compatible/,
    );
    const atB = port.find(OPENAI_COMPATIBLE_PROVIDER_ID, "m")!;
    const fresh = await sendThrough(port, atB);
    assert.deepEqual(
      fresh.requests.map((r) => [r.url, r.authorization]),
      [[`${COMPAT_B}/chat/completions`, `Bearer ${COMPAT_KEY_B}`]],
    );
  } finally {
    port.dispose();
  }
});

test("a Codex model not on the gateway, such as a catalog object at chatgpt.com, gets no lease and sends nothing", async () => {
  const port = gatewayPiModelPort(ACCESS, {
    server: serverPort(),
    compat: fakeFeed().feed,
  });
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
