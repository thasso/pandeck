import assert from "node:assert/strict";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

// Mutable holder so tests can flip the "configured" state of the Brave key.
const brave = vi.hoisted(() => ({ key: "test-brave-key" }));
vi.mock("../../braveSettings.ts", () => ({
  getBraveToolConfig() {
    if (!brave.key)
      throw new Error(
        "Web search is not configured: add a Brave Search API key in Settings → Web Search.",
      );
    return { apiKey: brave.key };
  },
}));

import { webFetchTool, webSearchTool } from "./webTools.ts";

const originalFetch = globalThis.fetch;
beforeEach(() => {
  brave.key = "test-brave-key";
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

const context = {
  toolCallId: "web-test",
  session: {
    sessionId: "s",
    harness: "pi" as const,
    agentType: "assistant" as const,
  },
};

function json(payload: unknown) {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function parse(result: {
  content: Array<{ type: string; text?: string }>;
}): any {
  const block = result.content[0]!;
  return JSON.parse(block.type === "text" ? block.text! : "{}");
}

// --- web_search ------------------------------------------------------------

test("web_search throws a clear error when the Brave key is not configured", async () => {
  brave.key = "";
  globalThis.fetch = vi.fn(async () => {
    throw new Error("should not be called");
  }) as typeof fetch;
  await expect(
    webSearchTool.execute({ query: "anything" }, context),
  ).rejects.toThrow(/not configured/i);
});

test("web_search sends the subscription token, bounds count, and strips snippet markup", async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  globalThis.fetch = vi.fn(
    async (input: string | URL | Request, init?: RequestInit) => {
      calls.push({
        url: String(input),
        ...(init !== undefined ? { init } : {}),
      });
      return json({
        web: {
          results: [
            {
              title: "First <strong>hit</strong>",
              url: "https://a.example/1",
              description: "A <b>snippet</b>",
              age: "2 days ago",
              profile: { name: "Example" },
            },
            {
              title: "Second",
              url: "https://a.example/2",
              description: "Another",
            },
          ],
        },
      });
    },
  ) as typeof fetch;

  const result = await webSearchTool.execute(
    { query: "test query", count: 99 },
    context,
  );
  const payload = parse(result);

  assert.equal(payload.query, "test query");
  assert.equal(payload.results.length, 2);
  assert.equal(payload.results[0].title, "First hit");
  assert.equal(payload.results[0].description, "A snippet");
  assert.equal(payload.results[0].source, "Example");
  assert.doesNotMatch(JSON.stringify(payload), /<strong>|<b>/);

  const url = new URL(calls[0]!.url);
  assert.equal(url.searchParams.get("q"), "test query");
  assert.equal(url.searchParams.get("count"), "10"); // clamped to SEARCH_MAX_COUNT
  assert.equal(
    (calls[0]!.init!.headers as Record<string, string>)["X-Subscription-Token"],
    "test-brave-key",
  );
});

// --- web_fetch SSRF guards -------------------------------------------------

test("web_fetch rejects non-http(s) URLs without hitting the network", async () => {
  const fetchMock = vi.fn();
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  await expect(
    webFetchTool.execute({ url: "ftp://example.com/x" }, context),
  ).rejects.toThrow(/http\/https/i);
  assert.equal(fetchMock.mock.calls.length, 0);
});

test("web_fetch refuses loopback and cloud-metadata addresses", async () => {
  const fetchMock = vi.fn();
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  await expect(
    webFetchTool.execute({ url: "http://127.0.0.1/secret" }, context),
  ).rejects.toThrow(/non-public/i);
  await expect(
    webFetchTool.execute(
      { url: "http://169.254.169.254/latest/meta-data" },
      context,
    ),
  ).rejects.toThrow(/non-public/i);
  await expect(
    webFetchTool.execute({ url: "http://100.100.1.1/" }, context),
  ).rejects.toThrow(/non-public/i); // tailnet CGNAT
  assert.equal(fetchMock.mock.calls.length, 0);
});

test("web_fetch revalidates redirect targets and refuses a redirect to a private host", async () => {
  const calls: string[] = [];
  globalThis.fetch = vi.fn(async (input: string | URL | Request) => {
    calls.push(String(input));
    return new Response(null, {
      status: 302,
      headers: { location: "http://127.0.0.1/internal" },
    });
  }) as typeof fetch;
  // Public literal IP so the first hop passes the guard, then the redirect is caught.
  await expect(
    webFetchTool.execute({ url: "http://93.184.216.34/start" }, context),
  ).rejects.toThrow(/non-public/i);
  assert.equal(calls.length, 1);
});

// --- web_fetch content extraction -----------------------------------------

test("web_fetch converts HTML to Markdown and reports the title", async () => {
  const html = `<!doctype html><html><head><title>Doc Title</title></head><body>
    <article><h1>Main Heading</h1><p>Hello world, this is the article body with enough text to be meaningful content for extraction purposes.</p></article>
  </body></html>`;
  globalThis.fetch = vi.fn(
    async () =>
      new Response(html, {
        status: 200,
        headers: { "Content-Type": "text/html; charset=utf-8" },
      }),
  ) as typeof fetch;

  const result = await webFetchTool.execute(
    { url: "http://93.184.216.34/page" },
    context,
  );
  const payload = parse(result);

  assert.equal(payload.status, 200);
  assert.match(payload.content, /Hello world/);
  assert.match(payload.content, /Main Heading/);
  assert.equal(typeof payload.title, "string");
  assert.ok(payload.title.length > 0);
  assert.equal(payload.truncated, false);
});

test("web_fetch returns text-like content verbatim and truncates to maxChars", async () => {
  const body = "x".repeat(500);
  globalThis.fetch = vi.fn(
    async () =>
      new Response(body, {
        status: 200,
        headers: { "Content-Type": "text/plain" },
      }),
  ) as typeof fetch;

  const result = await webFetchTool.execute(
    { url: "http://93.184.216.34/raw.txt", maxChars: 100 },
    context,
  );
  const payload = parse(result);

  assert.equal(payload.chars, 100);
  assert.equal(payload.truncated, true);
  assert.equal(payload.content, "x".repeat(100));
});

test("web_fetch rejects unsupported binary content types", async () => {
  globalThis.fetch = vi.fn(
    async () =>
      new Response(new Uint8Array([0, 1, 2, 3]), {
        status: 200,
        headers: { "Content-Type": "application/octet-stream" },
      }),
  ) as typeof fetch;
  await expect(
    webFetchTool.execute({ url: "http://93.184.216.34/blob" }, context),
  ).rejects.toThrow(/unsupported content type/i);
});
