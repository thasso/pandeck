/**
 * Closing a pull request without merging is an outward transition of the SAME
 * object as merging, so it shares the identity lock and the card projection —
 * and differs in everything that only a merge may do: no Task suggestion, no
 * branch deletion, no merge recorded anywhere.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "vitest";
import type { PullRequestCloseResult } from "@assistant/shared";
import type { GitHostingProvider } from "./gitHosting.ts";
import {
  beginPullRequestCardObservation,
  createPullRequestCard,
  patchPullRequestCardObservation,
  pullRequestCardById,
  resetPullRequestCardsStoreForTests,
} from "./pullRequestCards.ts";
import { closePullRequestAndProject } from "./pullRequestClose.ts";
import {
  resetPullRequestMutationsForTests,
  withPullRequestMutation,
} from "./pullRequestMerge.ts";
import { createTask, deleteTask, readTask } from "./tasks.ts";
import { resetWorkflowStoreForTests } from "./db/workflowStore.ts";

const HEAD = "a".repeat(40);

function repo(): string {
  const path = mkdtempSync(join(tmpdir(), "pr-close-projection-"));
  execFileSync("git", ["init", "--initial-branch=main"], { cwd: path });
  return path;
}

function fakeProvider(
  patch: Partial<GitHostingProvider> = {},
  onClose: (options: { expectedHeadSha: string }) => void = () => undefined,
): GitHostingProvider {
  return {
    kind: "github",
    repoWebUrl: "https://github.com/acme/repo",
    findPullRequestForBranch: async () => null,
    findPullRequestsForBranch: async () => ({ open: [] }),
    createPullRequest: async () => {
      throw new Error("not used");
    },
    markPullRequestReady: async () => ({}),
    listOpenPullRequests: async () => [],
    ciStatus: async () => null,
    refChecks: async () => ({ state: "none", checks: [] }),
    pullRequestReview: async () => null,
    repositoryCapabilities: async () => ({
      defaultBranch: "main",
      mergeMethods: ["squash"],
      canClose: true,
    }),
    pullRequestDetail: async () => ({
      number: 42,
      state: "open" as const,
      merged: false,
      mergeable: true,
      draft: false,
      headSha: HEAD,
      headBranch: "feature",
      baseBranch: "main",
    }),
    mergePullRequest: async () => {
      throw new Error("a close must never merge");
    },
    closePullRequest: async (
      number,
      options,
    ): Promise<PullRequestCloseResult> => {
      onClose(options);
      return { number, closed: true, headSha: options.expectedHeadSha };
    },
    ...patch,
  };
}

function card(path: string, patch: Record<string, unknown> = {}) {
  return createPullRequestCard(
    {
      sessionId: "session-1",
      status: "open",
      title: "Add the finish tool",
      headBranch: "feature",
      baseBranch: "main",
      provider: "github",
      number: 42,
      ...patch,
    },
    {
      repoRoot: path,
      sessionKind: "developer",
      sessionId: "session-1",
      headBranch: "feature",
      baseBranch: "main",
      draft: false,
      observedHeadSha: HEAD,
    },
  );
}

afterEach(() => {
  resetPullRequestCardsStoreForTests();
  resetPullRequestMutationsForTests();
  resetWorkflowStoreForTests();
});

test("every live card for the pull request moves to closed with the reason", async () => {
  const path = repo();
  const first = card(path);
  const second = card(path, { sessionId: "session-2" });
  const stale = beginPullRequestCardObservation(first.id);
  let closedWith: string | undefined;

  const projection = await closePullRequestAndProject({
    provider: fakeProvider({}, (options) => {
      closedWith = options.expectedHeadSha;
    }),
    repoPath: join(path, "."),
    number: 42,
    headBranch: "feature",
    baseBranch: "main",
    expectedHeadSha: HEAD,
    reason: "superseded by a different approach",
  });

  assert.equal(closedWith, HEAD);
  assert.deepEqual(projection.cardIds.sort(), [first.id, second.id].sort());
  for (const id of [first.id, second.id]) {
    const after = pullRequestCardById(id)!;
    assert.equal(after.status, "closed");
    assert.match(
      after.actionMessage ?? "",
      /Closed #42 .* without merging: superseded by a different approach/,
    );
    assert.match(after.actionMessage ?? "", /remote branch feature .* kept/);
  }
  assert.equal(
    patchPullRequestCardObservation(
      first.id,
      stale,
      { status: "open" },
      { observedHeadSha: HEAD },
    ),
    undefined,
    "a poll started before the close cannot reopen the closed card",
  );
});

// Nothing landed, so nothing about the Task changed: an unmerged close must
// never propose it done.
test("a close never suggests the linked Task done", async () => {
  const path = repo();
  const task = createTask({
    title: "Abandoned work",
    source: { createdBy: "user" },
  });
  try {
    const created = card(path, {
      linkedTask: {
        id: task.id,
        title: task.title,
        status: task.status,
        source: { createdBy: "user" },
        createdAt: 1,
        updatedAt: 1,
      },
    });
    await closePullRequestAndProject({
      provider: fakeProvider(),
      repoPath: path,
      number: 42,
      headBranch: "feature",
      baseBranch: "main",
      expectedHeadSha: HEAD,
      reason: "wrong approach",
    });
    assert.equal(pullRequestCardById(created.id)?.status, "closed");
    const after = readTask(task.id)!;
    assert.equal(after.status, "todo");
    assert.equal(after.statusSuggestion, undefined);
  } finally {
    deleteTask(task.id);
  }
});

test("a same-numbered pull request in another repository is left alone", async () => {
  const mine = repo();
  const theirs = repo();
  const created = card(mine);
  const projection = await closePullRequestAndProject({
    provider: fakeProvider(),
    repoPath: theirs,
    number: 42,
    headBranch: "feature",
    baseBranch: "main",
    expectedHeadSha: HEAD,
    reason: "abandoned",
  });
  assert.deepEqual(projection.cardIds, []);
  assert.equal(pullRequestCardById(created.id)?.status, "open");
});

test("a moved head refuses before the provider is asked to close", async () => {
  const path = repo();
  let closes = 0;
  await assert.rejects(
    closePullRequestAndProject({
      provider: fakeProvider({}, () => {
        closes += 1;
      }),
      repoPath: path,
      number: 42,
      headBranch: "feature",
      baseBranch: "main",
      expectedHeadSha: "b".repeat(40),
      reason: "abandoned",
    }),
    /head moved/,
  );
  assert.equal(closes, 0);
});

test("a pull request that is no longer open refuses the close", async () => {
  const path = repo();
  await assert.rejects(
    closePullRequestAndProject({
      provider: fakeProvider({
        pullRequestDetail: async () => ({
          number: 42,
          state: "merged" as const,
          merged: true,
          mergeable: null,
          draft: false,
          headSha: HEAD,
          headBranch: "feature",
          baseBranch: "main",
        }),
      }),
      repoPath: path,
      number: 42,
      headBranch: "feature",
      baseBranch: "main",
      expectedHeadSha: HEAD,
      reason: "abandoned",
    }),
    /already merged/,
  );
});

// One outward transition at a time, across surfaces: the close takes the same
// identity lock a merge does.
test("a close is refused while another mutation owns the pull request", async () => {
  const path = repo();
  await withPullRequestMutation(
    { repoPath: path, providerKind: "github", number: 42 },
    "a merge",
    async () => {
      await assert.rejects(
        closePullRequestAndProject({
          provider: fakeProvider(),
          repoPath: path,
          number: 42,
          headBranch: "feature",
          baseBranch: "main",
          expectedHeadSha: HEAD,
          reason: "abandoned",
        }),
        /busy: a merge is running/,
      );
    },
  );
});

// A landed write whose confirmation failed is reported as what it is; the card
// still leaves `open`, and the watcher reconciles the rest.
test("an unconfirmed close is projected as an honest partial", async () => {
  const path = repo();
  const created = card(path);
  const projection = await closePullRequestAndProject({
    provider: fakeProvider({
      closePullRequest: async (number, options) => ({
        number,
        closed: false,
        headSha: options.expectedHeadSha,
        unconfirmedReason: "the close was sent but could not be confirmed.",
      }),
    }),
    repoPath: path,
    number: 42,
    headBranch: "feature",
    baseBranch: "main",
    expectedHeadSha: HEAD,
    reason: "abandoned",
  });
  assert.equal(projection.result.closed, false);
  assert.match(projection.message, /could not be confirmed/);
  const after = pullRequestCardById(created.id)!;
  assert.equal(after.status, "open");
  assert.match(after.actionMessage ?? "", /closure is unconfirmed/);
});
