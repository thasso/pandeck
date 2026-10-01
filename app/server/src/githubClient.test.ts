import { afterEach, expect, test, vi } from "vitest";
import {
  githubRateLimit,
  githubRequest,
  type GithubApiConfig,
} from "./githubClient.ts";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function config(token: string): GithubApiConfig {
  return { token, apiBaseUrl: "https://api.github.com" };
}

function headerOf(init: RequestInit | undefined, name: string) {
  return (init?.headers as Record<string, string> | undefined)?.[name];
}

test("a repeated GET is conditional and a 304 answers with the cached body", async () => {
  const fetchMock = vi.fn(
    async (_input: string | URL | Request, init?: RequestInit) =>
      headerOf(init, "If-None-Match") === '"v1"'
        ? new Response(null, {
            status: 304,
            headers: { "x-ratelimit-remaining": "4990" },
          })
        : new Response(JSON.stringify({ number: 7 }), {
            status: 200,
            headers: { etag: '"v1"', link: '<https://next>; rel="next"' },
          }),
  );
  globalThis.fetch = fetchMock as unknown as typeof fetch;

  const first = await githubRequest(config("ghp_etag"), "GET", "/pulls/7");
  const second = await githubRequest(config("ghp_etag"), "GET", "/pulls/7");

  expect(headerOf(fetchMock.mock.calls[0]![1], "If-None-Match")).toBe(
    undefined,
  );
  expect(headerOf(fetchMock.mock.calls[1]![1], "If-None-Match")).toBe('"v1"');
  expect(second.data).toEqual(first.data);
  expect(second.status).toBe(200);
  expect(second.nextUrl).toBe("https://next");
  expect(second.rateRemaining).toBe(4990);
});

test("the ETag cache is per token and never conditions a write", async () => {
  const fetchMock = vi.fn(
    async (_input: string | URL | Request, _init?: RequestInit) =>
      new Response(JSON.stringify({}), {
        status: 200,
        headers: { etag: '"v1"' },
      }),
  );
  globalThis.fetch = fetchMock as unknown as typeof fetch;

  await githubRequest(config("ghp_a"), "GET", "/user");
  await githubRequest(config("ghp_b"), "GET", "/user");
  await githubRequest(config("ghp_a"), "POST", "/user", { body: {} });

  expect(headerOf(fetchMock.mock.calls[1]![1], "If-None-Match")).toBe(
    undefined,
  );
  expect(headerOf(fetchMock.mock.calls[2]![1], "If-None-Match")).toBe(
    undefined,
  );
});

test("the rate limit is reported until its window resets", async () => {
  vi.useFakeTimers();
  try {
    const reset = Math.floor(Date.now() / 1_000) + 600;
    globalThis.fetch = vi.fn(
      async () =>
        new Response("{}", {
          status: 200,
          headers: {
            "x-ratelimit-remaining": "321",
            "x-ratelimit-reset": String(reset),
          },
        }),
    ) as unknown as typeof fetch;

    expect(githubRateLimit(config("ghp_rate"))).toBe(null);
    await githubRequest(config("ghp_rate"), "GET", "/rate");
    expect(githubRateLimit(config("ghp_rate"))).toEqual({
      remaining: 321,
      resetAt: reset * 1_000,
    });

    // A window that has reset is a full budget, not the stale remainder.
    vi.setSystemTime(reset * 1_000);
    expect(githubRateLimit(config("ghp_rate"))).toBe(null);
  } finally {
    vi.useRealTimers();
  }
});

test("only the core REST budget is recorded, never GraphQL or search", async () => {
  const reset = Math.floor(Date.now() / 1_000) + 600;
  globalThis.fetch = vi.fn(async (input: string | URL | Request) => {
    const path = new URL(String(input)).pathname;
    const [remaining, resource] =
      path === "/graphql"
        ? ["4900", "graphql"]
        : path.startsWith("/search/")
          ? ["29", undefined]
          : ["450", "core"];
    return new Response("{}", {
      status: 200,
      headers: {
        "x-ratelimit-remaining": remaining,
        "x-ratelimit-reset": String(reset),
        ...(resource ? { "x-ratelimit-resource": resource } : {}),
      },
    });
  }) as unknown as typeof fetch;

  await githubRequest(config("ghp_core"), "GET", "/repos/o/r/pulls/1");
  await githubRequest(config("ghp_core"), "POST", "/graphql", { body: {} });
  await githubRequest(config("ghp_core"), "GET", "/search/issues");

  expect(githubRateLimit(config("ghp_core"))?.remaining).toBe(450);
});

test("out-of-order answers keep the lowest remainder of their window", async () => {
  const reset = Math.floor(Date.now() / 1_000) + 600;
  const answer = (remaining: number, windowReset: number) =>
    new Response("{}", {
      status: 200,
      headers: {
        "x-ratelimit-remaining": String(remaining),
        "x-ratelimit-reset": String(windowReset),
        "x-ratelimit-resource": "core",
      },
    });
  const answers = [
    answer(100, reset),
    answer(101, reset),
    answer(4999, reset - 3_600),
    answer(4998, reset + 3_600),
  ];
  globalThis.fetch = vi.fn(async () =>
    answers.shift()!,
  ) as unknown as typeof fetch;
  const read = () => githubRequest(config("ghp_order"), "POST", "/x");

  await read();
  await read();
  expect(githubRateLimit(config("ghp_order"))?.remaining).toBe(100);
  await read(); // a late answer from the previous window
  expect(githubRateLimit(config("ghp_order"))?.remaining).toBe(100);
  await read(); // the next window replaces it
  expect(githubRateLimit(config("ghp_order"))?.remaining).toBe(4998);
});
