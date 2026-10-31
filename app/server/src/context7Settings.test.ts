import assert from "node:assert/strict";
import { afterEach, test, vi } from "vitest";
import {
  CONTEXT7_API_BASE,
  getContext7ToolConfig,
  testContext7Settings,
  updateContext7Settings,
} from "./context7Settings.ts";
import { SecretDestinationError } from "./secretStore.ts";

const FIXTURE_KEY = "fixture-context7-key";
const SEARCH = new URL(`${CONTEXT7_API_BASE}/search`);
const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
  updateContext7Settings({ enabled: false, clearApiKey: true });
});

test("the tool config keeps its gate and reads the saved key", async () => {
  await assert.rejects(getContext7ToolConfig(SEARCH), {
    message:
      "Context7 docs search is disabled. Enable it in Settings → Context7.",
  });
  updateContext7Settings({ enabled: true });
  await assert.rejects(getContext7ToolConfig(SEARCH), {
    message:
      "Context7 is not configured: add a Context7 API key in Settings → Context7.",
  });
  updateContext7Settings({ apiKey: ` ${FIXTURE_KEY} ` });
  assert.deepEqual(await getContext7ToolConfig(SEARCH), {
    apiKey: FIXTURE_KEY,
  });
  await assert.rejects(
    getContext7ToolConfig(new URL("https://evil.example/")),
    SecretDestinationError,
  );
});

test("the connection test keeps its messages and sends the key to Context7", async () => {
  assert.equal(
    (await testContext7Settings()).message,
    "Context7 docs search is disabled.",
  );
  updateContext7Settings({ enabled: true });
  const missing = await testContext7Settings();
  assert.equal(missing.ok, false);
  assert.equal(missing.message, "A Context7 API key is required.");

  updateContext7Settings({ apiKey: FIXTURE_KEY });
  const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  const valid = await testContext7Settings();
  assert.deepEqual(
    { ok: valid.ok, message: valid.message },
    { ok: true, message: "Context7 API key is valid." },
  );
  assert.equal(fetchMock.mock.calls.length, 1);
  const [url, init] = fetchMock.mock.calls[0] as unknown as [URL, RequestInit];
  assert.equal(
    url.toString(),
    "https://context7.com/api/v2/libs/search?libraryName=react",
  );
  assert.equal(
    (init.headers as Record<string, string>).Authorization,
    `Bearer ${FIXTURE_KEY}`,
  );
});
