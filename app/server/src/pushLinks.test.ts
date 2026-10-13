/**
 * Hosted links on a push card: the branch page per provider, the branch's pull
 * request when one exists, and the best-effort contract that a failed or slow
 * provider only drops links.
 *
 * Run: pnpm --filter @assistant/server test src/pushLinks.test.ts
 */
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "vitest";
import type { WorktreePullRequestInfo } from "@assistant/shared";
import type { GitHostingProvider } from "./gitHosting.ts";
import type { PushWorkflowResult } from "./pushWorkflow.ts";

process.env.ASSISTANT_CWD = mkdtempSync(join(tmpdir(), "push-links-test-"));

const { branchWebUrl, resolvePushLinks } = await import("./pushLinks.ts");

const pushed: PushWorkflowResult = {
  status: "pushed",
  repoRoot: "/repo",
  remote: "origin",
  branch: "HEAD",
  publishedBranch: "feature/retry",
  forced: false,
  setUpstream: false,
  output: "",
};

const openPull: WorktreePullRequestInfo = {
  number: 7,
  url: "https://github.com/acme/repo/pull/7",
  title: "Retry",
  state: "open",
};

function provider(
  findPullRequestForBranch: GitHostingProvider["findPullRequestForBranch"],
): GitHostingProvider {
  return {
    kind: "github",
    repoWebUrl: "https://github.com/acme/repo",
    findPullRequestForBranch,
  } as GitHostingProvider;
}

describe("branchWebUrl", () => {
  test("uses each provider's branch path and encodes ref segments", () => {
    assert.equal(
      branchWebUrl(
        { kind: "github", repoWebUrl: "https://github.com/acme/repo" },
        "feature/a#b",
      ),
      "https://github.com/acme/repo/tree/feature/a%23b",
    );
    assert.equal(
      branchWebUrl(
        { kind: "forgejo", repoWebUrl: "https://git.example.com/acme/repo" },
        "main",
      ),
      "https://git.example.com/acme/repo/src/branch/main",
    );
  });
});

describe("resolvePushLinks", () => {
  test("links the branch and its pull request", async () => {
    const asked: string[] = [];
    const links = await resolvePushLinks(pushed, {
      provider: async (repoRoot, remote) => {
        asked.push(`${repoRoot} ${remote}`);
        return provider(async () => openPull);
      },
    });
    assert.deepEqual(asked, ["/repo origin"]);
    assert.deepEqual(links, {
      provider: "github",
      branchUrl: "https://github.com/acme/repo/tree/feature/retry",
      pullRequest: openPull,
    });
  });

  test("a failed or slow pull-request read keeps the branch link", async () => {
    const failing = await resolvePushLinks(pushed, {
      provider: async () =>
        provider(async () => {
          throw new Error("rate limited");
        }),
    });
    assert.deepEqual(failing, {
      provider: "github",
      branchUrl: "https://github.com/acme/repo/tree/feature/retry",
    });
    const slow = await resolvePushLinks(pushed, {
      provider: async () => provider(() => new Promise(() => {})),
      timeoutMs: 5,
    });
    assert.equal(slow?.pullRequest, undefined);
  });

  test("no provider, a failed push, or no proven branch yields no links", async () => {
    assert.equal(
      await resolvePushLinks(pushed, { provider: async () => null }),
      undefined,
    );
    assert.equal(
      await resolvePushLinks(pushed, {
        provider: async () => {
          throw new Error("git failed");
        },
      }),
      undefined,
    );
    const unreachable = async () => {
      throw new Error("must not resolve a provider");
    };
    assert.equal(
      await resolvePushLinks(
        { ...pushed, status: "failed" },
        { provider: unreachable },
      ),
      undefined,
    );
    const { publishedBranch: _unproven, ...unpublished } = pushed;
    assert.equal(
      await resolvePushLinks(unpublished, { provider: unreachable }),
      undefined,
    );
  });
});
