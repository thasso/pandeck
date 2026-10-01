import assert from "node:assert/strict";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

// Mutable holder so tests can flip the "configured" state of the Context7 key.
const c7 = vi.hoisted(() => ({ key: "ctx7sk-test-key" }));
vi.mock("../../context7Settings.ts", () => ({
  CONTEXT7_API_BASE: "https://context7.com/api/v2",
  getContext7ToolConfig() {
    if (!c7.key)
      throw new Error(
        "Context7 is not configured: add a Context7 API key in Settings → Context7.",
      );
    return { apiKey: c7.key };
  },
}));

import {
  context7GetDocsTool,
  context7ResolveLibraryTool,
} from "./context7Tools.ts";

const originalFetch = globalThis.fetch;
beforeEach(() => {
  c7.key = "ctx7sk-test-key";
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

const context = {
  toolCallId: "c7-test",
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

test("context7_resolve_library throws a clear error when not configured", async () => {
  c7.key = "";
  globalThis.fetch = vi.fn(async () => {
    throw new Error("should not be called");
  }) as typeof fetch;
  await expect(
    context7ResolveLibraryTool.execute({ libraryName: "react" }, context),
  ).rejects.toThrow(/not configured/i);
});

test("context7_resolve_library sends the bearer token and returns compact candidates", async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  globalThis.fetch = vi.fn(
    async (input: string | URL | Request, init?: RequestInit) => {
      calls.push({
        url: String(input),
        ...(init !== undefined ? { init } : {}),
      });
      return json({
        results: [
          {
            id: "/vercel/next.js",
            title: "Next.js",
            description: "React framework",
            trustScore: 9.5,
            totalSnippets: 1200,
          },
          { id: "", title: "junk with no id" },
        ],
      });
    },
  ) as typeof fetch;

  const result = await context7ResolveLibraryTool.execute(
    { libraryName: "next.js", query: "routing" },
    context,
  );
  const payload = parse(result);

  assert.equal(payload.count, 1); // the id-less result is dropped
  assert.equal(payload.results[0].id, "/vercel/next.js");
  assert.equal(payload.results[0].trustScore, 9.5);

  const url = new URL(calls[0]!.url);
  assert.equal(url.pathname, "/api/v2/libs/search");
  assert.equal(url.searchParams.get("libraryName"), "next.js");
  assert.equal(url.searchParams.get("query"), "routing");
  assert.equal(
    (calls[0]!.init?.headers as Record<string, string>).Authorization,
    "Bearer ctx7sk-test-key",
  );
});

test("context7_get_docs formats code + info snippets into Markdown and truncates", async () => {
  globalThis.fetch = vi.fn(async () =>
    json({
      infoSnippets: [{ content: "Next.js App Router overview." }],
      codeSnippets: [
        {
          codeTitle: "Define a page",
          codeLanguage: "tsx",
          codeList: [{ code: "export default function Page() {}" }],
        },
      ],
    }),
  ) as typeof fetch;

  const result = await context7GetDocsTool.execute(
    { libraryId: "/vercel/next.js", query: "app router" },
    context,
  );
  const payload = parse(result);

  assert.equal(payload.libraryId, "/vercel/next.js");
  assert.match(payload.content, /App Router overview/);
  assert.match(payload.content, /### Define a page/);
  assert.match(payload.content, /```tsx/);
  assert.equal(payload.truncated, false);
});

test("context7_get_docs passes through a plain-text response", async () => {
  globalThis.fetch = vi.fn(
    async () =>
      new Response("PLAIN TEXT DOCS", {
        status: 200,
        headers: { "Content-Type": "text/plain" },
      }),
  ) as typeof fetch;

  const result = await context7GetDocsTool.execute(
    { libraryId: "/vercel/next.js", query: "x", maxChars: 5 },
    context,
  );
  const payload = parse(result);

  assert.equal(payload.content, "PLAIN");
  assert.equal(payload.truncated, true);
});

test("context7_get_docs requires both a libraryId and a query", async () => {
  globalThis.fetch = vi.fn() as unknown as typeof fetch;
  await expect(
    context7GetDocsTool.execute({ libraryId: "", query: "x" }, context),
  ).rejects.toThrow(/libraryId/i);
  await expect(
    context7GetDocsTool.execute({ libraryId: "/a/b", query: "" }, context),
  ).rejects.toThrow(/query/i);
});
