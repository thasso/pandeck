/**
 * While a card store is unavailable its read-only answers are empty, and empty
 * is not "nothing pending": every server decision that ACTS on attention —
 * settling a session or a cluster, the worktree-removal preflight, the
 * auto-archive pass — must treat unknown as blocking, and work again once the
 * store has been imported (a restart). Each store is failed in turn by making its legacy file
 * unreadable (`node:fs` wrapped).
 */
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, test, vi } from "vitest";

const faults = vi.hoisted(() => ({ file: undefined as string | undefined }));

vi.mock("node:fs", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs")>();
  return {
    ...fs,
    openSync: ((...args: Parameters<typeof fs.openSync>) => {
      if (faults.file && String(args[0]).endsWith(faults.file))
        throw Object.assign(new Error("EACCES: injected"), { code: "EACCES" });
      return fs.openSync(...args);
    }) as typeof fs.openSync,
  };
});

const { DATA_DIR } = await import("./config.ts");
const { closeDb } = await import("./db/index.ts");
const { sessionStore } = await import("./db/sessionStore.ts");
const { addLink } = await import("./db/links.ts");
const cards = await import("./pullRequestCards.ts");
const approvals = await import("./pendingApprovals.ts");
const {
  sessionSettleBlockedReason,
  settleSessionWithPeers,
  worktreeSettleBlockedReason,
} = await import("./sessionActivity.ts");
const { sweepSettledSessionArchive } = await import("./sessionRetention.ts");
const { settleCompletedWorkflowRunSessions } =
  await import("./sessionActivity.ts");
const workflowStore = await import("./db/workflowStore.ts");

const LIVE = "attention-live-session";
const OLD = "attention-settled-session";
const WORKTREE = "attention-worktree";
const EIGHT_DAYS = 8 * 24 * 60 * 60 * 1000;

beforeAll(() => {
  mkdirSync(DATA_DIR, { recursive: true });
  for (const id of [LIVE, OLD])
    sessionStore.upsert({
      id,
      scope: "user",
      harness: "pi",
      agentType: "developer",
      title: id,
      messageCount: 2,
    });
  addLink({ type: "session", id: LIVE }, "in_worktree", {
    type: "worktree",
    id: WORKTREE,
  });
  cards.setPullRequestCardBroadcastForTests(() => {});
  approvals.setApprovalBroadcastForTests(
    () => {},
    () => {},
  );
});
afterEach(() => {
  faults.file = undefined;
});
afterAll(() => closeDb());

const stores = [
  {
    name: "approval",
    file: "pending-approvals.json",
    body: '{"approvals":[]}',
    run: () => approvals.importLegacyApprovals(),
  },
  {
    name: "pull-request card",
    file: "pull-request-cards.json",
    body: '{"cards":[]}',
    run: () => cards.importLegacyPullRequestCards(),
  },
];

for (const store of stores)
  test(`while the ${store.name} store is unavailable, settle, worktree removal and auto-archive refuse; once readable they proceed`, async () => {
    sessionStore.setSettled(OLD, true);
    writeFileSync(join(DATA_DIR, store.file), store.body);
    faults.file = store.file;
    assert.equal(store.run().kind, "failed");
    const reason = new RegExp(`${store.name} store is unavailable`);

    // Settle, alone and as a cluster.
    assert.match((await sessionSettleBlockedReason(LIVE)) ?? "", reason);
    const settle = await settleSessionWithPeers(LIVE, Number.MAX_SAFE_INTEGER);
    assert.ok("blocked" in settle && reason.test(settle.blocked));
    assert.equal(sessionStore.isSettled(LIVE), false);
    // The worktree-removal preflight.
    assert.match((await worktreeSettleBlockedReason(WORKTREE)) ?? "", reason);
    // The auto-archive pass skips, leaving the old settled session in place.
    const later = Date.now() + EIGHT_DAYS;
    assert.deepEqual(await sweepSettledSessionArchive(later), []);
    assert.equal(sessionStore.get(OLD)?.archivedAt, undefined);

    // Fixed and restarted (boot's import run): all three proceed.
    faults.file = undefined;
    assert.equal(store.run().kind, "imported");
    assert.equal(await worktreeSettleBlockedReason(WORKTREE), undefined);
    assert.equal(await sessionSettleBlockedReason(LIVE), undefined);
    assert.deepEqual(
      await sweepSettledSessionArchive(Date.now() + EIGHT_DAYS),
      [OLD],
    );
    assert.deepEqual(
      await settleSessionWithPeers(LIVE, Number.MAX_SAFE_INTEGER),
      { written: true },
    );
    // Reset for the next store.
    sessionStore.setSettled(LIVE, false);
    sessionStore.setArchived?.(OLD, false);
  });

/** A completed run whose one step was executed by `sessionId`. */
function completedRunWith(sessionId: string, taskId: number): number {
  const run = workflowStore.createRun({
    taskId,
    recipeId: "code-delivery",
    recipeVersion: 1,
    maxIterations: 2,
    maxReviewPasses: 1,
    actor: { kind: "user" },
  });
  const step = workflowStore.appendStep({
    runId: run.id,
    kind: "agent",
    payload: { role: "coordinator" },
    actor: { kind: "system" },
  });
  workflowStore.startStep(
    step.id,
    { kind: "session", id: sessionId },
    { kind: "system" },
  );
  workflowStore.completeStep(step.id, {
    status: "completed",
    result: { status: "completed", summary: "done" },
    actor: { kind: "system" },
  });
  workflowStore.setRunLifecycle(run.id, "completed", {
    actor: { kind: "system" },
  });
  return run.id;
}

test("a run role outside the default list scope is not settled while the approval store is unavailable", async () => {
  // An internal-scope session projects to no row in the default list, which
  // used to read as "nothing pending" before the store was even consulted.
  const ROLE = "attention-internal-role";
  sessionStore.upsert({
    id: ROLE,
    scope: "internal",
    harness: "pi",
    agentType: "developer",
    title: ROLE,
    messageCount: 2,
  });
  const runId = completedRunWith(ROLE, 9_001);
  writeFileSync(join(DATA_DIR, "pending-approvals.json"), '{"approvals":[]}');
  faults.file = "pending-approvals.json";
  assert.equal(approvals.importLegacyApprovals().kind, "failed");

  assert.match(
    (await sessionSettleBlockedReason(ROLE)) ?? "",
    /approval store is unavailable/,
  );
  await settleCompletedWorkflowRunSessions(runId);
  assert.equal(sessionStore.isSettled(ROLE), false);

  // Once imported, the run's end settles it as before.
  faults.file = undefined;
  assert.equal(approvals.importLegacyApprovals().kind, "imported");
  await settleCompletedWorkflowRunSessions(runId);
  assert.equal(sessionStore.isSettled(ROLE), true);
});
