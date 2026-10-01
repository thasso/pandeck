import { afterEach, describe, expect, test, vi } from "vitest";
import {
  fetchWithRetry,
  retryDelayMs,
  setRetrySleepForTests,
} from "./httpRetry.ts";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  setRetrySleepForTests(null);
});

describe("fetchWithRetry", () => {
  test("retries 429 honoring Retry-After and returns the eventual success", async () => {
    const waits: number[] = [];
    setRetrySleepForTests(async (ms) => {
      waits.push(ms);
    });
    let calls = 0;
    globalThis.fetch = vi.fn(async () => {
      calls += 1;
      if (calls < 3)
        return new Response("slow down", {
          status: 429,
          headers: { "retry-after": "2" },
        });
      return new Response("ok", { status: 200 });
    }) as unknown as typeof fetch;
    const onRetry = vi.fn();
    const res = await fetchWithRetry("https://x.test/", {}, { onRetry });
    expect(res.status).toBe(200);
    expect(calls).toBe(3);
    expect(waits).toEqual([2000, 2000]);
    expect(onRetry).toHaveBeenCalledTimes(2);
    expect(onRetry.mock.calls[0]![0]).toMatchObject({
      attempt: 1,
      status: 429,
    });
  });

  test("returns the last failed response once attempts are exhausted", async () => {
    setRetrySleepForTests(async () => {});
    globalThis.fetch = vi.fn(
      async () => new Response("nope", { status: 503 }),
    ) as unknown as typeof fetch;
    const res = await fetchWithRetry("https://x.test/", {}, { attempts: 2 });
    expect(res.status).toBe(503);
    expect(globalThis.fetch).toHaveBeenCalledTimes(2);
  });

  test("does not retry ordinary client errors", async () => {
    globalThis.fetch = vi.fn(
      async () => new Response("bad", { status: 400 }),
    ) as unknown as typeof fetch;
    const res = await fetchWithRetry("https://x.test/", {});
    expect(res.status).toBe(400);
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });

  test("stops immediately when the signal is already aborted", async () => {
    globalThis.fetch = vi.fn() as unknown as typeof fetch;
    const controller = new AbortController();
    controller.abort();
    await expect(
      fetchWithRetry("https://x.test/", {}, { signal: controller.signal }),
    ).rejects.toThrow(/aborted/);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
});

describe("retryDelayMs", () => {
  test("uses Retry-After seconds, falls back to bounded exponential backoff", () => {
    expect(retryDelayMs(1, "3")).toBe(3000);
    expect(retryDelayMs(1, null)).toBeGreaterThanOrEqual(1000);
    expect(retryDelayMs(1, null)).toBeLessThan(2000);
    expect(retryDelayMs(10, null)).toBe(60_000);
  });
});
