/** V2 behavioral reporting evidence. Expected changes come from a full public build. */
import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { canonicalPiSessionPath } from "./sessionStorage.ts";
import { DEFAULT_WORKER_SIDE } from "./workers/placement.ts";
import { afterEach, test, vi } from "vitest";
import type { ToolCallContext } from "./mcp/tool.ts";
import * as questions from "./tools/core/questionTool.ts";
import * as approvals from "./pendingApprovals.ts";
import {
  admitDirectPeerTurns,
  recordDirectPeerChild,
  setSessionPeerTurnCap,
} from "./peerSpawnRuntimes.ts";
import { getSettings, updateSettings } from "./settings.ts";
import { permanentAssistantStore } from "./db/permanentAssistantStore.ts";
import { setInboxPositions } from "./db/inboxPositionStore.ts";
import * as worktrees from "./db/worktreeStore.ts";
import {
  checkPresence,
  notePresent,
  onPresenceChange,
  flushPresenceForTests,
  forgetPresence,
  notifyPresenceChange,
  presenceKey,
} from "./worktrees/checkoutPresence.ts";
import { sessionRuntime } from "./session/runtimeInstance.ts";
import { installSessionActivityTracking } from "./sessionActivity.ts";
import { ensureRuntimeSessionWithRuntime } from "./session/runtimePrompt.ts";
import { piStore } from "./piSdk/piStore.ts";
import { PiLiveSession } from "./piSdk/PiLiveSession.ts";
import { localPiEngine } from "./piSdk/piEngine.ts";
import { claudeSdkStore } from "./claudeSdk/claudeSdkStore.ts";
import { touchSessionRows } from "./db/sessionListChanges.ts";
import type {
  AdapterEvent,
  PromptableAdapter,
} from "./session/adapters/contract.ts";
import type { PullRequestCard } from "@assistant/shared";
import { hub } from "./hub.ts";
import { sessionListHiddenProbe } from "./permanentAssistantVisibility.ts";
import { sessionStore as sessions } from "./db/sessionStore.ts";
import { peerPromptStore as peer } from "./db/peerPromptStore.ts";
import { agentHandoffStore as handoffs } from "./db/agentHandoffStore.ts";
import { backgroundDeliveryOutboxStore as outbox } from "./db/backgroundDeliveryOutboxStore.ts";
import { pullRequestCardStore } from "./db/pullRequestCardStore.ts";
import {
  createPullRequestCard,
  patchPullRequestCard,
  patchPullRequestCardObservation,
  beginPullRequestCardObservation,
  resetPullRequestCardsStoreForTests,
} from "./pullRequestCards.ts";
import { linkSessionToObject } from "./db/sessionObjectStore.ts";
import { addLink, removeLink, setOutgoing, removeAllFor } from "./db/links.ts";
import { getDb } from "./db/index.ts";
import { recordSessionRowTouches } from "./test/sessionRowTouches.ts";
import { createTask, linkSessionToTask } from "./tasks.ts";
import {
  beginSessionRetitle,
  endSessionRetitle,
  cancelSessionRetitle,
} from "./sessionRetitlePending.ts";
import { sessionHooksFor } from "./workers/inProcessWorker.ts";
import { registerSessionHooks } from "./workers/sessionHookHost.ts";

let serial = 0;
function seed(messageCount = 2): string {
  const id = `behavior-${++serial}`;
  sessions.upsert({
    id,
    harness: "pi",
    agentType: "developer",
    messageCount,
    title: id,
    updatedAt: 1000,
  });
  return id;
}
async function projection() {
  const hidden = sessionListHiddenProbe();
  return new Map(
    (await hub.listSessions({ includeArchived: true }))
      .filter((row) => !hidden(row))
      .map((row) => {
        const { file: _file, ...publicRow } = row;
        return [row.id, JSON.stringify(publicRow)];
      }),
  );
}
/** Equal-public transitions must state why and assert their durable effect separately. */
async function check(
  label: string,
  write: () => unknown,
  expected: readonly string[],
  equalReason?: string,
) {
  assert.ok(
    expected.length > 0 || equalReason,
    `${label}: a nonvacuous fixture or an explicit equal-public reason`,
  );
  const before = await projection();
  const recorder = recordSessionRowTouches();
  let ids: Set<string>;
  let globals: number;
  try {
    const result = write();
    // Async callback owners report at their mutation, before their completion
    // signal resolves. Synchronous store APIs are sampled before any yield.
    if (result instanceof Promise) await result;
    ids = recorder.ids();
    globals = recorder.touchAlls.length;
  } finally {
    recorder.stop();
  }
  const after = await projection();
  const changed = [...new Set([...before.keys(), ...after.keys()])].filter(
    (id) => before.get(id) !== after.get(id),
  );
  for (const id of expected)
    assert.ok(changed.includes(id), `${label}: fixture must change ${id}`);
  for (const id of changed)
    assert.ok(
      globals! > 0 || ids!.has(id),
      `${label}: ${id} changed without a synchronous touch`,
    );
  assert.ok(ids!.size > 0 || globals! > 0, `${label}: reported before return`);
}
afterEach(async () => {
  vi.restoreAllMocks();
  await hub.flushPendingBroadcastsForTests();
});

test("sessionStore metadata writers, lifecycle, outcomes and spawn ownership", async () => {
  const a = seed();
  await check(
    "upsert",
    () =>
      sessions.upsert({
        id: a,
        harness: "pi",
        agentType: "developer",
        title: "renamed",
      }),
    [a],
  );
  await check("setPeerTurnCap", () => sessions.setPeerTurnCap(a, 3), [a]);
  sessions.upsert({
    id: a,
    harness: "pi",
    agentType: "developer",
    credentialProfileId: "old",
  });
  await check(
    "switchCredentialProfile",
    () => sessions.switchCredentialProfile(a, "old", "new"),
    [a],
  );
  await check("markRead", () => sessions.markRead(a, 1001), [a]);
  await check("touch", () => sessions.touch(a, 2000), [a]);
  await check("setArchived", () => sessions.setArchived(a, true), [a]);
  sessions.setArchived(a, false);
  await check("setSettled", () => sessions.setSettled(a, true), [a]);
  await check(
    "archiveSettledBatch",
    () => sessions.archiveSettledBatch([a], Date.now() + 1),
    [a],
  );
  sessions.setArchived(a, false);
  sessions.setSettled(a, false);
  const b = seed();
  await check("settleWithPeers", () => sessions.settleWithPeers(a, 0, [b]), [
    a,
    b,
  ]);
  await check(
    "recordSessionOutcome",
    () => sessions.recordSessionOutcome(a, "failed"),
    [a],
  );
  await check(
    "recordRunFailure",
    () => sessions.recordRunFailure(a, "failed", 1234),
    [a],
  );
  await check("clearRunFailure", () => sessions.clearRunFailure(a), [a]);
  sessions.recordRunFailure(a, "again", 4321);
  await check(
    "dismissRunFailure",
    () => sessions.dismissRunFailure(a, { errorAt: 4321, outcomeRevision: 1 }),
    [a],
  );
  await check(
    "recordInterruptedRun",
    () => sessions.recordInterruptedRun(a, 4000),
    [a],
  );
  await check("clearInterruptedRun", () => sessions.clearInterruptedRun(a), [
    a,
  ]);
  await check(
    "updateStats",
    () => sessions.updateStats(a, { messageCount: 4, updatedAt: 5000 }),
    [a],
  );
  await check("linkSpawned", () => sessions.linkSpawned(a, b), [b]);
  await check(
    "setSpawnedOwnership",
    () => sessions.setSpawnedOwnership(b, "taken-over"),
    [b],
  );
  // A missing persisted edge changes worktreeMissing without a Worker call.
  addLink({ type: "session", id: a }, "in_worktree", {
    type: "worktree",
    id: "missing-behavior",
  });
  await check(
    "acknowledgeMissingWorktree",
    () => sessions.acknowledgeMissingWorktree(a, "missing-behavior"),
    [a],
  );
  await check("markDeleted", () => sessions.markDeleted(a), [a]);
  await check("remove", () => sessions.remove(b), [b]);
  const fresh = `behavior-scope-${++serial}`;
  await check(
    "claimScope",
    () =>
      sessions.claimScope({
        id: fresh,
        harness: "pi",
        agentType: "developer",
        requiresEnterprise: true,
      }),
    [],
    "a fresh zero-message scope claim is not listed until the first message",
  );
  assert.equal(sessions.get(fresh)?.scope, "user");
});

test("handoff enqueue, remove and purge all change queuedWork", async () => {
  const a = seed();
  let id = 0;
  const input = {
    sessionId: a,
    origin: { kind: "human" as const },
    prompt: "continue",
    hidden: false,
  };
  await check(
    "agentHandoffStore.enqueue",
    () => {
      id = handoffs.enqueue(input).id;
    },
    [a],
  );
  await check("agentHandoffStore.remove", () => handoffs.remove(id), [a]);
  handoffs.enqueue(input);
  await check(
    "agentHandoffStore.purgeOlderThan",
    () => handoffs.purgeOlderThan(-1),
    [a],
  );
});

test("outbox phase writers preserve or change the independently built public handling counts", async () => {
  const a = seed();
  const item = { itemId: "behavior-item", revision: 1 };
  const save = () =>
    outbox.save({
      sessionId: a,
      ...item,
      disposition: "wake",
      retained: false,
    });
  await check(
    "outbox.save",
    save,
    [],
    "owed debts do not enter handlingCounts",
  );
  assert.equal(outbox.list().find((r) => r.sessionId === a)?.phase, "owed");
  await check(
    "outbox.retainSession",
    () => outbox.retainSession(a),
    [],
    "retention affects restart durability, not the row",
  );
  assert.equal(outbox.list().find((r) => r.sessionId === a)?.retained, true);
  await check(
    "outbox.remove",
    () => outbox.remove(a, item.itemId, 1),
    [],
    "removing an owed, unexposed debt does not change handlingCounts",
  );
  assert.ok(!outbox.list().some((r) => r.sessionId === a));
  save();
  await check(
    "outbox.reserve",
    () => assert.equal(outbox.reserve(a, "attempt", [item], "owed"), true),
    [a],
  );
  await check(
    "outbox.bind",
    () => assert.equal(outbox.bind(a, "attempt", "run", "entry"), 1),
    [],
    "reserved and handling both contribute one handling count",
  );
  assert.deepEqual(outbox.handlingCounts().get(a), {
    interrupted: 0,
    handling: 1,
  });
  await check(
    "outbox.release",
    () => assert.equal(outbox.release(a, "attempt"), 1),
    [a],
  );
  outbox.reserve(a, "attempt2", [item], "owed");
  outbox.bind(a, "attempt2", "run2", "entry2");
  await check("outbox.settleRun", () => outbox.settleRun(a, "run2", "failed"), [
    a,
  ]);
  await check(
    "outbox.dismissRefs",
    () => outbox.dismissRefs(a, [{ ...item, attemptId: "attempt2" }]),
    [a],
  );
  save();
  outbox.reserve(a, "attempt3", [item], "owed");
  await check(
    "outbox.settleAttempt",
    () => outbox.settleAttempt(a, "attempt3", "stopped"),
    [a],
  );
  outbox.dismissRefs(a, [{ ...item, attemptId: "attempt3" }]);
  save();
  outbox.reserve(a, "attempt4", [item], "owed");
  await check(
    "outbox.interruptUnfinished",
    () => outbox.interruptUnfinished(),
    [a],
  );
  await check("outbox.deleteSession", () => outbox.deleteSession(a), [a]);
});

test("context edge exports report both linked sessions, including direct removeAllFor(task)", async () => {
  const [a, b] = [seed(), seed()];
  const task = createTask({
    title: "behavior task",
    source: { createdBy: "user" },
  });
  const target = { type: "task" as const, id: String(task.id) };
  await check(
    "links.addLink",
    () => addLink({ type: "session", id: a }, "context", target),
    [a],
  );
  await check(
    "links.removeLink",
    () => removeLink({ type: "session", id: a }, "context", target),
    [a],
  );
  await check(
    "sessionObjectStore.linkSessionToObject",
    () => linkSessionToObject(a, "task", target.id, "manual"),
    [a],
  );
  await check(
    "links.setOutgoing",
    () => setOutgoing({ type: "session", id: a }, "context", []),
    [a],
  );
  linkSessionToTask(String(task.id), { sessionId: a });
  linkSessionToTask(String(task.id), { sessionId: b });
  await check("links.removeAllFor", () => removeAllFor(target), [a, b]);
});

test("direct-child registration creates public zero-message membership", async () => {
  const [parent, child] = [seed(), seed(0)];
  await check(
    "directPeerChildStore.record via recordDirectPeerChild",
    () =>
      recordDirectPeerChild({
        childSessionId: child,
        spawnerSessionId: parent,
        costClass: "counted",
        source: { kind: "profile", profileId: "profile" },
        provider: "anthropic",
        modelId: "model",
        thinkingLevel: "medium",
        credentialProfileId: "credential",
        createdAt: Date.now(),
      }),
    [child],
  );
});

test("PR-card insert, moving update and clear report old and new owners", async () => {
  const [a, b] = [seed(), seed()];
  let card: PullRequestCard;
  await check(
    "pullRequestCardStore.insert via createPullRequestCard",
    () => {
      card = createPullRequestCard(
        {
          sessionId: a,
          status: "open",
          title: "Test",
          headBranch: "feature",
          baseBranch: "main",
          number: 42,
        },
        {
          repoRoot: "/tmp",
          sessionKind: "developer",
          sessionId: a,
          headBranch: "feature",
          baseBranch: "main",
          draft: false,
        },
      );
    },
    [a],
  );
  assert.equal(pullRequestCardStore.get(card!.id)?.card.sessionId, a);
  await check(
    "pullRequestCardStore.update via patchPullRequestCard",
    () => patchPullRequestCard(card!.id, { sessionId: b }),
    [a, b],
  );
  assert.equal(pullRequestCardStore.get(card!.id)?.card.sessionId, b);
  const token = beginPullRequestCardObservation(card!.id);
  await check(
    "patchPullRequestCardObservation",
    () => patchPullRequestCardObservation(card!.id, token, { conflicts: true }),
    [b],
  );
  await check(
    "pullRequestCardStore.clear via resetPullRequestCardsStoreForTests",
    () => resetPullRequestCardsStoreForTests(),
    [b],
  );
});

test("retitle writers report titleGenerationPending in both directions", async () => {
  const a = seed();
  let token = Symbol();
  await check(
    "beginSessionRetitle",
    () => {
      token = beginSessionRetitle(a);
    },
    [a],
  );
  await check("endSessionRetitle", () => endSessionRetitle(a, token), [a]);
  beginSessionRetitle(a);
  await check("cancelSessionRetitle", () => cancelSessionRetitle(a), [a]);
});

function queued(
  a: string,
  b: string,
  extra: { held?: boolean; expiresAt?: number } = {},
) {
  const chainId = peer.createChain(`behavior-chain-${++serial}`);
  if (extra.held)
    return peer.enqueueRouted({
      conversationId: `behavior-conv-${serial}`,
      chainId,
      fallbackChainId: `behavior-fallback-${serial}`,
      senderSessionId: a,
      recipientSessionId: b,
      prompt: "work",
      responseRequested: true,
      participants: [a, b],
      maxHops: 100,
      held: { queueSeq: peer.allocateQueueSeq() },
    });
  return peer.enqueue({
    conversationId: `behavior-conv-${serial}`,
    chainId,
    hop: peer.reserveHop(chainId),
    senderSessionId: a,
    recipientSessionId: b,
    prompt: "work",
    responseRequested: true,
    ...(extra.expiresAt === undefined ? {} : { expiresAt: extra.expiresAt }),
  });
}
function admitted(a: string, b: string) {
  const r = queued(a, b);
  peer.claimOne(r.id, "test");
  peer.markAdmitted(r.id);
  return r;
}
function owed(a: string, b: string) {
  const r = admitted(a, b);
  peer.markCompleted(r.id);
  return r;
}

test("peer enqueue, refusal and chain reset change their public fields", async () => {
  const [a, b] = [seed(), seed()];
  await check("peer.enqueue", () => queued(a, b), [b]);
  const chain = peer.createChain(`behavior-refusal-${++serial}`);
  peer.addParticipant(chain, a);
  await check(
    "peer.recordHopRefusal",
    () => peer.recordHopRefusal(a, chain, 3),
    [a],
  );
  await check(
    "peer.closeChainsForSession",
    () => peer.closeChainsForSession(a),
    [a],
  );
  const c = seed();
  await check("peer.enqueueRouted", () => queued(a, c, { held: true }), [c]);
});

test("peer claim, queue return, retry and recovery exports execute real transitions", async () => {
  const [a, b] = [seed(), seed()];
  const r = queued(a, b);
  const same =
    "queued, dispatching and retryable_failed all count as queuedWork";
  const status = (expected: string) =>
    assert.equal(peer.getById(r.id)?.status, expected);
  await check(
    "peer.claimNext",
    () => peer.claimNext(b, "test", 1000),
    [],
    same,
  );
  status("dispatching");
  await check("peer.releaseToQueue", () => peer.releaseToQueue(r.id), [], same);
  status("queued");
  await check(
    "peer.claimBatch",
    () => peer.claimBatch(b, "test", 1000, 4, 10000),
    [],
    same,
  );
  status("dispatching");
  await check(
    "peer.returnHeldToQueue",
    () => peer.returnHeldToQueue(r.id),
    [],
    same,
  );
  status("queued");
  await check("peer.claimOne", () => peer.claimOne(r.id, "test"), [], same);
  status("dispatching");
  await check(
    "peer.markRetryable",
    () => peer.markRetryable(r.id, "retry", 1, 10),
    [],
    same,
  );
  status("retryable_failed");
  await check(
    "peer.requeueDueRetries",
    () => peer.requeueDueRetries(12),
    [],
    same,
  );
  status("queued");
  peer.claimNext(b, "test", 1, 10);
  await check(
    "peer.requeueExpiredLeases",
    () => peer.requeueExpiredLeases(12),
    [],
    same,
  );
  status("queued");
  peer.claimOne(r.id, "test");
  await check(
    "peer.applyRecoveryDecisions",
    () =>
      peer.applyRecoveryDecisions(
        [{ id: r.id, toStatus: "interrupted" }],
        "restart",
        "restart",
      ),
    [b],
  );
  status("interrupted");
});

test("peer admission and turn endings change owed and queued fields", async () => {
  const [a, b] = [seed(), seed()];
  let r = queued(a, b);
  peer.claimOne(r.id, "test");
  await check("peer.markAdmitted", () => peer.markAdmitted(r.id), [b]);
  await check(
    "peer.markAcknowledged",
    () => peer.markAcknowledged(r.id),
    [],
    "admission remains delivered, with no new owed request until the turn ends",
  );
  assert.equal(peer.getById(r.id)?.status, "acknowledged");
  await check("peer.markCompleted", () => peer.markCompleted(r.id), [a]);
  await check("peer.markExpired", () => peer.markExpired(r.id), [a]);
  r = admitted(a, b);
  await check("peer.markStopped", () => peer.markStopped(r.id), [a]);
  await check("peer.markSettled", () => peer.markSettled(b, [r.id], "done"), [
    a,
  ]);
  r = owed(a, b);
  const reply = queued(b, a);
  await check("peer.markReplied", () => peer.markReplied(r.id, reply.id), [a]);
  r = queued(a, b);
  const claim = peer.claimOne(r.id, "test")!;
  peer.reserveAdmission([claim], r.id);
  await check(
    "peer.recordAdmission",
    () => peer.recordAdmission([claim], r.id),
    [b],
  );
  await check(
    "peer.interruptAsTold",
    () => peer.interruptAsTold([r.id], "failed"),
    [],
    "accepted work stays delivered and there is no outstanding forwarded request in this fixture",
  );
  assert.equal(peer.getById(r.id)?.status, "interrupted");
  r = queued(a, b);
  peer.claimOne(r.id, "test");
  await check(
    "peer.markInterrupted",
    () => peer.markInterrupted(r.id, "restart", "restart"),
    [b],
  );
  r = admitted(a, b);
  await check(
    "peer.recoverStrandedAdmitted",
    () => peer.recoverStrandedAdmitted("restart", "restart"),
    [],
    "admitted work remains accepted after restart interruption",
  );
  assert.equal(peer.getById(r.id)?.status, "interrupted");
});

for (const method of [
  "transition",
  "markFailed",
  "cancelPending",
  "cancelOne",
] as const)
  test(`peer ${method} removes the only queued prompt`, async () => {
    const [a, b] = [seed(), seed()];
    const r = queued(a, b);
    const write = {
      transition: () => peer.transition(r.id, ["queued"], "failed"),
      markFailed: () => peer.markFailed(r.id, "failed"),
      cancelPending: () => peer.cancelPending(b, "cancel", a),
      cancelOne: () => peer.cancelOne(r.id, "cancel"),
    }[method];
    await check(`peer.${method}`, write, [b]);
    assert.ok(["failed", "cancelled"].includes(peer.getById(r.id)!.status));
  });

for (const method of [
  "promoteHeld",
  "refuseHeld",
  "cancelHeldInvolving",
  "cancelHeldTo",
] as const)
  test(`peer ${method} reports the younger held sibling's changed position`, async () => {
    const [a, b, c] = [seed(), seed(), seed()];
    const r = queued(a, b, { held: true });
    queued(a, c, { held: true });
    const write = {
      promoteHeld: () => peer.promoteHeld(r.id, Date.now() + 60000),
      refuseHeld: () => peer.refuseHeld(r.id, "refused", () => {}),
      cancelHeldInvolving: () => peer.cancelHeldInvolving(b, "cancel"),
      cancelHeldTo: () => peer.cancelHeldTo(b, "cancel"),
    }[method];
    await check(`peer.${method}`, write, [b, c]);
  });

test("peer markReminded crosses the configured reminder threshold", async () => {
  const [a, b] = [seed(), seed()];
  const r = owed(a, b);
  const original = getSettings().sessionPeerPromptReminderLimit;
  updateSettings({ sessionPeerPromptReminderLimit: 1 });
  try {
    await check("peer.markReminded", () => peer.markReminded([r.id]), [b]);
  } finally {
    updateSettings({ sessionPeerPromptReminderLimit: original });
  }
});

test("inboxPositionStore.setInboxPositions reports every changed session", async () => {
  const [a, b] = [seed(), seed()];
  await check(
    "setInboxPositions",
    () =>
      setInboxPositions({
        sessions: [
          { id: a, position: 1 },
          { id: b, position: 2 },
        ],
        runs: [],
      }),
    [a, b],
  );
});

test("permanentAssistantStore binding writes report public membership synchronously", async () => {
  const a = seed();
  const previous = permanentAssistantStore.sessionId();
  try {
    await check(
      "permanentAssistantStore.setSessionId",
      () => permanentAssistantStore.setSessionId(a),
      [a],
    );
    await check(
      "permanentAssistantStore.clearSessionId",
      () => permanentAssistantStore.clearSessionId(),
      [a],
    );
  } finally {
    if (previous) permanentAssistantStore.setSessionId(previous);
    else permanentAssistantStore.clearSessionId();
  }
});

test("peerSpawnRuntimes cap wrapper reports its session", async () => {
  const a = seed();
  await check("setSessionPeerTurnCap", () => setSessionPeerTurnCap(a, 2), [a]);
});

test("peer expireUnresolved changes an owed row independently of the clock", async () => {
  const [a, b] = [seed(), seed()];
  const r = queued(a, b, { expiresAt: Date.now() + 60000 });
  peer.claimOne(r.id, "test");
  peer.markAdmitted(r.id);
  peer.markCompleted(r.id);
  await check(
    "peer.expireUnresolved",
    () => peer.expireUnresolved(Date.now() + 120000),
    [a],
  );
  assert.equal(peer.getById(r.id)?.status, "expired");
});

test("worktree store exports report both coding sessions reading a shared edge", async () => {
  const [a, b] = [seed(), seed()];
  const id = `behavior-worktree-${++serial}`;
  await check(
    "worktree.linkSessionToWorktree",
    () => worktrees.linkSessionToWorktree(a, id),
    [a],
  );
  worktrees.linkSessionToWorktree(b, id);
  await check(
    "worktree.insertWorktree",
    () =>
      worktrees.insertWorktree({
        id,
        projectId: "behavior",
        mainRepoRoot: "/tmp",
        path: "/tmp",
        branch: "feature",
        baseBranch: "main",
        baseCommit: "abc",
        status: "active",
        mergeStateJson: null,
        branchCleanupOid: null,
        createdAt: 1,
        updatedAt: 1,
        removedAt: null,
      }),
    [a, b],
  );
  await check(
    "worktree.updateWorktree",
    () => worktrees.updateWorktree(id, { status: "removed", removedAt: 2 }),
    [a, b],
  );
  worktrees.updateWorktree(id, { status: "active", removedAt: null });
  await check(
    "worktree.markWorktreeRemovedForTests",
    () => worktrees.markWorktreeRemovedForTests(id),
    [a, b],
  );
  worktrees.updateWorktree(id, { status: "active", removedAt: null });
  await check(
    "worktree.finalizeWorktreeRemoval",
    () => worktrees.finalizeWorktreeRemoval(id, null),
    [a, b],
  );
});

test("question creation, answer and clear change attention without a session metadata write", async () => {
  const a = seed();
  const ask = () =>
    questions.askQuestionsTool.execute(
      { questions: [{ id: "choice", title: "Choose", style: "text" }] },
      {
        session: { sessionId: a },
        toolCallId: `behavior-question-${++serial}`,
      } as unknown as ToolCallContext,
    );
  await check("askQuestionsTool.execute", ask, [a]);
  let request = questions.getPendingAgentQuestions(a)[0]!;
  await check(
    "submitAgentQuestionResponse",
    () =>
      questions.submitAgentQuestionResponse(a, {
        requestId: request.requestId,
        status: "submitted",
        answers: [
          { questionId: "choice", disposition: "answered", text: "yes" },
        ],
        submittedAt: Date.now(),
      }),
    [a],
  );
  await ask();
  request = questions.getPendingAgentQuestions(a)[0]!;
  await check("clearPendingQuestion", () => questions.clearPendingQuestion(a), [
    a,
  ]);
});

test("approval creation and supersession use the full projection; reject clears pending attention", async () => {
  const a = seed();
  approvals.setApprovalBroadcastForTests(() => {});
  let card: ReturnType<typeof approvals.createApproval>;
  try {
    await check(
      "createApproval",
      () => {
        card = approvals.createApproval({
          sessionId: a,
          kind: "commit",
          title: "Commit",
          body: { kind: "commit", message: "test", files: ["a.ts"] },
        });
      },
      [a],
    );
    const before = await projection();
    const recorder = recordSessionRowTouches((ids) => {
      if (ids.has(a)) assert.ok(getDb().isTransaction);
    });
    try {
      await approvals.resolveApproval(card!.id, "rejected");
      assert.ok(recorder.ids().has(a));
      assert.notEqual((await projection()).get(a), before.get(a));
    } finally {
      recorder.stop();
    }
  } finally {
    approvals.setApprovalBroadcastForTests(null);
  }
});

test("auto-approval handback changes attention through runAutoApprovals", async () => {
  const a = seed();
  approvals.setApprovalBroadcastForTests(() => {});
  approvals.registerApprovalExecutor("commit", {
    execute: async () => ({ resultSummary: "done" }),
  });
  const input = {
    sessionId: a,
    kind: "commit" as const,
    title: "Commit",
    body: { kind: "commit" as const, message: "test", files: ["a.ts"] },
  };
  try {
    const first = approvals.createApproval(input);
    await approvals.resolveApproval(first.id, "approved", undefined, {
      forSession: true,
    });
    const automatic = approvals.createApproval(input);
    assert.equal(automatic.autoApproved, true);
    approvals.revokeApprovalGrant(a, "commit");
    await check(
      "runAutoApprovals",
      () => approvals.runAutoApprovals(a, false),
      [a],
    );
    assert.equal(
      approvals.approvalForId(automatic.id)?.autoApproved,
      undefined,
    );
    assert.equal(approvals.hasPendingApproval(a), true);
    await approvals.resolveApproval(automatic.id, "rejected");
  } finally {
    approvals.setApprovalBroadcastForTests(null);
  }
});

test("settling an in-flight hold reports an already-held younger child's changed position", async () => {
  const [a, b, c] = [seed(), seed(), seed()];
  queued(a, b, { held: true });
  const claim = await admitDirectPeerTurns(a, ["counted"]);
  const ticket = claim.rows[0]!;
  assert.ok("holdSeq" in ticket);
  queued(a, c, { held: true });
  peer.cancelHeldTo(b, "withdraw");
  try {
    await check(
      "DirectPeerTurnClaim.settleHold",
      () => claim.settleHold(ticket.holdSeq),
      [c],
    );
  } finally {
    claim.settleHold(ticket.holdSeq);
    claim.release();
  }
});

test("presence apply reports every session reading its key before checkPresence resolves", async () => {
  const [a, b] = [seed(), seed()];
  const id = `behavior-presence-${++serial}`;
  const path = mkdtempSync(join(tmpdir(), "behavior-presence-"));
  worktrees.insertWorktree({
    id,
    projectId: "behavior",
    mainRepoRoot: "/tmp",
    path,
    branch: "feature",
    baseBranch: "main",
    baseCommit: "abc",
    status: "active",
    mergeStateJson: null,
    branchCleanupOid: null,
    createdAt: 1,
    updatedAt: 1,
    removedAt: null,
  });
  worktrees.linkSessionToWorktree(a, id);
  worktrees.linkSessionToWorktree(b, id);
  notePresent(DEFAULT_WORKER_SIDE, path);
  const before = await projection();
  await flushPresenceForTests();
  rmSync(path, { recursive: true, force: true });
  const recorder = recordSessionRowTouches();
  let notified = false;
  const stop = onPresenceChange(() => {
    notified = true;
    assert.ok(recorder.ids().has(a) && recorder.ids().has(b));
  });
  try {
    assert.equal(await checkPresence(DEFAULT_WORKER_SIDE, path), false);
    const touched = recorder.ids();
    assert.ok(notified && touched.has(a) && touched.has(b));
    const after = await projection();
    assert.notEqual(before.get(a), after.get(a));
    assert.notEqual(before.get(b), after.get(b));
    await check(
      "notifyPresenceChange",
      () =>
        notifyPresenceChange([{ key: presenceKey(DEFAULT_WORKER_SIDE, path) }]),
      [],
      "notification-only entry point reports without changing the cache",
    );
    await check(
      "forgetPresence",
      () => forgetPresence(DEFAULT_WORKER_SIDE, path),
      [a, b],
    );
    await flushPresenceForTests();
    // Recreate before publishing present so the full build's refresh agrees.
    mkdirSync(path);
    await check("notePresent", () => notePresent(DEFAULT_WORKER_SIDE, path), [
      a,
      b,
    ]);
  } finally {
    stop();
    recorder.stop();
    rmSync(path, { recursive: true, force: true });
  }
});

class RuntimeAdapter implements PromptableAdapter {
  readonly provider = "behavior";
  readonly capabilities = {
    fork: "none" as const,
    compact: false,
    steer: false,
    attachments: false,
  };
  private listeners = new Set<(event: AdapterEvent) => void>();
  subscribe(listener: (event: AdapterEvent) => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  emit(event: AdapterEvent) {
    for (const listener of this.listeners) listener(event);
  }
  getBinding() {
    return { provider: this.provider, nativeId: "behavior" };
  }
  async prompt() {
    return { stopReason: "end" as const };
  }
  abort() {}
  setModel() {}
  setReasoning() {}
  dispose() {
    this.listeners.clear();
  }
}

test("runtime run-state and provider-retry events report the full public row synchronously", async () => {
  const a = seed();
  const adapter = new RuntimeAdapter();
  const stop = installSessionActivityTracking();
  sessionRuntime.createSession(a, adapter);
  // The engine's live overlay reads actual runtime state, without running a provider.
  vi.spyOn(piStore, "listInfo").mockImplementation(() => [
    {
      sessionId: a,
      kind: "developer",
      file: "behavior",
      title: a,
      createdAt: 1000,
      updatedAt: 1000,
      messageCount: 2,
      isStreaming: sessionRuntime.isRunning(a),
      awaitingInput: false,
      agentType: "developer",
    },
  ]);
  try {
    await check(
      "runStateChanged running",
      () => adapter.emit({ type: "messageStarted", streamId: "m", run: 1 }),
      [a],
    );
    const progress = (attempt: number) =>
      new Promise<void>((resolve) => {
        const unsubscribe = sessionRuntime.subscribeEvents((id, event) => {
          if (id === a && event.type === "runProgress") {
            unsubscribe();
            resolve();
          }
        });
        adapter.emit({
          type: "providerRetry",
          attempt,
          maxAttempts: 3,
          run: 1,
        });
      });
    await check("providerRetry", () => progress(1), [a]);
    await check("providerRetry next attempt", () => progress(2), [a]);
    await check(
      "runStateChanged idle",
      () => adapter.emit({ type: "runCompleted", stopReason: "end" }),
      [a],
    );
  } finally {
    stop();
    await sessionRuntime.releaseHarness(a);
  }
});

test("Claude live-map acquisition, live title mutation, persistence and removal report rows", async () => {
  const a = seed();
  sessions.upsert({ id: a, harness: "claude-sdk", agentType: "developer" });
  let live: ReturnType<typeof claudeSdkStore.acquire>;
  await check(
    "claudeSdkStore.acquire",
    () => {
      live = claudeSdkStore.acquire(a, { agentType: "developer" });
    },
    [a],
  );
  ensureRuntimeSessionWithRuntime(sessionRuntime, live!);
  await check(
    "ClaudeSdkSession.beginSyntheticTool",
    () => live!.beginSyntheticTool("test", {}),
    [a],
  );
  await check(
    "ClaudeSdkSession.setTitle",
    () => live!.setTitle("Live Claude title"),
    [a],
  );
  await check(
    "claudeSdkStore.persist",
    () => assert.equal(claudeSdkStore.persist(live!), true),
    [],
    "the live state is already authoritative and persistence mirrors it",
  );
  await check(
    "ClaudeSdkSession.setMode",
    () => live!.setMode("plan"),
    [],
    "mode changes tool policy/state, not list fields",
  );
  assert.equal(live!.sessionMode, "plan");
  await check(
    "ClaudeSdkSession.discardSyntheticTool",
    () => live!.discardSyntheticTool(),
    [a],
  );
  assert.equal(live!.isRunning, false);
  live!.beginSyntheticTool("remove-running", {});
  await check("claudeSdkStore.remove", () => claudeSdkStore.remove(a), [a]);
  assert.equal(claudeSdkStore.get(a), undefined);
});

test("pi live owner reports configuration, native events, title and synthetic turns through the harness host", async () => {
  const a = seed();
  let nativeEvent: (event: unknown) => void = () => {
    throw new Error("not subscribed");
  };
  const native = {
    sessionId: a,
    sessionName: a,
    isStreaming: false,
    model: { provider: "test", id: "old-model", name: "Old model" },
    thinkingLevel: "off",
    setModel(model: { provider: string; id: string; name: string }) {
      this.model = model;
      return Promise.resolve();
    },
    setThinkingLevel(level: string) {
      this.thinkingLevel = level;
    },
    sessionManager: {
      getBranch: () => [],
      getEntries: () => [],
      getEntry: () => undefined,
      getLeafId: () => undefined,
      getSessionId: () => a,
      getHeader: () => undefined,
    },
    subscribe: (listener: (event: unknown) => void) => {
      nativeEvent = listener;
      return () => {};
    },
    getSessionStats: () => ({
      totalMessages: 2,
      tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      cost: 0,
      contextSize: 0,
    }),
    setSessionName: () => {},
    dispose: () => {},
  };
  const live = new PiLiveSession(
    "developer",
    localPiEngine(native as never),
    {
      sessionRowsChanged: (ids: readonly string[]) => touchSessionRows(ids),
      noteRunStarted: () => {},
      checkPendingReload: () => {},
      isReloadQueued: () => false,
      buildSessionState: () => ({}),
    } as never,
    () => {},
  );
  ensureRuntimeSessionWithRuntime(sessionRuntime, live);
  vi.spyOn(piStore, "listInfo").mockImplementation(() => [live.listInfo()]);
  try {
    await check(
      "PiLiveSession.setModel",
      () =>
        live.setModel({
          provider: "test",
          id: "new-model",
          name: "New model",
        } as never),
      [a],
    );
    assert.equal(live.listInfo().model?.id, "new-model");
    await check(
      "PiLiveSession.setThinkingLevel",
      () => live.setThinkingLevel("high"),
      [a],
    );
    assert.equal(live.listInfo().thinkingLevel, "high");
    await check(
      "PiLiveSession.setMode",
      () => live.setMode("plan"),
      [],
      "mode changes prompt/tool policy and state, not the list row",
    );
    assert.equal(live.sessionMode, "plan");
    await check("PiLiveSession.rename", () => live.rename("Live pi title"), [
      a,
    ]);
    let toolId = "";
    await check(
      "PiLiveSession.beginSyntheticTool",
      () => {
        toolId = live.beginSyntheticTool("test", {}).toolId;
      },
      [a],
    );
    await check(
      "PiLiveSession.finishSyntheticTool",
      () => live.finishSyntheticTool(toolId, "done"),
      [a],
    );
    await check(
      "PiLiveSession native agent_start",
      () => nativeEvent({ type: "agent_start" }),
      [a],
    );
    assert.equal(live.isRunning, true);
    await check(
      "PiLiveSession native agent_settled",
      () => nativeEvent({ type: "agent_settled" }),
      [a],
    );
    assert.equal(live.isRunning, false);
    await check(
      "PiLiveSession native session_info_changed",
      () =>
        nativeEvent({ type: "session_info_changed", name: "Native rename" }),
      [a],
    );
    assert.equal(live.sessionTitle, "Native rename");
    live.beginSyntheticTool("discard", {});
    await check(
      "PiLiveSession.discardSyntheticTool",
      () => live.discardSyntheticTool(),
      [a],
    );
    assert.equal(live.isRunning, false);
  } finally {
    live.dispose();
  }
});

test("piStore public reopen and eviction report live-map overlay changes", async () => {
  const a = seed();
  const file = canonicalPiSessionPath(a);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(
    file,
    `${JSON.stringify({ type: "session", version: 3, id: a, timestamp: new Date().toISOString(), cwd: "/tmp" })}\n`,
  );
  // Replace provider construction only. The exported acquire/track/evict paths,
  // live wrapper, persisted row and full projection are real.
  const internals = piStore as unknown as {
    create: (...args: unknown[]) => Promise<{ session: unknown; notices: [] }>;
  };
  vi.spyOn(internals, "create").mockImplementation(
    async (_kind, sessionManager) => ({
      session: {
        sessionId: a,
        sessionFile: file,
        sessionName: "Native title",
        setSessionName(this: { sessionName: string }, name: string) {
          this.sessionName = name;
        },
        sessionManager,
        isStreaming: false,
        model: {
          provider: "test",
          id: "test-model",
          name: "Native model label",
        },
        subscribe: () => () => {},
        getSessionStats: () => ({
          totalMessages: 2,
          tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          cost: 0,
          contextSize: 0,
        }),
        dispose: () => {},
      },
      notices: [],
    }),
  );
  try {
    await check(
      "piStore.acquireExisting",
      () => piStore.acquireExisting("developer", file, a),
      [a],
    );
    assert.ok(piStore.get(a));
    await check("piStore.evict", () => piStore.evict(a), [a]);
    assert.equal(piStore.get(a), undefined);
    await check(
      "piStore.acquireByRecordId",
      () => piStore.acquireByRecordId(a, "developer"),
      [a],
    );
    assert.ok(piStore.get(a));
    await check(
      "piStore.renameSession live",
      () => piStore.renameSession("developer", file, a, "Store rename"),
      [a],
    );
    assert.equal(piStore.get(a)?.sessionTitle, "Store rename");
    piStore.evict(a);
    const beforeColdRename = await projection();
    await piStore.renameSession("developer", file, a, "Cold rename");
    assert.match(readFileSync(file, "utf8"), /Cold rename/);
    assert.deepEqual(
      await projection(),
      beforeColdRename,
      "cold transcript rename leaves the index update to the app rename writer",
    );
  } finally {
    piStore.evict(a);
    rmSync(file, { force: true });
  }
});

test("a worker-routed hook changes a row only after its server binding synchronously reports it", async () => {
  const a = seed();
  const dispose = registerSessionHooks(a, {
    canUseTool: () => ({ behavior: "allow" }),
    preToolUse: async () => ({ allowed: true }),
    stop: () => sessions.recordRunFailure(a, "worker hook failure", 6000),
    postCompact: () => {},
  });
  const before = await projection();
  let inBinding = false;
  const recorder = recordSessionRowTouches((ids) => {
    if (ids.has(a)) {
      inBinding = true;
      assert.equal(getDb().isTransaction, false);
    }
  });
  try {
    await sessionHooksFor(a).stop("epoch", []);
    assert.ok(inBinding);
    assert.ok(recorder.ids().has(a));
    assert.notEqual((await projection()).get(a), before.get(a));
  } finally {
    recorder.stop();
    dispose();
  }
});
