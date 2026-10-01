import { afterEach, describe, expect, test, vi } from "vitest";
import { setRetrySleepForTests } from "./httpRetry.ts";
import { jiraGet, jiraPost } from "./jiraClient.ts";

const config = {
  jiraHost: "example.atlassian.net",
  atlassianEmail: "a@b.c",
  atlassianToken: "t",
};
const originalFetch = globalThis.fetch;

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

afterEach(() => {
  globalThis.fetch = originalFetch;
  setRetrySleepForTests(null);
});

describe("jira retry policy", () => {
  test("GET retries a transient failure", async () => {
    setRetrySleepForTests(async () => {});
    const calls = flakyOnce();
    await expect(jiraGet(config, "/rest/api/3/myself")).resolves.toEqual({
      ok: true,
    });
    expect(calls()).toBe(2);
  });

  test("a write POST is never replayed", async () => {
    setRetrySleepForTests(async () => {});
    const calls = flakyOnce();
    await expect(
      jiraPost(config, "/rest/api/3/issue", { fields: {} }),
    ).rejects.toThrow(/HTTP 503/);
    expect(calls()).toBe(1);
  });

  test("a read-only POST opts into retries", async () => {
    setRetrySleepForTests(async () => {});
    const calls = flakyOnce();
    await expect(
      jiraPost(config, "/rest/api/3/issue/bulkfetch", {}, undefined, {
        retry: true,
      }),
    ).resolves.toEqual({ ok: true });
    expect(calls()).toBe(2);
  });
});
