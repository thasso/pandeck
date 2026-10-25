import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { hostingProviderFor } from "./gitHosting.ts";
import {
  getGithubToolConfig,
  getGithubConfigIfAvailable,
} from "./githubSettings.ts";
import { getForgejoToolConfig } from "./forgejoSettings.ts";

vi.mock("./githubSettings.ts", async (importActual) => ({
  ...(await importActual<typeof import("./githubSettings.ts")>()),
  getGithubToolConfig: vi.fn(),
  getGithubConfigIfAvailable: vi.fn(),
}));
vi.mock("./forgejoSettings.ts", async (importActual) => ({
  ...(await importActual<typeof import("./forgejoSettings.ts")>()),
  getForgejoToolConfig: vi.fn(),
}));
const config = { token: "t", apiBaseUrl: "https://api.github.com" };
const originalFetch = globalThis.fetch;
beforeEach(() => {
  vi.mocked(getGithubToolConfig).mockReturnValue(config);
  vi.mocked(getGithubConfigIfAvailable).mockReturnValue(config);
  vi.mocked(getForgejoToolConfig).mockReturnValue({
    baseUrl: "https://git.example.com",
    token: "t",
  });
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});
const provider = (signal?: AbortSignal) =>
  hostingProviderFor({ service: "github", owner: "acme", repo: "app" }, signal);
const setResolved = (number: number, id: string, resolved: boolean) =>
  provider().setPullRequestReviewThreadResolved!(number, id, resolved);

const query = `query($id: ID!) {
    node(id: $id) { __typename ... on PullRequestReviewThread {
      id isResolved pullRequest { number repository { nameWithOwner } }
    } }
  }`;
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
    await setResolved(42, "PRRT_one", resolved);
    expect(calls).toEqual([
      { query, variables: { id: "PRRT_one" } },
      {
        query: `mutation($threadId: ID!) { ${field}(input: {threadId: $threadId}) { thread { id isResolved } } }`,
        variables: { threadId: "PRRT_one" },
      },
    ]);
  },
);

test.each([
  null,
  { ...thread(), __typename: "Issue" },
  { ...thread(), id: "PRRT_other" },
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
    await expect(setResolved(42, "PRRT_one", true)).rejects.toThrow(
      /thread.*pull request/i,
    );
    expect(calls).toHaveLength(1);
  },
);

test.each([true, false])(
  "already resolved=%s is a read-only retry",
  async (resolved) => {
    const calls = stub(thread(resolved));
    await setResolved(42, "PRRT_one", resolved);
    expect(calls).toEqual([{ query, variables: { id: "PRRT_one" } }]);
  },
);

test.each([
  {},
  { resolveReviewThread: null },
  { resolveReviewThread: { thread: { id: "PRRT_one", isResolved: false } } },
  { resolveReviewThread: { thread: { id: "PRRT_other", isResolved: true } } },
])(
  "requires the mutation to confirm the exact id and state",
  async (mutation) => {
    stub(thread(), mutation);
    await expect(setResolved(42, "PRRT_one", true)).rejects.toThrow(/confirm/i);
  },
);

test("surfaces GraphQL permission failures", async () => {
  globalThis.fetch = vi.fn(
    async () =>
      new Response(
        JSON.stringify({ errors: [{ message: "Resource not accessible" }] }),
      ),
  ) as typeof fetch;
  await expect(setResolved(42, "PRRT_one", true)).rejects.toThrow(
    /Resource not accessible/,
  );
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
      setResolved(number as number, id as string, resolved as boolean),
    ).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  },
);

test("Forgejo does not advertise thread or GitHub-style reply/assignment capabilities", () => {
  const forgejo = hostingProviderFor({
    service: "forgejo",
    owner: "acme",
    repo: "app",
  });
  expect(forgejo.setPullRequestReviewThreadResolved).toBeUndefined();
  expect(forgejo.replyToPullRequestReviewComment).toBeUndefined();
  expect(forgejo.updatePullRequestReviewers).toBeUndefined();
  expect(forgejo.updatePullRequestAssignees).toBeUndefined();
  expect(provider().commentOnPullRequestReview).toBeUndefined();
});

test.each([1, 2])(
  "request %s times out independently without a retry",
  async (failAt) => {
    const timers: AbortController[] = [];
    vi.spyOn(AbortSignal, "timeout").mockImplementation((ms) => {
      expect(ms).toBe(8000);
      const controller = new AbortController();
      timers.push(controller);
      return controller.signal;
    });
    const fetch = vi.fn(async (_input, init) => {
      if (timers.length === failAt) {
        const rejected = new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () =>
              reject(
                new Error("request aborted", { cause: init.signal?.reason }),
              ),
            { once: true },
          );
        });
        timers.at(-1)!.abort(new DOMException("timed out", "TimeoutError"));
        return rejected;
      }
      return new Response(JSON.stringify({ data: { node: thread() } }));
    });
    globalThis.fetch = fetch as typeof globalThis.fetch;
    await expect(setResolved(42, "PRRT_one", true)).rejects.toThrow();
    expect(fetch).toHaveBeenCalledTimes(failAt);
    expect(timers).toHaveLength(failAt);
  },
);

test("an explicit provider parent signal still cancels a thread request", async () => {
  const controller = new AbortController();
  controller.abort();
  globalThis.fetch = vi.fn(async (_input, init) => {
    expect(init?.signal?.aborted).toBe(true);
    init?.signal?.throwIfAborted();
    throw new Error("unreachable");
  }) as typeof fetch;
  await expect(
    provider(controller.signal).setPullRequestReviewThreadResolved!(
      42,
      "PRRT_one",
      true,
    ),
  ).rejects.toThrow();
});
