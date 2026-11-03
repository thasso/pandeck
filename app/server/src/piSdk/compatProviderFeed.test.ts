/**
 * The engines' OpenAI-compatible feed (`compatProviderFeed.ts`) is key-less:
 * across a key entry, a rotation, an endpoint change with a new key and a
 * cleared key, what it answers has the settings' base URL and models and no
 * `apiKey`, whatever the settings hold. Settings live in the test's temp
 * `DATA_DIR`; discovery answers from a stubbed `fetch`.
 */
import assert from "node:assert/strict";
import { afterEach, test, vi } from "vitest";
import {
  getOpenAiCompatibleProviderConfigForRegistry,
  testOpenAiCompatibleSettings,
  updateOpenAiCompatibleSettings,
} from "../openAiCompatibleSettings.ts";
import {
  COMPAT_KEY_A,
  COMPAT_KEY_B,
  COMPAT_KEY_C,
} from "../test/gatewayFixtures.ts";
import {
  compatProviderFeed,
  notifyCompatProviderChanged,
} from "./compatProviderFeed.ts";

const ENDPOINT_A = "http://compat-a.test/v1";
const ENDPOINT_B = "http://compat-b.test/v1";

afterEach(() => {
  vi.unstubAllGlobals();
  updateOpenAiCompatibleSettings({
    enabled: false,
    name: "",
    baseUrl: "",
    clearApiKey: true,
  });
});

/** Discovery against a stub listing `m`, so the registry config has models. */
async function discover(): Promise<void> {
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response(JSON.stringify({ data: [{ id: "m" }] }), { status: 200 }),
    ),
  );
  assert.equal((await testOpenAiCompatibleSettings()).ok, true);
}

/** The feed now: the settings' config without the key, and no key anywhere. */
function assertKeyless(baseUrl: string, apiKey: string): void {
  const registry = getOpenAiCompatibleProviderConfigForRegistry();
  assert.equal(registry?.apiKey, apiKey, "the settings hold the key");
  const current = compatProviderFeed.current();
  assert.ok(current);
  assert.equal(Object.hasOwn(current, "apiKey"), false);
  const text = JSON.stringify(current);
  for (const key of [COMPAT_KEY_A, COMPAT_KEY_B, COMPAT_KEY_C])
    assert.ok(!text.includes(key), `the feed holds ${key}`);
  assert.equal(current.baseUrl, baseUrl);
  const { apiKey: _key, ...expected } = registry!;
  assert.deepEqual(current, expected);
  assert.deepEqual(
    current.models.map((model) => model.id),
    ["m"],
  );
}

test("AC22: the feed never answers the key, whatever the settings hold", async () => {
  assert.equal(compatProviderFeed.current(), undefined);
  updateOpenAiCompatibleSettings({
    enabled: true,
    name: "Feed",
    baseUrl: ENDPOINT_A,
    apiKey: COMPAT_KEY_A,
  });
  await discover();
  assertKeyless(ENDPOINT_A, COMPAT_KEY_A);

  updateOpenAiCompatibleSettings({ apiKey: COMPAT_KEY_B });
  assertKeyless(ENDPOINT_A, COMPAT_KEY_B);

  updateOpenAiCompatibleSettings({ baseUrl: ENDPOINT_B, apiKey: COMPAT_KEY_C });
  await discover();
  assertKeyless(ENDPOINT_B, COMPAT_KEY_C);

  updateOpenAiCompatibleSettings({ clearApiKey: true });
  assertKeyless(ENDPOINT_B, "none");
});

test("a notification reaches each subscription until it unsubscribes", () => {
  const calls: string[] = [];
  const first = compatProviderFeed.subscribe(() => calls.push("first"));
  const second = compatProviderFeed.subscribe(() => calls.push("second"));
  notifyCompatProviderChanged();
  first();
  notifyCompatProviderChanged();
  second();
  notifyCompatProviderChanged();
  assert.deepEqual(calls, ["first", "second", "second"]);
});
