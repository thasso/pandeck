import { afterEach, describe, expect, test, vi } from "vitest";
import { setRetrySleepForTests } from "../../httpRetry.ts";
import {
  fetchAllWorklogs,
  fetchWorklogs,
  tempoJson,
} from "./tempoWorklogFetch.ts";

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
  setRetrySleepForTests(null);
});

describe("tempoJson retry policy", () => {
  function flakyOnce() {
    let calls = 0;
    globalThis.fetch = vi.fn(async () => {
      calls += 1;
      return calls === 1
        ? new Response("busy", { status: 503 })
        : new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as unknown as typeof fetch;
    return () => calls;
  }

  test("GET retries, a worklog POST does not", async () => {
    setRetrySleepForTests(async () => {});
    const url = new URL("https://api.tempo.io/4/worklogs");
    let calls = flakyOnce();
    await expect(tempoJson(url, "at", "GET")).resolves.toEqual({ ok: true });
    expect(calls()).toBe(2);
    calls = flakyOnce();
    await expect(tempoJson(url, "at", "POST", { x: 1 })).rejects.toThrow(
      /HTTP 503/,
    );
    expect(calls()).toBe(1);
  });

  test("the read-only worklog search retries", async () => {
    setRetrySleepForTests(async () => {});
    let calls = 0;
    globalThis.fetch = vi.fn(async () => {
      calls += 1;
      return calls === 1
        ? new Response("busy", { status: 429 })
        : new Response(JSON.stringify({ results: [], metadata: {} }), {
            status: 200,
          });
    }) as unknown as typeof fetch;
    const page = await fetchWorklogs({
      ...base,
      maxResults: 10,
      filter: { projectIds: ["7"] },
    });
    expect(page.worklogs).toEqual([]);
    expect(calls).toBe(2);
  });
});

const base = {
  apiBaseUrl: "https://api.tempo.io/4",
  accessToken: "at",
  from: "2025-01-01",
  to: "2025-01-07",
};

function worklog(id: number, author = "me") {
  return {
    tempoWorklogId: id,
    issue: { id: String(10000 + id) },
    timeSpentSeconds: 60,
    startDate: "2025-01-01",
    author: { accountId: author },
  };
}

/** Serve `all` in pages honoring offset/limit, like Tempo does. */
function pagedTempo(all: ReturnType<typeof worklog>[]) {
  const calls: Array<{ url: URL; body: unknown }> = [];
  globalThis.fetch = vi.fn(async (input: unknown, init?: RequestInit) => {
    const url = new URL(String(input));
    calls.push({
      url,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });
    const offset = Number(url.searchParams.get("offset"));
    const limit = Number(url.searchParams.get("limit"));
    const results = all.slice(offset, offset + limit);
    const next = offset + results.length < all.length ? "next" : undefined;
    return new Response(
      JSON.stringify({ results, metadata: { count: results.length, next } }),
      { status: 200 },
    );
  }) as unknown as typeof fetch;
  return calls;
}

describe("fetchWorklogs paging", () => {
  test("reports nextOffset instead of silently truncating", async () => {
    pagedTempo([worklog(1), worklog(2), worklog(3)]);
    const first = await fetchWorklogs({ ...base, maxResults: 2 });
    expect(first.worklogs.map((w) => w.tempoWorklogId)).toEqual([1, 2]);
    expect(first.nextOffset).toBe(2);
    const second = await fetchWorklogs({
      ...base,
      maxResults: 2,
      offset: first.nextOffset!,
    });
    expect(second.worklogs.map((w) => w.tempoWorklogId)).toEqual([3]);
    expect(second.nextOffset).toBeNull();
  });

  test("client-side author filter keeps scanning pages and reports raw offsets", async () => {
    const all = [
      worklog(1, "other"),
      worklog(2, "me"),
      worklog(3, "other"),
      worklog(4, "me"),
      worklog(5, "me"),
    ];
    pagedTempo(all);
    const page = await fetchWorklogs({
      ...base,
      maxResults: 2,
      authorAccountId: "me",
    });
    expect(page.worklogs.map((w) => w.tempoWorklogId)).toEqual([2, 4]);
    expect(page.nextOffset).toBe(4);
    expect(page.scanned).toBe(4);
  });

  test("issue/project filters go through Tempo's worklog search", async () => {
    const calls = pagedTempo([worklog(1)]);
    await fetchWorklogs({
      ...base,
      maxResults: 10,
      filter: { issueIds: ["10001"], projectIds: ["7"] },
    });
    expect(calls[0]!.url.pathname).toBe("/4/worklogs/search");
    expect(calls[0]!.body).toEqual({
      from: "2025-01-01",
      to: "2025-01-07",
      issueIds: [10001],
      projectIds: [7],
    });
  });

  test("fetchAllWorklogs follows next until exhausted", async () => {
    const all = Array.from({ length: 2500 }, (_, i) => worklog(i + 1));
    const calls = pagedTempo(all);
    const worklogs = await fetchAllWorklogs(base);
    expect(worklogs).toHaveLength(2500);
    expect(calls).toHaveLength(3);
    expect(calls[0]!.url.pathname).toBe("/4/worklogs");
  });
});
