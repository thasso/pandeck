/**
 * What a `/pr` card looks like when the merge LANDED but the projection's write
 * onto that card did not.
 *
 * Everything after the provider accepts is best-effort (`pullRequestMerge.ts`),
 * which is right — a failed card patch must never report a merged pull request
 * as unmerged — but it leaves two things that are not automatic: the projection
 * must not CLAIM a card it did not write, and the card action, which still has
 * that card in hand, must finish the job rather than clearing `busyAction` over
 * an open card that offers Merge again. A card deleted mid-merge cannot show
 * either: the card here SURVIVES and only its first write fails. Run:
 *   pnpm --filter @assistant/server test src/pullRequestCardMergeProjection.test.ts
 */
import assert from "node:assert/strict";
import { afterEach, test, vi } from "vitest";
import type {
  Patch,
  PullRequestCard,
  PullRequestMergeMethod,
} from "@assistant/shared";
import type { GitHostingProvider } from "./gitHosting.ts";

/**
 * The next write that moves a card to `merged` fails, once. That is precisely
 * the projection's own patch — a transient store failure, not a missing card —
 * and the recovery patch that follows it must go through.
 */
const hoisted = vi.hoisted(() => ({ failMergedWrite: false }));

vi.mock("./pullRequestCards.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./pullRequestCards.ts")>();
  return {
    ...actual,
    patchPullRequestCard: (
      id: string,
      patch: Patch<PullRequestCard>,
      contextPatch?: Parameters<typeof actual.patchPullRequestCard>[2],
    ) => {
      if (hoisted.failMergedWrite && patch.status === "merged") {
        hoisted.failMergedWrite = false;
        throw new Error("the card store is temporarily unavailable");
      }
      return actual.patchPullRequestCard(id, patch, contextPatch);
    },
  };
});

const {
  createPullRequestCard,
  pullRequestCardById,
  resetPullRequestCardsStoreForTests,
} = await import("./pullRequestCards.ts");
const { mergePullRequestAndProject, resetPullRequestMutationsForTests } =
  await import("./pullRequestMerge.ts");
const { runPullRequestCardAction } = await import("./pullRequestActions.ts");
type PullRequestActionOperations =
  import("./pullRequestActions.ts").PullRequestActionOperations;

const REPO = "/tmp/pr-card-projection-repo";

function card() {
  return createPullRequestCard(
    {
      sessionId: "session-1",
      status: "open",
      title: "Add /pr",
      headBranch: "feature",
      baseBranch: "main",
      provider: "github",
      number: 42,
      url: "https://github.com/acme/repo/pull/42",
    },
    {
      repoRoot: REPO,
      sessionKind: "developer",
      sessionId: "session-1",
      headBranch: "feature",
      baseBranch: "main",
      draft: false,
    },
  );
}

function provider(onMerge: () => void = () => undefined): GitHostingProvider {
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
    pullRequestDetail: async () => null,
    closePullRequest: async () => {
      throw new Error("not used");
    },
    repositoryCapabilities: async () => ({
      defaultBranch: "main",
      mergeMethods: ["squash"],
      canClose: true,
    }),
    mergePullRequest: async (
      number: number,
      options: { method: PullRequestMergeMethod },
    ) => {
      onMerge();
      return { number, method: options.method, branchDeleted: true };
    },
  } as unknown as GitHostingProvider;
}

afterEach(() => {
  hoisted.failMergedWrite = false;
  resetPullRequestCardsStoreForTests();
  resetPullRequestMutationsForTests();
});

// `cardIds` promises the cards this merge MOVED to merged. Returning the ones
// it merely matched is what lets a caller skip the card it could still fix.
test("the projection reports only the cards it actually wrote", async () => {
  const subject = card();
  hoisted.failMergedWrite = true;

  const projection = await mergePullRequestAndProject(
    {
      provider: provider(),
      repoPath: REPO,
      number: 42,
      headBranch: "feature",
      baseBranch: "main",
      method: "squash",
    },
    { refreshBaseCheckout: async () => undefined },
  );

  // The injected failure was CONSUMED: without this the test would pass on a
  // mock that never fired.
  assert.equal(hoisted.failMergedWrite, false);
  assert.deepEqual(projection.cardIds, []);
  // The merge itself is reported as what it was, and the card is still open —
  // which is the state the caller now has to answer for.
  assert.equal(projection.result.method, "squash");
  assert.equal(pullRequestCardById(subject.id)?.status, "open");
});

// The initiating card action is the one writer that still holds this card, so a
// projection that missed it must not end with `busyAction` cleared over an open
// card offering Merge for a pull request that is already in.
test("a card whose projection write failed is still landed by its own action", async () => {
  const subject = card();
  let merges = 0;
  const operations = {
    resolveProvider: async () => provider(() => (merges += 1)),
    worktreeRow: async () => undefined,
    mainRow: async () => undefined,
  } as unknown as PullRequestActionOperations;
  hoisted.failMergedWrite = true;

  const { card: updated } = await runPullRequestCardAction(
    subject.id,
    "merge",
    { mergeMethod: "squash" },
    operations,
  );

  assert.equal(merges, 1);
  assert.equal(hoisted.failMergedWrite, false);
  // What the click answers with, and what every other viewer reads.
  assert.equal(updated.status, "merged");
  assert.equal(updated.busyAction, undefined);
  assert.equal(updated.actionError, undefined);
  assert.match(updated.actionMessage ?? "", /Merged #42 into main \(squash\)/);
  const durable = pullRequestCardById(subject.id);
  assert.equal(durable?.status, "merged");
  assert.equal(durable?.busyAction, undefined);
});
