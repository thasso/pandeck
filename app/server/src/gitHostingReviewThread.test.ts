import { afterEach, expect, test, vi } from "vitest";
import { githubSetReviewThreadResolved } from "./gitHosting.ts";

const config = { token: "t", apiBaseUrl: "https://api.github.com" };
const ref = { owner: "acme", repo: "app" };
const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

function stub(node: unknown, mutation?: unknown) {
  const calls: Array<{ query: string; variables: Record<string, unknown> }> =
    [];
  globalThis.fetch = vi.fn(async (_input, init) => {
    const body = JSON.parse(String(init?.body));
    calls.push(body);
    return new Response(
      JSON.stringify({ data: calls.length === 1 ? { node } : mutation }),
      { status: 200 },
    );
  }) as typeof fetch;
  return calls;
}
const thread = (resolved = false) => ({
  __typename: "PullRequestReviewThread",
  id: "PRRT_one",
  isResolved: resolved,
  pullRequest: { number: 42, repository: { nameWithOwner: "Acme/App" } },
});

test.each([true, false])(
  "sets resolved=%s after checking the thread belongs to the named PR",
  async (resolved) => {
    const field = resolved ? "resolveReviewThread" : "unresolveReviewThread";
    const calls = stub(thread(!resolved), {
      [field]: { thread: { id: "PRRT_one", isResolved: resolved } },
    });
    await githubSetReviewThreadResolved(ref, config, 42, "PRRT_one", resolved);
    expect(calls).toHaveLength(2);
    expect(calls[0]?.query).toContain("pullRequest");
    expect(calls[0]?.variables).toEqual({ id: "PRRT_one" });
    expect(calls[1]?.query).toContain(`${field}(input:`);
    expect(calls[1]?.variables).toEqual({ threadId: "PRRT_one" });
  },
);

test.each([
  null,
  { ...thread(), __typename: "Issue" },
  {
    ...thread(),
    pullRequest: { number: 43, repository: { nameWithOwner: "acme/app" } },
  },
  {
    ...thread(),
    pullRequest: { number: 42, repository: { nameWithOwner: "other/app" } },
  },
])(
  "refuses a missing, wrong-kind or foreign thread without writing",
  async (node) => {
    const calls = stub(node);
    await expect(
      githubSetReviewThreadResolved(ref, config, 42, "PRRT_one", true),
    ).rejects.toThrow(/thread.*pull request/i);
    expect(calls).toHaveLength(1);
  },
);

test.each([true, false])(
  "already resolved=%s is a read-only retry",
  async (resolved) => {
    const calls = stub(thread(resolved));
    await githubSetReviewThreadResolved(ref, config, 42, "PRRT_one", resolved);
    expect(calls).toHaveLength(1);
  },
);

test("does not claim success when the mutation omits the requested state", async () => {
  stub(thread(), {
    resolveReviewThread: { thread: { id: "PRRT_one", isResolved: false } },
  });
  await expect(
    githubSetReviewThreadResolved(ref, config, 42, "PRRT_one", true),
  ).rejects.toThrow(/confirm/i);
});

test("surfaces GraphQL permission failures", async () => {
  globalThis.fetch = vi.fn(
    async () =>
      new Response(
        JSON.stringify({ errors: [{ message: "Resource not accessible" }] }),
        { status: 200 },
      ),
  ) as typeof fetch;
  await expect(
    githubSetReviewThreadResolved(ref, config, 42, "PRRT_one", true),
  ).rejects.toThrow(/Resource not accessible/);
});

test.each([
  [0, "PRRT_one", true],
  [1.5, "PRRT_one", true],
  [42, " ", true],
  [42, "PRRT_one", undefined],
])(
  "invalid arguments are refused before any request",
  async (number, id, resolved) => {
    const fetch = vi.fn();
    globalThis.fetch = fetch;
    await expect(
      githubSetReviewThreadResolved(
        ref,
        config,
        number as number,
        id as string,
        resolved as boolean,
      ),
    ).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  },
);
