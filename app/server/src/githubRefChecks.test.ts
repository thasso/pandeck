/**
 * `githubRefChecks` combines two endpoints into one answer. Reporting the half
 * that succeeded is how a provider outage renders as a green build, so a
 * failure on EITHER side must reach the caller — which omits the row rather
 * than showing a clean one.
 */
import assert from "node:assert/strict";
import { beforeEach, test, vi } from "vitest";

let githubRefChecks: typeof import("./githubClient.ts").githubRefChecks;
const config: import("./githubClient.ts").GithubApiConfig = {
  token: "t",
  apiBaseUrl: "https://api.github.com",
};

beforeEach(async () => {
  ({ githubRefChecks } = await import("./githubClient.ts"));
});

/** Drive the real aggregator with stubbed endpoint outcomes. */
async function checks(checkRuns: unknown, statuses: unknown) {
  const original = globalThis.fetch;
  globalThis.fetch = vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    const outcome = url.includes("/check-runs") ? checkRuns : statuses;
    if (outcome instanceof Error) throw outcome;
    return new Response(JSON.stringify(outcome), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  try {
    return await githubRefChecks(config, "o", "r", "abc");
  } finally {
    globalThis.fetch = original;
  }
}

test("a green check-runs result cannot mask an unreadable status endpoint", async () => {
  await assert.rejects(
    checks(
      {
        check_runs: [
          { name: "build", status: "completed", conclusion: "success" },
        ],
      },
      new Error("status unreachable"),
    ),
    "the caller must learn that half the evidence is missing",
  );
});

test("an unreadable check-runs endpoint fails too, whatever the statuses say", async () => {
  await assert.rejects(
    checks(new Error("check-runs unreachable"), {
      statuses: [{ context: "ci", state: "success" }],
    }),
  );
});

test("a cancelled check is a terminal failure, never green", async () => {
  const summary = await checks(
    {
      check_runs: [
        { name: "build", status: "completed", conclusion: "cancelled" },
      ],
    },
    { statuses: [] },
  );
  assert.equal(summary.state, "failure");
});

test("both endpoints answering produces one combined verdict", async () => {
  const summary = await checks(
    {
      check_runs: [
        { name: "build", status: "completed", conclusion: "success" },
      ],
    },
    {
      statuses: [
        { context: "legacy", state: "failure", target_url: "https://ci/1" },
      ],
    },
  );
  // The legacy status is failing, so the combined answer is failing — which is
  // exactly the case the swallowed failure used to hide.
  assert.equal(summary.state, "failure");
  assert.equal(summary.total, 2);
  assert.equal(summary.url, "https://ci/1");
});
