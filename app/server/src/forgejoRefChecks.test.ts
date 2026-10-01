/**
 * `forgejoRefChecks` is the shared CI core behind both the
 * `forgejo_get_ref_checks` tool and `gitHosting.ts`'s Forgejo `ciStatus`, the
 * twin of `githubRefChecks`. Where the GitHub core has to combine two
 * endpoints, this one has to survive two Forgejo quirks: a `total_count` that
 * counts the PAGE rather than the ref, and Actions status URLs that arrive
 * instance-relative. Reporting either one naively turns a partial or unusable
 * answer into a confident green build.
 */
import assert from "node:assert/strict";
import { test, vi } from "vitest";
import { forgejoRefChecks } from "./forgejoClient.ts";
import type { ForgejoApiConfig } from "./forgejoClient.ts";

const config: ForgejoApiConfig = {
  baseUrl: "https://git.example.com",
  token: "fj_test",
};

/** Drive the real aggregator against one stubbed combined-status answer. */
async function checks(
  body: unknown,
  headers: Record<string, string> = {},
): Promise<Awaited<ReturnType<typeof forgejoRefChecks>>> {
  const original = globalThis.fetch;
  globalThis.fetch = vi.fn(
    async () =>
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json", ...headers },
      }),
  ) as typeof fetch;
  try {
    return await forgejoRefChecks(config, "o", "r", "main");
  } finally {
    globalThis.fetch = original;
  }
}

test("the worst context wins, and the failing one is the link offered", async () => {
  const summary = await checks(
    {
      sha: "abc123",
      statuses: [
        { context: "lint", status: "success", target_url: "https://ci/lint" },
        { context: "build", status: "failure", target_url: "https://ci/build" },
        { context: "test", status: "pending", target_url: "https://ci/test" },
      ],
    },
    { "x-total-count": "3" },
  );
  // A green context sitting first must not decide the rollup.
  assert.equal(summary.state, "failure");
  assert.equal(summary.total, 3);
  assert.equal(summary.sha, "abc123");
  assert.equal(summary.truncated, false);
  assert.equal(summary.url, "https://ci/build");
});

test("`error` outranks `failure`, matching Gitea's own rollup order", async () => {
  const summary = await checks({
    statuses: [
      { context: "build", status: "failure" },
      { context: "deploy", status: "error" },
    ],
  });
  assert.equal(summary.state, "error");
});

test("a state decided on less than the whole ref says so", async () => {
  // The body's `total_count` counts the page; `X-Total-Count` counts the ref.
  const summary = await checks(
    {
      total_count: 1,
      statuses: [{ context: "lint", status: "success" }],
    },
    { "x-total-count": "5" },
  );
  assert.equal(summary.total, 5);
  assert.equal(
    summary.truncated,
    true,
    "four unread contexts could hold a failure",
  );
});

test("without the header the count is what was read, never invented", async () => {
  const summary = await checks({
    statuses: [
      { context: "lint", status: "success" },
      { context: "build", status: "success" },
    ],
  });
  assert.equal(summary.total, 2);
  assert.equal(summary.truncated, false);
  assert.equal(summary.state, "success");
});

test("an instance-relative Actions URL is resolved against the base URL", async () => {
  const summary = await checks({
    statuses: [
      {
        context: "ci / build",
        status: "failure",
        target_url: "/o/r/actions/runs/12",
      },
    ],
  });
  assert.equal(summary.url, "https://git.example.com/o/r/actions/runs/12");
  assert.equal(
    summary.statuses[0]?.url,
    "https://git.example.com/o/r/actions/runs/12",
  );
});

test("a ref carrying no status at all is neutral, not green", async () => {
  const summary = await checks({ sha: "abc123", statuses: [] });
  assert.equal(summary.state, "neutral");
  assert.equal(summary.total, 0);
  assert.equal(summary.url, null);
  assert.deepEqual(summary.statuses, []);
});

test("an unknown state keeps the ref pending rather than passing it", async () => {
  const summary = await checks({
    statuses: [{ context: "ci", status: "something-new" }],
  });
  assert.equal(summary.state, "pending");
  assert.equal(summary.total, 1);
});
