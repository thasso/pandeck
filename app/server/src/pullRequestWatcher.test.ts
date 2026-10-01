import assert from "node:assert/strict";
import { afterEach, test, vi } from "vitest";
import { applyPatch } from "@assistant/shared";
import type {
  GitHostingProviderKind,
  Patch,
  PullRequestDetail,
  WorktreeCiStatus,
} from "@assistant/shared";
import { insertWorktree } from "./db/worktreeStore.ts";
import type { GitHostingProvider } from "./gitHosting.ts";
import {
  beginPullRequestCardObservation,
  createPullRequestCard,
  patchPullRequestCard,
  patchPullRequestCardObservation,
  pullRequestCardById,
  pullRequestCardRecord,
  resetPullRequestCardsStoreForTests,
  type CreatePullRequestCardInput,
} from "./pullRequestCards.ts";
import {
  reconcilePullRequestCardsOnBoot,
  resetPullRequestWatcherForTests,
  scheduleImmediatePoll,
  setPullRequestWatcherNotifierForTests,
  setPullRequestWatcherProviderResolverForTests,
  setPullRequestWatcherSessionOwnershipForTests,
  sweepPullRequestWatcherForTests,
} from "./pullRequestWatcher.ts";
import type { AppWebPushNotification } from "./webPush.ts";
import { createTask, deleteTask, readTask, taskSummaryOf } from "./tasks.ts";

const context = {
  repoRoot: "/tmp/watched-repo",
  sessionKind: "developer" as const,
  sessionId: "session-1",
  headBranch: "feature",
  baseBranch: "main",
  draft: false,
};

function openCard(overrides: Patch<CreatePullRequestCardInput> = {}) {
  return createPullRequestCard(
    applyPatch(
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
      overrides,
    ),
    context,
  );
}

function fakeProvider(
  impl: Partial<GitHostingProvider>,
  kind: GitHostingProviderKind = "github",
): GitHostingProvider {
  return {
    kind,
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
    mergePullRequest: async () => {
      throw new Error("not used");
    },
    closePullRequest: async () => {
      throw new Error("not used");
    },
    repositoryCapabilities: async () => ({
      defaultBranch: "main",
      mergeMethods: ["squash", "merge", "rebase"],
      canClose: true,
    }),
    ...impl,
  };
}

function detail(patch: Partial<PullRequestDetail> = {}): PullRequestDetail {
  return {
    number: 42,
    state: "open",
    merged: false,
    mergeable: true,
    draft: false,
    headSha: "sha-1",
    headBranch: "feature",
    baseBranch: "main",
    ...patch,
  };
}

afterEach(() => {
  resetPullRequestWatcherForTests();
  resetPullRequestCardsStoreForTests();
});

test("an older provider snapshot cannot overwrite a newer conflict observation", () => {
  const card = openCard();
  const older = beginPullRequestCardObservation(card.id);
  const newer = beginPullRequestCardObservation(card.id);
  const conflict = patchPullRequestCardObservation(
    card.id,
    newer,
    { mergeable: false, conflicts: true },
    { observedHeadSha: "new-head" },
  );
  assert.ok(conflict);

  const stale = patchPullRequestCardObservation(
    card.id,
    older,
    { mergeable: true, conflicts: false },
    { observedHeadSha: "old-head" },
  );

  assert.equal(stale, undefined);
  assert.equal(pullRequestCardById(card.id)?.conflicts, true);
  assert.equal(
    pullRequestCardRecord(card.id)?.context.observedHeadSha,
    "new-head",
  );
});

test("a watcher observation clears a draft when the provider reports ready", async () => {
  const card = openCard();
  patchPullRequestCard(card.id, { draft: true });
  setPullRequestWatcherProviderResolverForTests(async () =>
    fakeProvider({ pullRequestDetail: async () => detail({ draft: false }) }),
  );

  await sweepPullRequestWatcherForTests();

  assert.equal(pullRequestCardById(card.id)?.draft, undefined);
});

test("a ready projection invalidates an in-flight draft observation", () => {
  const card = openCard();
  const draftRead = beginPullRequestCardObservation(card.id);
  patchPullRequestCard(
    card.id,
    { draft: undefined },
    {
      observationToken: "ready-generation",
      observedHeadSha: "sha-1",
    },
  );
  const stale = patchPullRequestCardObservation(card.id, draftRead, {
    draft: true,
  });
  assert.equal(stale, undefined);
  assert.equal(pullRequestCardById(card.id)?.draft, undefined);
});

test("the watcher does not start a stale head read during a head-changing action", async () => {
  const card = openCard();
  patchPullRequestCard(card.id, { busyAction: "update-with-main" });
  let detailCalls = 0;
  setPullRequestWatcherProviderResolverForTests(async () =>
    fakeProvider({
      pullRequestDetail: async () => {
        detailCalls += 1;
        return detail();
      },
    }),
  );

  await sweepPullRequestWatcherForTests();

  assert.equal(detailCalls, 0);
  assert.equal(pullRequestCardById(card.id)?.busyAction, "update-with-main");
});

test("a sweep updates an open card's CI and mergeability", async () => {
  const card = openCard();
  const ci: WorktreeCiStatus = { state: "pending", total: 2 };
  setPullRequestWatcherProviderResolverForTests(async () =>
    fakeProvider({
      pullRequestDetail: async () => detail(),
      ciStatus: async () => ci,
    }),
  );

  await sweepPullRequestWatcherForTests();

  const updated = pullRequestCardById(card.id);
  assert.equal(updated?.status, "open");
  assert.deepEqual(updated?.ci, ci);
  assert.equal(updated?.mergeable, true);
  assert.equal(updated?.conflicts, false);
});

// `mergeable: false` carries two provider answers — a real conflict and a
// conflict check that is merely queued — so the card states a conflict only
// once a second read of the same head reproduces it. Latching the first one
// paused a Workflow Run on a conflict that never existed (Task 535).
test("a conflict is claimed only after a second read confirms it, and null is left unknown", async () => {
  const card = openCard();
  setPullRequestWatcherProviderResolverForTests(async () =>
    fakeProvider({
      pullRequestDetail: async () => detail({ mergeable: false }),
    }),
  );
  await sweepPullRequestWatcherForTests();
  assert.equal(pullRequestCardById(card.id)?.mergeable, false);
  assert.equal(
    pullRequestCardById(card.id)?.conflicts,
    false,
    "one conflicting read is a question, not a verdict",
  );

  scheduleImmediatePoll(card.id);
  await sweepPullRequestWatcherForTests();
  assert.equal(pullRequestCardById(card.id)?.conflicts, true);

  patchPullRequestCard(card.id, { conflicts: undefined, mergeable: undefined });
  setPullRequestWatcherProviderResolverForTests(async () =>
    fakeProvider({
      pullRequestDetail: async () => detail({ mergeable: null }),
    }),
  );
  scheduleImmediatePoll(card.id);
  await sweepPullRequestWatcherForTests();
  const updated = pullRequestCardById(card.id);
  assert.equal(updated?.mergeable, null);
  assert.equal(
    updated?.conflicts,
    false,
    "an unresolved mergeable must never render as a conflict",
  );
});

// A poll whose patch is dropped said nothing, so it may not push the card onto
// the slow cadence either: publication rotates the generation exactly when a
// workflow run has just started waiting on the answer.
test("a superseded poll leaves the card due for the next sweep", async () => {
  const card = openCard();
  let calls = 0;
  setPullRequestWatcherProviderResolverForTests(async () =>
    fakeProvider({
      pullRequestDetail: async () => {
        calls += 1;
        // Publication (or a merge action) mints a newer generation while this
        // read is in flight.
        beginPullRequestCardObservation(card.id);
        return detail();
      },
      ciStatus: async () => ({ state: "success", total: 1 }),
    }),
  );

  await sweepPullRequestWatcherForTests();
  assert.equal(calls, 1);
  assert.equal(pullRequestCardById(card.id)?.ci, undefined, "nothing landed");
  await sweepPullRequestWatcherForTests();
  assert.equal(calls, 2);
});

test("a confirmation counted for the old head does not carry to a new one", async () => {
  const card = openCard();
  let headSha = "sha-1";
  setPullRequestWatcherProviderResolverForTests(async () =>
    fakeProvider({
      pullRequestDetail: async () => detail({ mergeable: false, headSha }),
    }),
  );
  await sweepPullRequestWatcherForTests();
  headSha = "sha-2";
  scheduleImmediatePoll(card.id);
  await sweepPullRequestWatcherForTests();

  assert.equal(
    pullRequestCardById(card.id)?.conflicts,
    false,
    "the second read is about a different branch state",
  );
  scheduleImmediatePoll(card.id);
  await sweepPullRequestWatcherForTests();
  assert.equal(pullRequestCardById(card.id)?.conflicts, true);
});

// The confirmation count is in memory, but the conflict it confirmed is on the
// card: a restart must not un-say it for one poll and then say it again.
test("a confirmed conflict survives the count being forgotten", async () => {
  const card = openCard();
  setPullRequestWatcherProviderResolverForTests(async () =>
    fakeProvider({
      pullRequestDetail: async () => detail({ mergeable: false }),
    }),
  );
  await sweepPullRequestWatcherForTests();
  scheduleImmediatePoll(card.id);
  await sweepPullRequestWatcherForTests();
  assert.equal(pullRequestCardById(card.id)?.conflicts, true);

  resetPullRequestWatcherForTests();
  setPullRequestWatcherProviderResolverForTests(async () =>
    fakeProvider({
      pullRequestDetail: async () => detail({ mergeable: false }),
    }),
  );
  await sweepPullRequestWatcherForTests();
  assert.equal(pullRequestCardById(card.id)?.conflicts, true);
});

// The card claims the agent holds the branch only until the branch MOVES: the
// rebase it was handed either landed or was overtaken, and either way the
// button is the user's again.
test("a new head clears the rebase handoff the card was showing", async () => {
  const card = openCard();
  // The baseline the action recorded at handoff: the head the agent inherited.
  patchPullRequestCard(
    card.id,
    { rebaseHandedOff: true },
    { rebaseHandoffHeadSha: "sha-1" },
  );
  setPullRequestWatcherProviderResolverForTests(async () =>
    fakeProvider({ pullRequestDetail: async () => detail() }),
  );

  await sweepPullRequestWatcherForTests();
  assert.equal(
    pullRequestCardById(card.id)?.rebaseHandedOff,
    true,
    "the inherited head says nothing about the agent's rebase",
  );

  setPullRequestWatcherProviderResolverForTests(async () =>
    fakeProvider({
      pullRequestDetail: async () => detail({ headSha: "sha-2" }),
    }),
  );
  scheduleImmediatePoll(card.id);
  await sweepPullRequestWatcherForTests();
  assert.equal(pullRequestCardById(card.id)?.rebaseHandedOff, undefined);
});

// The baseline is the handoff's, NOT "whatever was observed last": a card whose
// first poll only lands after the agent republished the branch would otherwise
// adopt the rebased head as its own baseline and keep the button disabled for a
// rebase that is already finished.
test("a handoff with no baseline is ended by the first observation", async () => {
  const card = openCard();
  patchPullRequestCard(card.id, { rebaseHandedOff: true });
  setPullRequestWatcherProviderResolverForTests(async () =>
    fakeProvider({
      pullRequestDetail: async () => detail({ headSha: "agent-rebased" }),
    }),
  );

  await sweepPullRequestWatcherForTests();

  assert.equal(pullRequestCardById(card.id)?.rebaseHandedOff, undefined);
  assert.equal(
    pullRequestCardRecord(card.id)?.context.observedHeadSha,
    "agent-rebased",
  );
});

test("a merged PR transitions the card and stops further polling", async () => {
  const card = openCard();
  let calls = 0;
  setPullRequestWatcherProviderResolverForTests(async () =>
    fakeProvider({
      pullRequestDetail: async () => {
        calls += 1;
        return detail({ state: "merged", merged: true });
      },
    }),
  );

  await sweepPullRequestWatcherForTests();
  assert.equal(pullRequestCardById(card.id)?.status, "merged");
  assert.equal(calls, 1);

  // No longer `open`, so a later sweep must not poll it again.
  await sweepPullRequestWatcherForTests();
  assert.equal(calls, 1);
});

// Merging on the provider's own web UI is the same event as pressing the card's
// merge button, so it must leave the same `done` suggestion on the linked Task
// rather than only the in-app path writing one.
test("a merge observed on the provider suggests the linked Task done", async () => {
  const task = createTask({
    title: "Ship the observer",
    source: { createdBy: "user" },
  });
  try {
    openCard({ linkedTask: taskSummaryOf(task) });
    setPullRequestWatcherProviderResolverForTests(async () =>
      fakeProvider({
        pullRequestDetail: async () =>
          detail({ state: "merged", merged: true }),
      }),
    );

    await sweepPullRequestWatcherForTests();

    const stored = readTask(task.id)!;
    assert.notEqual(stored.status, "done");
    assert.equal(stored.statusSuggestion?.to, "done");
    assert.equal(stored.statusSuggestion?.reason, "PR #42 merged");
  } finally {
    deleteTask(task.id);
  }
});

test("a closed (unmerged) PR is reflected without claiming it was merged", async () => {
  const card = openCard();
  setPullRequestWatcherProviderResolverForTests(async () =>
    fakeProvider({
      pullRequestDetail: async () => detail({ state: "closed", merged: false }),
    }),
  );
  await sweepPullRequestWatcherForTests();
  assert.equal(pullRequestCardById(card.id)?.status, "closed");
});

// Removing the worktree is the ORDINARY end of a delivery, and the card
// outlives it. Resolving hosting only from that deleted checkout answered
// `null` on every later poll, so the card stayed `open` for good — and with it
// every Workflow Run parked on its merge decision, as an inbox item that could
// be neither answered nor settled.
test("a card whose worktree was removed is polled through the main checkout", async () => {
  insertWorktree({
    id: "wt-retired",
    projectId: "acme",
    mainRepoRoot: "/tmp/main-repo",
    path: context.repoRoot,
    branch: "feature",
    baseBranch: "main",
    baseCommit: "sha-0",
    status: "removed",
    mergeStateJson: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    removedAt: Date.now(),
  });
  const card = openCard({ worktreeId: "wt-retired" });
  const asked: string[] = [];
  setPullRequestWatcherProviderResolverForTests(async (repoPath) => {
    asked.push(repoPath);
    // The deleted checkout answers nothing, exactly as `git remote get-url` does.
    return repoPath === "/tmp/main-repo"
      ? fakeProvider({
          pullRequestDetail: async () => detail({ state: "closed" }),
        })
      : null;
  });

  await sweepPullRequestWatcherForTests();

  assert.deepEqual(asked, ["/tmp/main-repo"]);
  assert.equal(pullRequestCardById(card.id)?.status, "closed");
});

test("an open card with no number is retried slowly instead of spinning every sweep", async () => {
  const card = openCard({ number: undefined });
  let calls = 0;
  setPullRequestWatcherProviderResolverForTests(async () => {
    calls += 1;
    return fakeProvider({ pullRequestDetail: async () => detail() });
  });

  await sweepPullRequestWatcherForTests();
  assert.equal(calls, 0, "no number — the provider must not even be asked");

  // Immediately due again under the old (delete-on-skip) behavior; the fix
  // schedules a slow retry instead, so this sweep must still skip it.
  await sweepPullRequestWatcherForTests();
  assert.equal(calls, 0);
  assert.equal(pullRequestCardById(card.id)?.status, "open");
});

test("review is only requested for a still-open PR", async () => {
  let reviewCalls = 0;
  openCard();
  setPullRequestWatcherProviderResolverForTests(async () =>
    fakeProvider({
      pullRequestDetail: async () => detail({ state: "closed", merged: false }),
      pullRequestReview: async () => {
        reviewCalls += 1;
        return { changesRequested: false };
      },
    }),
  );
  await sweepPullRequestWatcherForTests();
  assert.equal(reviewCalls, 0);
});

/* ------------------------------ notifications ------------------------------ */

test("CI conclusion notifies once, deduped for the same PR + head SHA", async () => {
  const card = openCard();
  const notifications: AppWebPushNotification[] = [];
  setPullRequestWatcherNotifierForTests(async (n) => {
    notifications.push(n);
  });

  let ci: WorktreeCiStatus = { state: "pending", total: 1 };
  setPullRequestWatcherProviderResolverForTests(async () =>
    fakeProvider({
      pullRequestDetail: async () => detail(),
      ciStatus: async () => ci,
    }),
  );

  await sweepPullRequestWatcherForTests();
  assert.equal(notifications.length, 0, "still pending — no notification yet");

  ci = { state: "success", total: 1 };
  scheduleImmediatePoll(card.id);
  await sweepPullRequestWatcherForTests();
  assert.equal(notifications.length, 1, "CI just concluded — notify once");

  // Same head SHA, still concluded: no repeat notification on later polls.
  scheduleImmediatePoll(card.id);
  await sweepPullRequestWatcherForTests();
  assert.equal(notifications.length, 1);

  assert.equal(
    pullRequestCardRecord(card.id)?.context.notifiedHeadSha,
    "sha-1",
  );
});

test("CI on a coordinator-owned child's pull request stays quiet", async () => {
  const card = openCard();
  const notifications: AppWebPushNotification[] = [];
  setPullRequestWatcherNotifierForTests(async (notification) => {
    notifications.push(notification);
  });
  setPullRequestWatcherSessionOwnershipForTests(() => false);
  setPullRequestWatcherProviderResolverForTests(async () =>
    fakeProvider({
      pullRequestDetail: async () => detail(),
      ciStatus: async () => ({ state: "success", total: 1 }),
    }),
  );

  await sweepPullRequestWatcherForTests();
  assert.equal(notifications.length, 0);
  assert.equal(
    pullRequestCardRecord(card.id)?.context.notifiedHeadSha,
    "sha-1",
    "the concluded head is consumed rather than notified after a later takeover",
  );
});

test("a rebase's new head SHA gets its own notification even if it resolves immediately", async () => {
  const card = openCard();
  const notifications: AppWebPushNotification[] = [];
  setPullRequestWatcherNotifierForTests(async (n) => {
    notifications.push(n);
  });

  setPullRequestWatcherProviderResolverForTests(async () =>
    fakeProvider({
      pullRequestDetail: async () => detail({ headSha: "sha-1" }),
      ciStatus: async () => ({ state: "success", total: 1 }),
    }),
  );
  await sweepPullRequestWatcherForTests();
  assert.equal(notifications.length, 1);

  // Rebase: a brand new head SHA whose CI is ALREADY concluded on the very
  // first poll (no intervening "pending" snapshot) must still notify once.
  setPullRequestWatcherProviderResolverForTests(async () =>
    fakeProvider({
      pullRequestDetail: async () => detail({ headSha: "sha-2" }),
      ciStatus: async () => ({ state: "success", total: 1 }),
    }),
  );
  scheduleImmediatePoll(card.id);
  await sweepPullRequestWatcherForTests();
  assert.equal(notifications.length, 2);
  assert.equal(
    pullRequestCardRecord(card.id)?.context.notifiedHeadSha,
    "sha-2",
  );
});

test("a failing CI conclusion also notifies", async () => {
  openCard();
  const notifications: AppWebPushNotification[] = [];
  setPullRequestWatcherNotifierForTests(async (n) => {
    notifications.push(n);
  });
  setPullRequestWatcherProviderResolverForTests(async () =>
    fakeProvider({
      pullRequestDetail: async () => detail(),
      ciStatus: async () => ({ state: "failure", total: 1 }),
    }),
  );
  await sweepPullRequestWatcherForTests();
  assert.equal(notifications.length, 1);
  assert.match(notifications[0]!.title, /CI failed/);
});

/* --------------------------- boot restore ---------------------------- */

test("reconcile on boot schedules every still-open card for an immediate poll", async () => {
  const card = openCard();

  // Simulate a restart: the in-memory schedule is gone (a fresh process starts
  // with an empty `nextPollAt`), the card is still `open` on disk, and
  // reconcile must pick it up without waiting.
  resetPullRequestWatcherForTests();
  let calls = 0;
  setPullRequestWatcherProviderResolverForTests(async () => {
    calls += 1;
    return fakeProvider({ pullRequestDetail: async () => detail() });
  });

  reconcilePullRequestCardsOnBoot();
  await sweepPullRequestWatcherForTests();

  assert.equal(calls, 1);
  assert.equal(pullRequestCardById(card.id)?.status, "open");
});

test("a card past its hard lifetime cap is no longer polled", async () => {
  const card = openCard();
  patchPullRequestCard(card.id, {
    createdAt: Date.now() - 40 * 24 * 60 * 60_000,
  });
  let calls = 0;
  setPullRequestWatcherProviderResolverForTests(async () => {
    calls += 1;
    return fakeProvider({ pullRequestDetail: async () => detail() });
  });
  await sweepPullRequestWatcherForTests();
  assert.equal(calls, 0);
});

// GitHub's REST budget is shared with every agent tool: a GitHub card polls
// every five minutes even while CI runs or its read failed, while a Forgejo
// card keeps the quick cadence.
test("a GitHub card polls on the slow cadence while CI runs and after a failure", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  try {
    vi.setSystemTime(1_000_000);
    const github = openCard();
    const forgejo = openCard({
      provider: "forgejo",
      number: 43,
      url: "https://git.example/acme/repo/pulls/43",
    });
    const polls = new Map<number, number>();
    let failGithub = false;
    setPullRequestWatcherProviderResolverForTests(async () =>
      fakeProvider({
        pullRequestDetail: async (number) => {
          polls.set(number, (polls.get(number) ?? 0) + 1);
          if (number === 42 && failGithub) throw new Error("rate limited");
          return detail({ number });
        },
        ciStatus: async () => ({ state: "pending", total: 1 }),
      }),
    );

    await sweepPullRequestWatcherForTests();
    assert.deepEqual([polls.get(42), polls.get(43)], [1, 1]);

    vi.setSystemTime(1_000_000 + 60_000);
    await sweepPullRequestWatcherForTests();
    assert.equal(polls.get(42), 1, "GitHub card is not due after a minute");
    assert.equal(polls.get(43), 2, "Forgejo card keeps the fast cadence");

    failGithub = true;
    vi.setSystemTime(1_000_000 + 5 * 60_000);
    await sweepPullRequestWatcherForTests();
    assert.equal(polls.get(42), 2);

    vi.setSystemTime(1_000_000 + 6 * 60_000);
    await sweepPullRequestWatcherForTests();
    assert.equal(polls.get(42), 2, "a failed GitHub read is not retried fast");
    assert.equal(pullRequestCardById(github.id)?.status, "open");
    assert.equal(pullRequestCardById(forgejo.id)?.status, "open");
  } finally {
    vi.useRealTimers();
  }
});
