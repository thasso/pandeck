/**
 * The git hosting provider seam: remote-URL parsing (ssh/scp-like/https remotes
 * must all resolve to host + owner + repo, and non-repo remotes must resolve to
 * null so no provider is offered), standing review state, and the per-provider
 * merge call — whose two shapes (GitHub merges then deletes the ref; Forgejo
 * does both in one request) are exactly what the seam exists to hide.
 */
import assert from "node:assert/strict";
import { test } from "vitest";
import type {
  PullRequestCloseResult,
  PullRequestMergeResult,
  PullRequestRepositoryCapabilities,
  WorktreePullRequestInfo,
} from "@assistant/shared";
import {
  changesRequestedFromReviews,
  forgejoPullRequestTitle,
  forgejoReadyPullRequestTitle,
  forgejoProvider,
  githubProvider,
  invalidateRepositoryCapabilities,
  parseRemoteUrl,
  pickBranchPull,
  repositoryCapabilitiesFor,
  type GitHostingProvider,
} from "./gitHosting.ts";

test("parses ssh remotes with ports", () => {
  assert.deepEqual(
    parseRemoteUrl(
      "ssh://git@git.example.com:2222/acme/personal-assistant.git",
    ),
    {
      host: "git.example.com",
      owner: "acme",
      repo: "personal-assistant",
    },
  );
});

test("parses scp-like remotes", () => {
  assert.deepEqual(parseRemoteUrl("git@github.com:acme/dashboard.git"), {
    host: "github.com",
    owner: "acme",
    repo: "dashboard",
  });
  assert.deepEqual(parseRemoteUrl("github.com:owner/repo"), {
    host: "github.com",
    owner: "owner",
    repo: "repo",
  });
});

test("parses https remotes with and without .git", () => {
  assert.deepEqual(parseRemoteUrl("https://git.example.com/team/project.git"), {
    host: "git.example.com",
    owner: "team",
    repo: "project",
  });
  assert.deepEqual(parseRemoteUrl("https://git.example.com/team/project/"), {
    host: "git.example.com",
    owner: "team",
    repo: "project",
  });
});

test("Forgejo draft titles use the WIP convention exactly once", () => {
  assert.equal(
    forgejoPullRequestTitle("Add workflow", true),
    "WIP: Add workflow",
  );
  assert.equal(
    forgejoPullRequestTitle("WIP: Add workflow", true),
    "WIP: Add workflow",
  );
  assert.equal(forgejoPullRequestTitle("Add workflow", false), "Add workflow");
  assert.equal(
    forgejoReadyPullRequestTitle("WIP: Add workflow"),
    "Add workflow",
  );
  assert.equal(forgejoReadyPullRequestTitle("Add workflow"), "Add workflow");
  assert.equal(
    forgejoPullRequestTitle("[WIP] Add workflow", true),
    "[WIP] Add workflow",
  );
  assert.equal(
    forgejoReadyPullRequestTitle("[WIP] Add workflow"),
    "Add workflow",
  );
  assert.equal(forgejoPullRequestTitle("WIP:Feature", true), "WIP:Feature");
  assert.equal(forgejoReadyPullRequestTitle("WIP:Feature"), "Feature");
});

test("local paths and junk resolve to null", () => {
  assert.equal(parseRemoteUrl("/tmp/somewhere/bare.git"), null);
  assert.equal(parseRemoteUrl("../relative/repo"), null);
  assert.equal(parseRemoteUrl(""), null);
  assert.equal(parseRemoteUrl("https://host-only.example.org/"), null);
});

/* --------------------------- standing review state -------------------------- */

test("reports changes requested from a standing review", () => {
  assert.equal(
    changesRequestedFromReviews([
      {
        state: "REQUEST_CHANGES",
        user: { login: "ana" },
        submitted_at: "2026-01-01T00:00:00Z",
      },
    ]),
    true,
  );
  assert.equal(
    changesRequestedFromReviews([
      { state: "CHANGES_REQUESTED", user: { login: "ana" } },
    ]),
    true,
  );
});

// A reviewer who asked for changes and then approved has withdrawn the
// objection; only their LATEST review counts.
test("a later approval from the same reviewer withdraws the objection", () => {
  assert.equal(
    changesRequestedFromReviews([
      {
        state: "CHANGES_REQUESTED",
        user: { login: "ana" },
        submitted_at: "2026-01-01T00:00:00Z",
      },
      {
        state: "APPROVED",
        user: { login: "ana" },
        submitted_at: "2026-01-02T00:00:00Z",
      },
    ]),
    false,
  );
});

test("another reviewer's objection still stands", () => {
  assert.equal(
    changesRequestedFromReviews([
      {
        state: "CHANGES_REQUESTED",
        user: { login: "ana" },
        submitted_at: "2026-01-01T00:00:00Z",
      },
      {
        state: "APPROVED",
        user: { login: "ana" },
        submitted_at: "2026-01-02T00:00:00Z",
      },
      {
        state: "REQUEST_CHANGES",
        user: { login: "bo" },
        submitted_at: "2026-01-03T00:00:00Z",
      },
    ]),
    true,
  );
});

test("stale, dismissed, pending and comment-only reviews never object", () => {
  assert.equal(
    changesRequestedFromReviews([
      { state: "CHANGES_REQUESTED", user: { login: "ana" }, stale: true },
    ]),
    false,
  );
  assert.equal(
    changesRequestedFromReviews([
      { state: "CHANGES_REQUESTED", user: { login: "ana" }, dismissed: true },
    ]),
    false,
  );
  assert.equal(
    changesRequestedFromReviews([
      { state: "DISMISSED", user: { login: "ana" } },
    ]),
    false,
  );
  assert.equal(
    changesRequestedFromReviews([{ state: "PENDING", user: { login: "ana" } }]),
    false,
  );
  assert.equal(
    changesRequestedFromReviews([
      { state: "COMMENTED", user: { login: "ana" } },
    ]),
    false,
  );
  assert.equal(changesRequestedFromReviews([]), false);
});

/* ------------------------- which PR belongs to a branch ------------------------ */

// A branch can carry several pull requests over its life. An open one is the
// current one; otherwise the most recently updated, which is how a MERGED PR —
// the only signal that ends a branch — becomes reachable at all.
test("prefers the first open pull request, else the most recent terminal one", () => {
  assert.equal(
    pickBranchPull([{ state: "closed" }, { state: "open" }])?.state,
    "open",
  );
  assert.deepEqual(
    pickBranchPull([
      { state: "open", number: 1 },
      { state: "open", number: 2 },
    ]),
    { state: "open", number: 1 },
  );
  // Callers pass newest-first, so the head is the most recently updated.
  assert.deepEqual(
    pickBranchPull([{ state: "closed", merged: true }, { state: "closed" }]),
    {
      state: "closed",
      merged: true,
    },
  );
  assert.equal(pickBranchPull([]), undefined);
});

/* -------------------------- draft → ready lifecycle ------------------------- */

test("GitHub marks a draft ready through GraphQL", async () => {
  const provider = githubProvider(
    { host: "github.com", owner: "acme", repo: "repo" },
    { token: "t", apiBaseUrl: "https://api.github.com" },
  );
  const calls = await withRecordedFetch(
    (req) =>
      req.method === "GET"
        ? { number: 7, title: "Task-509", node_id: "PR_node", draft: true }
        : {
            data: {
              markPullRequestReadyForReview: {
                pullRequest: { title: "Task-509" },
              },
            },
          },
    async () => {
      assert.deepEqual(await provider.markPullRequestReady?.(7), {
        title: "Task-509",
      });
    },
  );
  assert.deepEqual(
    calls.map((call) => `${call.method} ${call.path}`),
    ["GET /repos/acme/repo/pulls/7", "POST /graphql"],
  );
  assert.match(JSON.stringify(calls[1]!.body), /markPullRequestReadyForReview/);
});

test("GitHub refuses a missing GraphQL mutation confirmation", async () => {
  const provider = githubProvider(
    { host: "github.com", owner: "acme", repo: "repo" },
    { token: "t", apiBaseUrl: "https://api.github.com" },
  );
  await withRecordedFetch(
    (req) =>
      req.method === "GET"
        ? { number: 7, node_id: "PR_node", draft: true }
        : { data: {} },
    async () => {
      await assert.rejects(provider.markPullRequestReady(7), /did not confirm/);
    },
  );
});

test("Forgejo marks a WIP pull request ready by patching the issue title once", async () => {
  const provider = forgejoProvider(
    { host: "git.example.com", owner: "acme", repo: "repo" },
    { baseUrl: "https://git.example.com", token: "t" },
  );
  const calls = await withRecordedFetch(
    () => ({ number: 7, title: "WIP: Task-509" }),
    async () => {
      assert.deepEqual(await provider.markPullRequestReady?.(7), {
        title: "Task-509",
      });
    },
  );
  assert.deepEqual(
    calls.map((call) => `${call.method} ${call.path}`),
    [
      "GET /api/v1/repos/acme/repo/pulls/7",
      "PATCH /api/v1/repos/acme/repo/issues/7",
    ],
  );
  assert.deepEqual(calls[1]!.body, { title: "Task-509" });
});

test("Forgejo recognizes and removes the bracketed WIP marker", async () => {
  const provider = forgejoProvider(
    { host: "git.example.com", owner: "acme", repo: "repo" },
    { baseUrl: "https://git.example.com", token: "t" },
  );
  const calls = await withRecordedFetch(
    () => ({ number: 7, title: "[WIP] Feature", state: "open", merged: false }),
    async () => {
      assert.equal((await provider.pullRequestDetail(7))?.draft, true);
      assert.deepEqual(await provider.markPullRequestReady(7), {
        title: "Feature",
      });
    },
  );
  assert.deepEqual(calls.at(-1)?.body, { title: "Feature" });
});

test("Forgejo refuses a draft without a removable WIP marker", async () => {
  const provider = forgejoProvider(
    { host: "git.example.com", owner: "acme", repo: "repo" },
    { baseUrl: "https://git.example.com", token: "t" },
  );
  const calls = await withRecordedFetch(
    () => ({ number: 7, title: "Feature", draft: true }),
    async () => {
      await assert.rejects(
        provider.markPullRequestReady(7),
        /without a removable WIP/,
      );
    },
  );
  assert.deepEqual(
    calls.map((call) => call.method),
    ["GET"],
  );
});

/* ------------------------------- CI rollups -------------------------------- */

test("an observed Forgejo failure stays red when the bounded result is truncated", async () => {
  const provider = forgejoProvider(
    { host: "git.example.com", owner: "acme", repo: "repo" },
    { baseUrl: "https://git.example.com", token: "t" },
  );
  const original = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({
        statuses: [{ context: "test", status: "failure" }],
      }),
      { status: 200, headers: { "x-total-count": "150" } },
    )) as typeof fetch;
  try {
    assert.equal((await provider.refChecks("abc")).state, "failure");
    assert.equal((await provider.ciStatus("abc"))?.state, "failure");
  } finally {
    globalThis.fetch = original;
  }
});

test("an observed GitHub failure stays red when the bounded result is truncated", async () => {
  const provider = githubProvider(
    { host: "github.com", owner: "acme", repo: "repo" },
    { token: "t", apiBaseUrl: "https://api.github.com" },
  );
  await withRecordedFetch(
    (request) =>
      request.path.endsWith("/check-runs")
        ? {
            total_count: 150,
            check_runs: [
              {
                name: "test",
                status: "completed",
                conclusion: "failure",
              },
            ],
          }
        : { total_count: 0, statuses: [] },
    async () => {
      assert.equal((await provider.refChecks("abc")).state, "failure");
      assert.equal((await provider.ciStatus("abc"))?.state, "failure");
    },
  );
});

/* ---------------------------- mergeability detail --------------------------- */

// Forgejo has no "still computing" value: it answers `mergeable: false` for
// every work-in-progress pull request, whatever its base looks like. Reading a
// draft's `false` as a conflict paused a Workflow Run on a phantom base
// conflict (Task 535), so it travels as the unknown `null` instead.
test("a Forgejo draft's mergeability is unknown, not conflicting", async () => {
  const provider = forgejoProvider(
    { host: "git.example.com", owner: "acme", repo: "repo" },
    { baseUrl: "https://git.example.com", token: "t" },
  );
  const pull = {
    number: 7,
    state: "open",
    merged: false,
    mergeable: false,
    head: { ref: "feature", sha: "a".repeat(40) },
    base: { ref: "main" },
  };

  await withRecordedFetch(
    () => ({ ...pull, title: "WIP: Task-509" }),
    async () => {
      const detail = await provider.pullRequestDetail(7);
      assert.equal(detail?.draft, true);
      assert.equal(detail?.mergeable, null);
    },
  );
  await withRecordedFetch(
    () => ({ ...pull, title: "Task-509", draft: true }),
    async () => {
      assert.equal((await provider.pullRequestDetail(7))?.mergeable, null);
    },
  );
  // Once it is reviewable the same answer is the provider's real one.
  await withRecordedFetch(
    () => ({ ...pull, title: "Task-509" }),
    async () => {
      const detail = await provider.pullRequestDetail(7);
      assert.equal(detail?.draft, false);
      assert.equal(detail?.mergeable, false);
    },
  );
});

/* ------------------------------ merging a PR -------------------------------- */

interface RecordedRequest {
  method: string;
  path: string;
  body: unknown;
  /** Flattened query string; paging tests read `page`/`state` off it. */
  query: Record<string, string>;
}

/** Drive a real provider against a stubbed hosting API, recording every call. */
async function withRecordedFetch(
  respond: (req: RecordedRequest) => unknown,
  run: () => Promise<void>,
): Promise<RecordedRequest[]> {
  const calls: RecordedRequest[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ) => {
    const url = new URL(String(input));
    const call: RecordedRequest = {
      method: init?.method ?? "GET",
      path: url.pathname,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
      query: Object.fromEntries(url.searchParams),
    };
    calls.push(call);
    return new Response(JSON.stringify(respond(call) ?? {}), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  try {
    await run();
  } finally {
    globalThis.fetch = original;
  }
  return calls;
}

// Deleting the remote branch is part of MERGING, not a second step callers
// orchestrate — so each provider must do both from one seam call, in the way
// its own API expects.
test("GitHub merges with the chosen method and then deletes the head ref", async () => {
  const provider = githubProvider(
    { host: "github.com", owner: "acme", repo: "repo" },
    { token: "t", apiBaseUrl: "https://api.github.com" },
  );
  let result: PullRequestMergeResult | undefined;
  const calls = await withRecordedFetch(
    (req) =>
      req.method === "GET"
        ? { number: 7, head: { ref: "feature" }, base: { ref: "main" } }
        : { merged: true },
    async () => {
      result = await provider.mergePullRequest(7, {
        method: "squash",
        deleteBranch: true,
        expectedHeadSha: "reviewed-head",
      });
    },
  );

  assert.deepEqual(
    calls.map((call) => `${call.method} ${call.path}`),
    [
      "GET /repos/acme/repo/pulls/7",
      "PUT /repos/acme/repo/pulls/7/merge",
      "DELETE /repos/acme/repo/git/refs/heads/feature",
    ],
  );
  assert.deepEqual(calls[1]!.body, {
    merge_method: "squash",
    sha: "reviewed-head",
  });
  assert.equal(result?.branchDeleted, true);
});

// The merge already landed by the time the ref is deleted, so a refused
// deletion (protected branch, someone else got there first) must not be
// reported as a failed merge.
test("a GitHub branch deletion that fails still reports a merged pull request", async () => {
  const provider = githubProvider(
    { host: "github.com", owner: "acme", repo: "repo" },
    { token: "t", apiBaseUrl: "https://api.github.com" },
  );
  const original = globalThis.fetch;
  globalThis.fetch = (async (
    _input: string | URL | Request,
    init?: RequestInit,
  ) => {
    const method = init?.method ?? "GET";
    if (method === "DELETE")
      return new Response(JSON.stringify({ message: "protected" }), {
        status: 422,
      });
    return new Response(
      JSON.stringify(
        method === "GET"
          ? { number: 7, head: { ref: "feature", sha: "head-1" } }
          : {},
      ),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;
  try {
    const result = await provider.mergePullRequest(7, {
      method: "merge",
      deleteBranch: true,
    });
    assert.equal(result.branchDeleted, false);
    assert.match(result.branchDeleteError ?? "", /422/);
  } finally {
    globalThis.fetch = original;
  }
});

test("Forgejo merges and deletes the branch in the same request", async () => {
  const provider = forgejoProvider(
    { host: "git.example.com", owner: "acme", repo: "repo" },
    { baseUrl: "https://git.example.com", token: "t" },
  );
  let result: PullRequestMergeResult | undefined;
  const original = globalThis.fetch;
  const paths: string[] = [];
  let mergeBody: unknown;
  globalThis.fetch = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ) => {
    const url = new URL(String(input));
    paths.push(`${init?.method ?? "GET"} ${url.pathname}`);
    if (url.pathname.endsWith("/merge")) {
      mergeBody = JSON.parse(String(init?.body));
      return new Response("{}", { status: 200 });
    }
    // The branch read is the deletion CHECK: 404 = it is really gone.
    if (url.pathname.includes("/branches/"))
      return new Response(JSON.stringify({ message: "not found" }), {
        status: 404,
      });
    return new Response(
      JSON.stringify({ number: 7, head: { ref: "feature", sha: "head-1" } }),
      {
        status: 200,
        headers: { "content-type": "application/json" },
      },
    );
  }) as typeof fetch;
  try {
    result = await provider.mergePullRequest(7, {
      method: "rebase",
      deleteBranch: true,
      expectedHeadSha: "reviewed-head",
    });
  } finally {
    globalThis.fetch = original;
  }

  // The caller named no branch, so the pull request is read ONCE — before the
  // merge, where it also binds the target — and the branch it reported is what
  // the deletion is confirmed against afterwards.
  assert.deepEqual(paths, [
    "GET /api/v1/repos/acme/repo/pulls/7",
    "POST /api/v1/repos/acme/repo/pulls/7/merge",
    "GET /api/v1/repos/acme/repo/branches/feature",
  ]);
  assert.deepEqual(mergeBody, {
    Do: "rebase",
    delete_branch_after_merge: true,
    head_commit_id: "reviewed-head",
  });
  assert.equal(result?.branchDeleted, true);
});

// Forgejo answers a merge the same way whether or not the head branch survived
// it, so a protected branch must not be reported to the user as deleted.
test("a Forgejo head branch that survived the merge is not reported as deleted", async () => {
  const provider = forgejoProvider(
    { host: "git.example.com", owner: "acme", repo: "repo" },
    { baseUrl: "https://git.example.com", token: "t" },
  );
  // Every read succeeds, the branch read included: it is still there.
  let result: PullRequestMergeResult | undefined;
  await withRecordedFetch(
    (req) =>
      req.path.includes("/branches/")
        ? { name: "feature" }
        : { number: 7, head: { ref: "feature", sha: "head-1" } },
    async () => {
      result = await provider.mergePullRequest(7, {
        method: "squash",
        deleteBranch: true,
      });
    },
  );

  assert.equal(result?.branchDeleted, false);
  assert.match(result?.branchDeleteError ?? "", /still exists/);
});

// A check that could not be COMPLETED is not evidence that the branch is gone:
// only a 404 is. An unauthorized/500/timeout answer must report the deletion as
// unconfirmed rather than inventing the outcome it was asked for.
test("an unreadable Forgejo branch check reports the deletion as unconfirmed", async () => {
  const provider = forgejoProvider(
    { host: "git.example.com", owner: "acme", repo: "repo" },
    { baseUrl: "https://git.example.com", token: "t" },
  );
  const original = globalThis.fetch;
  globalThis.fetch = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ) => {
    const url = new URL(String(input));
    if ((init?.method ?? "GET") === "POST")
      return new Response("{}", { status: 200 });
    if (url.pathname.includes("/branches/"))
      return new Response(JSON.stringify({ message: "boom" }), { status: 500 });
    return new Response(
      JSON.stringify({ number: 7, head: { ref: "feature", sha: "head-1" } }),
      {
        status: 200,
        headers: { "content-type": "application/json" },
      },
    );
  }) as typeof fetch;
  try {
    const result = await provider.mergePullRequest(7, {
      method: "squash",
      deleteBranch: true,
    });
    assert.equal(result.branchDeleted, false);
    assert.match(result.branchDeleteError ?? "", /could not be confirmed/);
    assert.match(result.branchDeleteError ?? "", /500/);
  } finally {
    globalThis.fetch = original;
  }
});

// Same rule one step earlier, and stricter than it used to be: a caller that
// proved nothing needs this read to state the head the merge is conditioned on
// and the base it decided for, so a pull request that cannot be read now
// refuses the merge rather than merging blind and reporting the deletion as
// unconfirmed afterwards.
test("an unreadable Forgejo pull request refuses the merge", async () => {
  const provider = forgejoProvider(
    { host: "git.example.com", owner: "acme", repo: "repo" },
    { baseUrl: "https://git.example.com", token: "t" },
  );
  const original = globalThis.fetch;
  globalThis.fetch = (async (
    _input: string | URL | Request,
    init?: RequestInit,
  ) =>
    (init?.method ?? "GET") === "POST"
      ? new Response("{}", { status: 200 })
      : new Response(JSON.stringify({ message: "nope" }), {
          status: 401,
        })) as typeof fetch;
  try {
    await assert.rejects(
      provider.mergePullRequest(7, {
        method: "squash",
        deleteBranch: true,
        expectedBaseBranch: "main",
      }),
      /401/,
    );
  } finally {
    globalThis.fetch = original;
  }
});

// A provider refusal is the authority on whether a merge is allowed; it must
// reach the caller as an error rather than as a quiet "not merged".
test("a provider refusal to merge throws with its own message", async () => {
  const provider = forgejoProvider(
    { host: "git.example.com", owner: "acme", repo: "repo" },
    { baseUrl: "https://git.example.com", token: "t" },
  );
  const original = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ message: "Please resolve the conflicts" }), {
      status: 405,
    })) as typeof fetch;
  try {
    await assert.rejects(
      provider.mergePullRequest(7, { method: "squash", deleteBranch: true }),
      /resolve the conflicts/,
    );
  } finally {
    globalThis.fetch = original;
  }
});

test("Forgejo refuses to merge without a configured token", async () => {
  const provider = forgejoProvider(
    { host: "git.example.com", owner: "acme", repo: "repo" },
    { baseUrl: "https://git.example.com", token: "" },
  );
  await assert.rejects(
    provider.mergePullRequest(7, { method: "squash" }),
    /access token/i,
  );
});

/* ------------------------ repository capabilities --------------------------- */

const GITHUB_REF = {
  host: "github.com",
  owner: "acme",
  repo: "repo",
} as const;
const FORGEJO_REF = {
  host: "git.example.com",
  owner: "acme",
  repo: "repo",
} as const;

function githubTestProvider() {
  return githubProvider(GITHUB_REF, {
    token: "t",
    apiBaseUrl: "https://api.github.com",
  });
}

function forgejoTestProvider(token = "t") {
  return forgejoProvider(FORGEJO_REF, {
    baseUrl: "https://git.example.com",
    token,
  });
}

// The methods are the REPOSITORY's, never a global assumption: a repository
// that turned squashing off must not be offered a squash merge.
test("GitHub capabilities come from repository merge settings", async () => {
  const provider = githubTestProvider();
  let capabilities;
  await withRecordedFetch(
    () => ({
      default_branch: "trunk",
      allow_squash_merge: false,
      allow_merge_commit: true,
      allow_rebase_merge: true,
      delete_branch_on_merge: true,
    }),
    async () => {
      capabilities = await provider.repositoryCapabilities();
    },
  );
  assert.deepEqual(capabilities, {
    defaultBranch: "trunk",
    mergeMethods: ["merge", "rebase"],
    canClose: true,
    canDeleteBranchOnMerge: true,
    deleteBranchOnMergeDefault: true,
  });
});

// Forgejo spells every flag differently and names its own default style; the
// mapping is verified against the configured API, not GitHub's field names.
test("Forgejo capabilities use its own repository flags and default style", async () => {
  const provider = forgejoTestProvider();
  let capabilities;
  await withRecordedFetch(
    () => ({
      default_branch: "main",
      allow_merge_commits: true,
      allow_squash_merge: true,
      // Forgejo's rebase-then-merge-commit style has no word in the shared
      // three-method vocabulary and must not enable `rebase`.
      allow_rebase: false,
      allow_rebase_explicit: true,
      default_merge_style: "squash",
      default_delete_branch_after_merge: true,
    }),
    async () => {
      capabilities = await provider.repositoryCapabilities();
    },
  );
  assert.deepEqual(capabilities, {
    defaultBranch: "main",
    mergeMethods: ["squash", "merge"],
    defaultMergeMethod: "squash",
    canClose: true,
    canDeleteBranchOnMerge: true,
    deleteBranchOnMergeDefault: true,
  });
});

// A style outside the shared vocabulary is reported as no default at all,
// rather than being rounded to a method the caller did not ask for.
test("a Forgejo default merge style outside the vocabulary reports none", async () => {
  const provider = forgejoTestProvider();
  let capabilities;
  await withRecordedFetch(
    () => ({
      default_branch: "main",
      allow_merge_commits: true,
      allow_squash_merge: false,
      allow_rebase: false,
      default_merge_style: "fast-forward-only",
    }),
    async () => {
      capabilities = await provider.repositoryCapabilities();
    },
  );
  assert.deepEqual(capabilities, {
    defaultBranch: "main",
    mergeMethods: ["merge"],
    canClose: true,
    canDeleteBranchOnMerge: true,
  });
});

// An absent allow-flag is metadata we could not read, so it may neither enable
// nor silently disable a method: the whole set is unknown and merge fails
// closed on it, while closing and the default branch stay usable.
test("a merge flag the repository omitted leaves the methods unknown", async () => {
  let capabilities: PullRequestRepositoryCapabilities | undefined;
  for (const [providerName, build, payload] of [
    [
      "GitHub",
      githubTestProvider,
      { default_branch: "main", allow_squash_merge: true },
    ],
    [
      "Forgejo",
      forgejoTestProvider,
      { default_branch: "main", allow_squash_merge: true },
    ],
  ] as const) {
    await withRecordedFetch(
      () => payload,
      async () => {
        capabilities = await build().repositoryCapabilities();
      },
    );
    assert.equal(
      capabilities?.mergeMethods,
      undefined,
      `${providerName} must not report a method set from partial metadata`,
    );
    assert.match(capabilities?.unknownReason ?? "", /did not report/);
    assert.equal(capabilities?.defaultBranch, "main");
    assert.equal(capabilities?.canClose, true);
  }
});

// A repository whose default branch cannot be read is UNKNOWN, never `main`.
test("a repository without a reported default branch throws", async () => {
  const provider = githubTestProvider();
  await assert.rejects(
    withRecordedFetch(
      () => ({ allow_squash_merge: true }),
      async () => {
        await provider.repositoryCapabilities();
      },
    ),
    /default branch/i,
  );
});

/* -------------------------------- closing ----------------------------------- */

test("GitHub closes an open pull request at the exact head", async () => {
  const provider = githubTestProvider();
  let result;
  let reads = 0;
  const calls = await withRecordedFetch(
    (req) => {
      if (req.method === "PATCH") return { number: 7, state: "closed" };
      reads += 1;
      return {
        number: 7,
        state: reads === 1 ? "open" : "closed",
        head: { sha: "head-1" },
      };
    },
    async () => {
      result = await provider.closePullRequest(7, {
        expectedHeadSha: "head-1",
      });
    },
  );
  assert.deepEqual(
    calls.map((call) => `${call.method} ${call.path}`),
    [
      "GET /repos/acme/repo/pulls/7",
      "PATCH /repos/acme/repo/pulls/7",
      "GET /repos/acme/repo/pulls/7",
    ],
  );
  assert.deepEqual(calls[1]!.body, { state: "closed" });
  assert.deepEqual(result, { number: 7, closed: true, headSha: "head-1" });
});

// The pre-read IS the head precondition: neither backend offers one, so a head
// that moved must refuse BEFORE the write.
test("a moved head refuses the close without writing", async () => {
  const provider = githubTestProvider();
  const calls = await withRecordedFetch(
    () => ({ number: 7, state: "open", head: { sha: "head-2" } }),
    async () => {
      await assert.rejects(
        provider.closePullRequest(7, { expectedHeadSha: "head-1" }),
        /head moved from head-1 to head-2/,
      );
    },
  );
  assert.deepEqual(
    calls.map((call) => call.method),
    ["GET"],
  );
});

test("a head move between close write and confirmation is an honest partial", async () => {
  const provider = githubTestProvider();
  let reads = 0;
  let result: PullRequestCloseResult | undefined;
  await withRecordedFetch(
    (req) => {
      if (req.method === "PATCH") return { number: 7, state: "closed" };
      reads += 1;
      return {
        number: 7,
        state: reads === 1 ? "open" : "closed",
        head: { sha: reads === 1 ? "head-1" : "head-2" },
      };
    },
    async () => {
      result = await provider.closePullRequest(7, {
        expectedHeadSha: "head-1",
      });
    },
  );
  assert.equal(result?.closed, false);
  assert.match(
    result?.unconfirmedReason ?? "",
    /head moved from head-1 to head-2/,
  );
});

test("a merged pull request is never closed", async () => {
  const provider = githubTestProvider();
  await withRecordedFetch(
    () => ({ number: 7, state: "closed", merged: true, head: { sha: "h" } }),
    async () => {
      await assert.rejects(
        provider.closePullRequest(7, { expectedHeadSha: "h" }),
        /already merged/,
      );
    },
  );
});

// A landed write whose confirmation failed is a PARTIAL, not a success claim.
test("Forgejo reports an unconfirmed close honestly", async () => {
  const provider = forgejoTestProvider();
  let seen = 0;
  const original = globalThis.fetch;
  globalThis.fetch = (async (
    _input: string | URL | Request,
    init?: RequestInit,
  ) => {
    const method = init?.method ?? "GET";
    if (method === "PATCH")
      return new Response(JSON.stringify({}), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    seen += 1;
    if (seen > 1) return new Response("nope", { status: 500 });
    return new Response(
      JSON.stringify({ number: 7, state: "open", head: { sha: "h" } }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;
  try {
    const result = await provider.closePullRequest(7, { expectedHeadSha: "h" });
    assert.equal(result.closed, false);
    assert.match(result.unconfirmedReason ?? "", /could not be confirmed/);
  } finally {
    globalThis.fetch = original;
  }
});

test("Forgejo refuses to close without a configured token", async () => {
  const provider = forgejoTestProvider("");
  await assert.rejects(
    provider.closePullRequest(7, { expectedHeadSha: "h" }),
    /access token/i,
  );
});

/* --------------------- the capability cache and its reset ------------------- */

test("capability reads are cached and coalesced per repository", async () => {
  let reads = 0;
  const provider = {
    ...githubTestProvider(),
    repositoryCapabilities: async () => {
      reads += 1;
      await new Promise((resolve) => setTimeout(resolve, 1));
      return { defaultBranch: "main", mergeMethods: ["squash" as const] };
    },
  };
  try {
    // Two callers at once share ONE conversation with the provider…
    const [first, second] = await Promise.all([
      repositoryCapabilitiesFor(provider),
      repositoryCapabilitiesFor(provider),
    ]);
    assert.deepEqual(first, second);
    // …and a later caller is served from the cache.
    await repositoryCapabilitiesFor(provider);
    assert.equal(reads, 1);
    // Invalidation is what makes a settings change visible before the TTL.
    invalidateRepositoryCapabilities(provider);
    await repositoryCapabilitiesFor(provider);
    assert.equal(reads, 2);
  } finally {
    invalidateRepositoryCapabilities();
  }
});

// A failed read is unknown-with-a-reason and is never cached: the next caller
// may well get a real answer, and unknown already fails every consumer closed.
test("a failed capability read is unknown and not cached", async () => {
  let reads = 0;
  const provider = {
    ...githubTestProvider(),
    repositoryCapabilities: async () => {
      reads += 1;
      throw new Error("repository settings unavailable");
    },
  };
  try {
    const capabilities = await repositoryCapabilitiesFor(provider);
    assert.equal(capabilities.mergeMethods, undefined);
    assert.equal(capabilities.defaultBranch, undefined);
    assert.match(capabilities.unknownReason ?? "", /settings unavailable/);
    await repositoryCapabilitiesFor(provider);
    assert.equal(reads, 2);
  } finally {
    invalidateRepositoryCapabilities();
  }
});

/* ---------------- proving how many open pull requests a branch has ---------- */

/** What the multiplicity read answers, named for the assertions below. */
type BranchPullRequestsForTest = Awaited<
  ReturnType<GitHostingProvider["findPullRequestsForBranch"]>
>;

function githubOpenPull(number: number, headBranch = "feature") {
  return {
    number,
    title: `PR ${number}`,
    html_url: `https://github.com/acme/repo/pull/${number}`,
    state: "open",
    head: { ref: headBranch, sha: "h", repo: { full_name: "acme/repo" } },
    base: { ref: "main" },
  };
}

function forgejoOpenPull(number: number, headBranch = "feature") {
  return {
    number,
    title: `PR ${number}`,
    html_url: `https://git.example.com/acme/repo/pulls/${number}`,
    state: "open",
    merged: false,
    head: { ref: headBranch, sha: "h", repo: { full_name: "acme/repo" } },
    base: { ref: "main" },
  };
}

// "Exactly one open pull request" is only a real invariant if the read can see
// past its first page: a second stale open PR sitting on page two used to be
// invisible, and managed delivery would then merge one of two as if it were the
// only one.
test("GitHub pages open pull requests until the provider is exhausted", async () => {
  const provider = githubTestProvider();
  let result: BranchPullRequestsForTest | undefined;
  const calls = await withRecordedFetch(
    (req) =>
      req.query.page === "1"
        ? Array.from({ length: 100 }, (_, index) => githubOpenPull(index + 1))
        : [githubOpenPull(999)],
    async () => {
      result = await provider.findPullRequestsForBranch("feature");
    },
  );
  assert.equal(result?.open.length, 101);
  assert.ok(
    result?.open.some((pull) => pull.number === 999),
    "the pull request beyond the first page must be seen",
  );
  assert.deepEqual(
    calls.map((call) => [call.query.state, call.query.page]),
    [
      ["open", "1"],
      ["open", "2"],
    ],
  );
});

test("Forgejo pages open pull requests until the provider is exhausted", async () => {
  const provider = forgejoTestProvider();
  let result: BranchPullRequestsForTest | undefined;
  const calls = await withRecordedFetch(
    (req) =>
      req.query.page === "1"
        ? Array.from({ length: 50 }, (_, index) => forgejoOpenPull(index + 1))
        : [forgejoOpenPull(999)],
    async () => {
      result = await provider.findPullRequestsForBranch("feature");
    },
  );
  assert.equal(result?.open.length, 51);
  assert.deepEqual(
    calls.map((call) => call.query.page),
    ["1", "2"],
  );
});

// A read that cannot be exhausted proves nothing, so it says so instead of
// answering with whatever it happened to see.
test("an unexhausted open-pull-request read refuses to answer", async () => {
  const provider = githubTestProvider();
  await assert.rejects(
    withRecordedFetch(
      () =>
        Array.from({ length: 100 }, (_, index) => githubOpenPull(index + 1)),
      async () => {
        await provider.findPullRequestsForBranch("feature");
      },
    ),
    /could not be established/,
  );
});

// The terminal read exists to say "already merged" instead of "no pull
// request", and costs a request only when nothing is open.
test("a branch with nothing open reports its newest terminal pull request", async () => {
  const provider = githubTestProvider();
  let result: BranchPullRequestsForTest | undefined;
  const calls = await withRecordedFetch(
    (req) =>
      req.query.state === "open"
        ? []
        : [
            {
              ...githubOpenPull(7),
              state: "closed",
              merged: true,
              merged_at: "2026-08-01T00:00:00Z",
            },
          ],
    async () => {
      result = await provider.findPullRequestsForBranch("feature");
    },
  );
  assert.deepEqual(result?.open, []);
  assert.equal(result?.latestTerminal?.number, 7);
  assert.equal(result?.latestTerminal?.state, "merged");
  assert.deepEqual(
    calls.map((call) => call.query.state),
    ["open", "all"],
  );
});

// Both providers list pull requests opened FROM FORKS beside their own, and a
// fork may carry a branch of exactly this name. The head repository is what
// tells them apart; a head repository that cannot be read proves nothing.
test("a fork's identically named branch is never this branch", async () => {
  const forkPull = {
    ...githubOpenPull(8),
    head: { ref: "feature", sha: "h", repo: { full_name: "someone/fork" } },
  };
  const deletedForkPull = {
    ...githubOpenPull(9),
    head: { ref: "feature", sha: "h", repo: null },
  };
  const provider = githubTestProvider();
  let multiplicity: BranchPullRequestsForTest | undefined;
  let tolerant: WorktreePullRequestInfo | null | undefined;
  await withRecordedFetch(
    () => [forkPull, deletedForkPull, githubOpenPull(10)],
    async () => {
      multiplicity = await provider.findPullRequestsForBranch("feature");
      tolerant = await provider.findPullRequestForBranch("feature");
    },
  );
  assert.deepEqual(
    multiplicity?.open.map((pull) => pull.number),
    [10],
  );
  assert.equal(tolerant?.number, 10);
});

test("Forgejo also refuses a fork pull request as the branch's own", async () => {
  const provider = forgejoTestProvider();
  let multiplicity: BranchPullRequestsForTest | undefined;
  let tolerant: WorktreePullRequestInfo | null | undefined;
  await withRecordedFetch(
    () => [
      {
        ...forgejoOpenPull(8),
        head: { ref: "feature", sha: "h", repo: { full_name: "someone/fork" } },
      },
      forgejoOpenPull(10),
      // Another branch of this repository must not be counted either.
      forgejoOpenPull(11, "other-branch"),
    ],
    async () => {
      multiplicity = await provider.findPullRequestsForBranch("feature");
      tolerant = await provider.findPullRequestForBranch("feature");
    },
  );
  assert.deepEqual(
    multiplicity?.open.map((pull) => pull.number),
    [10],
  );
  assert.equal(tolerant?.number, 10);
});

// A body that is not a list was not UNDERSTOOD, and that is not the same as
// "there are none". Ending a paged read on one would leave a first-page match
// looking like the proven only open pull request while the rest went unread —
// the truncation hole again, wearing a different hat.
test("a malformed page refuses the open-pull-request read", async () => {
  const provider = githubTestProvider();
  await assert.rejects(
    withRecordedFetch(
      (req) =>
        req.query.page === "1"
          ? Array.from({ length: 100 }, (_, index) => githubOpenPull(index + 1))
          : { message: "server error" },
      async () => {
        await provider.findPullRequestsForBranch("feature");
      },
    ),
    /shape this app does not understand/,
  );
});

test("Forgejo refuses a malformed page the same way", async () => {
  const provider = forgejoTestProvider();
  await assert.rejects(
    withRecordedFetch(
      (req) =>
        req.query.page === "1"
          ? Array.from({ length: 50 }, (_, index) => forgejoOpenPull(index + 1))
          : { message: "server error" },
      async () => {
        await provider.findPullRequestsForBranch("feature");
      },
    ),
    /shape this app does not understand/,
  );
});

// The tolerant lookup answers `null` for "this branch has no pull request", so
// it may not answer that for a response it could not read either.
test("a malformed list is not reported as a branch without pull requests", async () => {
  for (const provider of [githubTestProvider(), forgejoTestProvider()])
    await assert.rejects(
      withRecordedFetch(
        () => ({ message: "server error" }),
        async () => {
          await provider.findPullRequestForBranch("feature");
        },
      ),
      /shape this app does not understand/,
    );
});

// Dropping the settled cache is not enough to obsolete a read: a request that
// started BEFORE the invalidation describes the world from before it. A forced
// caller must neither join that request nor be handed the answer it leaves
// behind.
test("a forced capability read never adopts work started before it", async () => {
  const provider = githubTestProvider();
  let started = 0;
  let release = () => {};
  const capabilities: PullRequestRepositoryCapabilities[] = [
    { defaultBranch: "main", mergeMethods: ["squash", "merge"] },
    { defaultBranch: "main", mergeMethods: ["merge"] },
  ];
  const hooked = {
    ...provider,
    repositoryCapabilities: async () => {
      const answer = capabilities[Math.min(started, capabilities.length - 1)]!;
      started += 1;
      // The first read hangs until the test lets it finish, so the forced read
      // below overlaps it exactly the way a merge overlaps a UI poll.
      if (started === 1)
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      return answer;
    },
  };
  try {
    const stale = repositoryCapabilitiesFor(hooked);
    // Let that read actually reach the provider before anything moves.
    while (started === 0)
      await new Promise((resolve) => setTimeout(resolve, 0));
    // Settings changed (or a merge took the lock) while that read was in flight.
    invalidateRepositoryCapabilities(hooked);
    const forced = repositoryCapabilitiesFor(hooked, { fresh: true });
    release();

    assert.deepEqual((await stale).mergeMethods, ["squash", "merge"]);
    assert.deepEqual(
      (await forced).mergeMethods,
      ["merge"],
      "the forced read must not be answered by the older request",
    );
    assert.equal(started, 2);
    // The pre-invalidation answer must not be left behind as the current one.
    assert.deepEqual((await repositoryCapabilitiesFor(hooked)).mergeMethods, [
      "merge",
    ]);
  } finally {
    release();
    invalidateRepositoryCapabilities();
  }
});

// Two forced reads are each their own generation: neither may be served the
// other's answer, since each is about to act on it.
test("a forced read is never served from the cache", async () => {
  const provider = githubTestProvider();
  let reads = 0;
  const hooked = {
    ...provider,
    repositoryCapabilities: async () => {
      reads += 1;
      return { defaultBranch: "main", mergeMethods: ["squash" as const] };
    },
  };
  try {
    await repositoryCapabilitiesFor(hooked, { fresh: true });
    await repositoryCapabilitiesFor(hooked, { fresh: true });
    assert.equal(reads, 2);
    // An ordinary caller still coalesces onto the newest settled answer.
    await repositoryCapabilitiesFor(hooked);
    assert.equal(reads, 2);
  } finally {
    invalidateRepositoryCapabilities();
  }
});

/* ------------- what the REAL provider does between check and merge --------- */

// The merge seam proves the pull request's identity and then calls the
// provider. If the provider reads the pull request AGAIN before its merge — as
// GitHub did, only to learn which ref to delete — that read is a round trip the
// seam's check no longer covers: a retarget inside it keeps the expected head,
// so the merge's `sha` precondition still passes while the merge lands on
// another base. A caller that already proved the branch therefore hands it over
// and the provider reads nothing.
test("GitHub merges with no read between the caller's check and the merge", async () => {
  const provider = githubTestProvider();
  let result: PullRequestMergeResult | undefined;
  const calls = await withRecordedFetch(
    () => ({ merged: true }),
    async () => {
      result = await provider.mergePullRequest(7, {
        method: "squash",
        deleteBranch: true,
        expectedHeadSha: "reviewed-head",
        headBranch: "feature",
        expectedBaseBranch: "release-2",
      });
    },
  );

  assert.deepEqual(
    calls.map((call) => `${call.method} ${call.path}`),
    [
      "PUT /repos/acme/repo/pulls/7/merge",
      "DELETE /repos/acme/repo/git/refs/heads/feature",
    ],
    "the pre-merge GET is gone once the caller proved the head branch",
  );
  assert.deepEqual(calls[0]!.body, {
    merge_method: "squash",
    sha: "reviewed-head",
  });
  assert.equal(result?.branchDeleted, true);
});

// A caller that could NOT prove the branch still pays for the provider's read —
// and that read is then the last chance to notice a retarget, because no merge
// API offers a base precondition.
test("a fallback pre-merge read refuses a pull request that moved base", async () => {
  const provider = githubTestProvider();
  const calls = await withRecordedFetch(
    (req) =>
      req.method === "GET"
        ? { number: 7, head: { ref: "feature" }, base: { ref: "main" } }
        : { merged: true },
    async () => {
      await assert.rejects(
        provider.mergePullRequest(7, {
          method: "squash",
          deleteBranch: true,
          expectedHeadSha: "reviewed-head",
          expectedBaseBranch: "release-2",
        }),
        /now targets main, not the release-2 this merge was decided for/,
      );
    },
  );
  assert.deepEqual(
    calls.map((call) => call.method),
    ["GET"],
    "nothing is merged after that read contradicts the decision",
  );
});

// Forgejo merges and deletes in ONE request, so it never had the gap — but the
// branch it confirms afterwards is the one the caller proved, which spares the
// extra pull-request read.
test("Forgejo confirms the caller's branch without re-reading the pull request", async () => {
  const provider = forgejoTestProvider();
  const original = globalThis.fetch;
  const calls: string[] = [];
  globalThis.fetch = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ) => {
    const url = new URL(String(input));
    calls.push(`${init?.method ?? "GET"} ${url.pathname}`);
    // The branch is gone after the merge: a 404 is the only proof of deletion.
    if (url.pathname.includes("/branches/"))
      return new Response("{}", { status: 404 });
    return new Response(JSON.stringify({}), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  try {
    const result = await provider.mergePullRequest(7, {
      method: "squash",
      deleteBranch: true,
      expectedHeadSha: "reviewed-head",
      headBranch: "feature",
      expectedBaseBranch: "main",
    });
    assert.deepEqual(calls, [
      "POST /api/v1/repos/acme/repo/pulls/7/merge",
      "GET /api/v1/repos/acme/repo/branches/feature",
    ]);
    assert.equal(result.branchDeleted, true);
  } finally {
    globalThis.fetch = original;
  }
});

/* ---------- what an UNPROVEN caller still gets bound to, everywhere --------- */

// The degraded path is the human click whose provider could not be re-read by
// the seam. It proves nothing, so the provider's own read has to carry both
// bindings — and it must happen whatever the delete choice is, on both
// providers. A GitHub keep-branch click used to skip that read entirely.
for (const deleteBranch of [true, false])
  test(`GitHub binds the decided base for an unproven ${deleteBranch ? "delete" : "keep"}-branch merge`, async () => {
    const provider = githubTestProvider();
    const calls = await withRecordedFetch(
      (req) =>
        req.method === "GET"
          ? {
              number: 7,
              head: { ref: "feature", sha: "head-1" },
              // Retargeted since the click: the head never moved.
              base: { ref: "main" },
            }
          : { merged: true },
      async () => {
        await assert.rejects(
          provider.mergePullRequest(7, {
            method: "squash",
            deleteBranch,
            expectedBaseBranch: "release-2",
          }),
          /now targets main, not the release-2 this merge was decided for/,
        );
      },
    );
    assert.deepEqual(
      calls.map((call) => call.method),
      ["GET"],
      "nothing may be merged after that read contradicts the decision",
    );
  });

for (const deleteBranch of [true, false])
  test(`Forgejo binds the decided base for an unproven ${deleteBranch ? "delete" : "keep"}-branch merge`, async () => {
    const provider = forgejoTestProvider();
    const calls = await withRecordedFetch(
      () => ({
        number: 7,
        head: { ref: "feature", sha: "head-1" },
        base: { ref: "main" },
      }),
      async () => {
        await assert.rejects(
          provider.mergePullRequest(7, {
            method: "squash",
            deleteBranch,
            expectedBaseBranch: "release-2",
          }),
          /now targets main, not the release-2 this merge was decided for/,
        );
      },
    );
    assert.deepEqual(
      calls.map((call) => call.method),
      ["GET"],
      "Forgejo used to POST the merge without ever asking",
    );
  });

// Every merge carries a head precondition, including one the caller could not
// state: the read that binds the base supplies it, so a push landing between
// that read and the merge is refused by the provider itself rather than merged.
test("an unproven merge is still conditioned on the head it read", async () => {
  for (const [name, provider, headField] of [
    ["GitHub", githubTestProvider(), "sha"],
    ["Forgejo", forgejoTestProvider(), "head_commit_id"],
  ] as const) {
    let mergeBody: Record<string, unknown> | undefined;
    await withRecordedFetch(
      (req) => {
        if (req.method === "GET")
          return {
            number: 7,
            head: { ref: "feature", sha: "read-head" },
            base: { ref: "main" },
          };
        mergeBody = req.body as Record<string, unknown>;
        return { merged: true };
      },
      async () => {
        await provider.mergePullRequest(7, {
          method: "squash",
          deleteBranch: false,
          expectedBaseBranch: "main",
        });
      },
    );
    assert.equal(mergeBody?.[headField], "read-head", name);
  }
});

// A pull request without a head commit cannot be merged safely at all: there is
// nothing to condition the merge on, and inventing "merge whatever is there" is
// the window this exists to close.
test("a pull request with no head commit refuses the merge", async () => {
  const provider = githubTestProvider();
  await withRecordedFetch(
    () => ({ number: 7, head: { ref: "feature" }, base: { ref: "main" } }),
    async () => {
      await assert.rejects(
        provider.mergePullRequest(7, {
          method: "squash",
          deleteBranch: true,
          expectedBaseBranch: "main",
        }),
        /reports no head commit/,
      );
    },
  );
});
