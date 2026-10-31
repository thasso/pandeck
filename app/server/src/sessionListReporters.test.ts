/**
 * Session-list touched-id reporting (`docs/session-list.md`, "Touched rows"):
 * every export of a store whose rows the session list reads is classified, a
 * write reports the rows it changes at the write site with its fan-out, the
 * hub's test-mode audit throws on a write that did not, the production sweep
 * repairs one, and the wire stays what it was.
 *
 * Expected rows always come from a FULL build (`fullPublicProjection`), never
 * from the touches under test.
 *   pnpm --filter @assistant/server test src/sessionListReporters.test.ts
 */
import assert from "node:assert/strict";
import { afterEach, describe, test, vi } from "vitest";
import type { ServerMessage, SessionListItem } from "@assistant/shared";
import { hub } from "./hub.ts";
import { agentHandoffStore } from "./db/agentHandoffStore.ts";
import { backgroundDeliveryOutboxStore } from "./db/backgroundDeliveryOutboxStore.ts";
import { directPeerChildStore } from "./db/directPeerChildStore.ts";
import { getDb } from "./db/index.ts";
import * as inboxPositionStore from "./db/inboxPositionStore.ts";
import * as links from "./db/links.ts";
import * as peerDeadlineClock from "./db/peerDeadlineClock.ts";
import { peerPromptStore } from "./db/peerPromptStore.ts";
import { permanentAssistantStore } from "./db/permanentAssistantStore.ts";
import { pullRequestCardStore } from "./db/pullRequestCardStore.ts";
import * as sessionObjectStore from "./db/sessionObjectStore.ts";
import { sessionStore } from "./db/sessionStore.ts";
import * as worktreeStore from "./db/worktreeStore.ts";
import { getSettings, updateSettings } from "./settings.ts";
import { sessionListHiddenProbe } from "./permanentAssistant.ts";
import * as sessionRetitlePending from "./sessionRetitlePending.ts";
import {
  createTask,
  deleteTask,
  linkSessionToTask,
  updateTask,
} from "./tasks.ts";
import { recordSessionRowTouches } from "./test/sessionRowTouches.ts";

let serial = 0;

afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  await hub.flushPendingBroadcastsForTests();
});

/** A listed session: a row with messages, in the user scope. */
function seed(label: string): string {
  serial += 1;
  const id = `rep-${label}-${Date.now()}-${serial}`;
  sessionStore.upsert({
    id,
    harness: "pi",
    agentType: "assistant",
    title: `${label} ${serial}`,
    scope: "user",
    messageCount: 2,
  });
  return id;
}

/**
 * V1 oracle: every row as a client may see it — the archived ones included,
 * `file` stripped, hidden rows removed — at the current `deadlineWatermark()`.
 */
async function fullPublicProjection(): Promise<Map<string, string>> {
  const hidden = sessionListHiddenProbe();
  const rows = await hub.listSessions({ includeArchived: true });
  return new Map(
    rows
      .filter((row) => !hidden(row))
      .map((row) => {
        const { file: _file, ...visible } = row as typeof row & {
          file?: unknown;
        };
        return [row.id, JSON.stringify(visible)];
      }),
  );
}

/**
 * Runs `write` with a recording sink and answers which rows the full build
 * says changed, and which the write touched BEFORE it returned.
 */
async function reported(write: () => unknown): Promise<{
  changed: Set<string>;
  touched: Set<string>;
}> {
  const before = await fullPublicProjection();
  const touches = recordSessionRowTouches();
  let touched: Set<string>;
  try {
    const result = write();
    // Synchronous: what the write reported by the time it returned.
    touched = touches.ids();
    await result;
  } finally {
    touches.stop();
  }
  const after = await fullPublicProjection();
  const changed = new Set<string>();
  for (const id of new Set([...before.keys(), ...after.keys()]))
    if (before.get(id) !== after.get(id)) changed.add(id);
  return { changed, touched };
}

/** The write changed at least `expected` and touched every row it changed. */
async function assertReported(
  label: string,
  write: () => unknown,
  expected: readonly string[],
): Promise<Set<string>> {
  const { changed, touched } = await reported(write);
  for (const id of expected)
    assert.ok(changed.has(id), `${label}: the fixture changes ${id}'s row`);
  for (const id of changed)
    assert.ok(touched.has(id), `${label}: ${id} changed but was not touched`);
  return touched;
}

/* ----------------------------- V2: classification ----------------------------- */

type Kind = "read" | "projected-write" | "non-projected-write";

/**
 * Every export, classified. A `projected-write` can change a session-list row
 * and must reach the seam; its source names one of the module's funnels. An
 * unclassified export fails, so a new writer has to be decided here.
 */
const CLASSIFIED: Record<
  string,
  {
    exports: Record<string, unknown>;
    /** The calls through which this module's writes reach the seam. */
    funnel: string[];
    kinds: Record<string, Kind>;
  }
> = {
  sessionStore: {
    exports: sessionStore,
    funnel: ["touchSessionRows", "noteLiveness", "upsert", "markDeleted"],
    kinds: {
      subscribeLiveness: "read",
      get: "read",
      getIncludingDeleted: "read",
      list: "read",
      liveDefaultScopeGate: "read",
      claimScope: "projected-write",
      countArchived: "read",
      upsert: "projected-write",
      setPeerTurnCap: "projected-write",
      switchCredentialProfile: "projected-write",
      setCompactionWindow: "non-projected-write",
      markDeleted: "projected-write",
      remove: "projected-write",
      markRead: "projected-write",
      touch: "projected-write",
      getReadAt: "read",
      setArchived: "projected-write",
      archiveSettledBatch: "projected-write",
      isArchived: "read",
      setSettled: "projected-write",
      settleWithPeers: "projected-write",
      isSettled: "read",
      recordSessionOutcome: "projected-write",
      acknowledgeMissingWorktree: "projected-write",
      worktreeMissingAck: "read",
      worktreeMissingAckBySession: "read",
      recordRunFailure: "projected-write",
      clearRunFailure: "projected-write",
      dismissRunFailure: "projected-write",
      recordInterruptedRun: "projected-write",
      clearInterruptedRun: "projected-write",
      updateStats: "projected-write",
      freezePromptConditions: "non-projected-write",
      getPromptConditions: "read",
      freezeSkills: "non-projected-write",
      deleteSkills: "non-projected-write",
      getSkills: "read",
      freezeAgent: "non-projected-write",
      getAgent: "read",
      getUsageTotals: "read",
      linkSpawned: "projected-write",
      setSpawnedOwnership: "projected-write",
      spawnedParentsByChildIds: "read",
      spawnedDescendantIds: "read",
      spawnedParentByChild: "read",
      spawnGrantEdge: "read",
      spawnGrantAncestors: "read",
      recordUsageTurn: "non-projected-write",
      replaceUsage: "non-projected-write",
      // Internal scope: never a list row.
      createInternalUsageSession: "non-projected-write",
    },
  },
  peerPromptStore: {
    exports: peerPromptStore,
    funnel: [
      "touchRequestRows",
      "touchSessionRows",
      "transitionInTxn",
      "transition",
      "cancelHeldWhere",
      "claimBatch",
      "claimOne",
    ],
    kinds: {
      createChain: "non-projected-write",
      getChain: "read",
      reserveHop: "non-projected-write",
      addParticipant: "non-projected-write",
      participantsOf: "read",
      chainsForSession: "read",
      closeChainsForSession: "projected-write",
      enqueue: "projected-write",
      enqueueRouted: "projected-write",
      recordHopRefusal: "projected-write",
      hopRefusalsBySender: "read",
      transition: "projected-write",
      claimNext: "projected-write",
      claimBatch: "projected-write",
      claimOne: "projected-write",
      releaseToQueue: "projected-write",
      returnHeldToQueue: "projected-write",
      markAdmitted: "projected-write",
      markAcknowledged: "projected-write",
      // Batch bookkeeping and reservations: no row reads these columns.
      markDeliveryBatch: "non-projected-write",
      markCompleted: "projected-write",
      markStopped: "projected-write",
      reserveAdmission: "non-projected-write",
      recordAdmission: "projected-write",
      markReplied: "projected-write",
      markSettled: "projected-write",
      markInterrupted: "projected-write",
      interruptAsTold: "projected-write",
      markRetryable: "projected-write",
      markFailed: "projected-write",
      markExpired: "projected-write",
      cancelPending: "projected-write",
      cancelOne: "projected-write",
      allocateQueueSeq: "non-projected-write",
      promoteHeld: "projected-write",
      refuseHeld: "projected-write",
      cancelHeldInvolving: "projected-write",
      cancelHeldTo: "projected-write",
      markSenderNotified: "non-projected-write",
      markReminded: "projected-write",
      getById: "read",
      queuedRecipientIds: "read",
      pendingDeliveryRecipientIds: "read",
      interruptedOwingSenderNotice: "read",
      openForRecipient: "read",
      openRequestsTo: "read",
      dueReminderRequests: "read",
      remindersExhaustedByRecipient: "read",
      listRepliedBy: "read",
      latestBetween: "read",
      senderIdsOwingNotice: "read",
      listPendingForRecipient: "read",
      listUndeliveredForRecipient: "read",
      heldFrom: "read",
      heldQueue: "read",
      heldSenderIds: "read",
      activeTurnCount: "read",
      outstandingResponseRequestCount: "read",
      outstandingRepliesBySender: "read",
      listByConversation: "read",
      listByChain: "read",
      listByParticipant: "read",
      summarizeByParticipant: "read",
      listByBatchHead: "read",
      unrepliedRequestsBetween: "read",
      listDispatching: "read",
      applyRecoveryDecisions: "projected-write",
      recoverStrandedAdmitted: "projected-write",
      requeueExpiredLeases: "projected-write",
      requeueDueRetries: "projected-write",
      expireUnresolved: "projected-write",
      pruneTerminal: "projected-write",
    },
  },
  agentHandoffStore: {
    exports: agentHandoffStore,
    funnel: ["touchSessionRows"],
    kinds: {
      enqueue: "projected-write",
      next: "read",
      remove: "projected-write",
      recordAttempt: "non-projected-write",
      queuedSessionIds: "read",
      purgeOlderThan: "projected-write",
      listForSession: "read",
    },
  },
  backgroundDeliveryOutboxStore: {
    exports: backgroundDeliveryOutboxStore,
    funnel: ["touchSessionRows"],
    kinds: {
      save: "projected-write",
      retainSession: "projected-write",
      remove: "projected-write",
      reserve: "projected-write",
      bind: "projected-write",
      release: "projected-write",
      settleRun: "projected-write",
      settleAttempt: "projected-write",
      interruptUnfinished: "projected-write",
      interrupted: "read",
      interruptedCount: "read",
      handlingCounts: "read",
      interruptedRefs: "read",
      dismissRefs: "projected-write",
      protectedArtifactIds: "read",
      list: "read",
      deleteSession: "projected-write",
    },
  },
  directPeerChildStore: {
    exports: directPeerChildStore,
    funnel: ["touchSessionRows"],
    kinds: {
      record: "projected-write",
      get: "read",
      childrenOf: "read",
      spawnerOf: "read",
      childIdsAmong: "read",
      clearForTests: "non-projected-write",
    },
  },
  sessionObjectStore: {
    exports: sessionObjectStore,
    // Edges are written only through `links.ts`, which touches their ends.
    funnel: ["addLink", "removeLink", "setOutgoing"],
    kinds: {
      linkSessionToObject: "projected-write",
      objectRefsForSession: "read",
      objectRefsBySession: "read",
      sessionIdsForObject: "read",
    },
  },
  links: {
    exports: links,
    funnel: ["touchSessionEnds", "touchSessionRows"],
    kinds: {
      memoizedOnLinks: "read",
      addLink: "projected-write",
      removeLink: "projected-write",
      outgoing: "read",
      outgoingByType: "read",
      incoming: "read",
      setOutgoing: "projected-write",
      allLinks: "read",
      removeAllFor: "projected-write",
    },
  },
  peerDeadlineClock: {
    exports: peerDeadlineClock,
    funnel: ["touchSessionRows"],
    kinds: {
      DEADLINE_SCHEDULED_STATUSES: "read",
      CLOSED_PEER_PROMPT_STATUSES: "read",
      DUE_DEADLINE_PARTICIPANTS_SQL: "read",
      NEXT_DEADLINE_SQL: "read",
      deadlineWatermark: "read",
      advancePeerDeadlines: "projected-write",
      // Arms the timer; the fire is `advancePeerDeadlines`.
      startPeerDeadlineClock: "non-projected-write",
      noteDeadline: "non-projected-write",
      armedPeerDeadlineForTests: "read",
      resetPeerDeadlineClockForTests: "non-projected-write",
    },
  },
  inboxPositionStore: {
    exports: inboxPositionStore,
    funnel: ["touchSessionRows"],
    kinds: { setInboxPositions: "projected-write" },
  },
  pullRequestCardStore: {
    exports: pullRequestCardStore,
    funnel: ["touchSessionRows", "touchAllSessionRows"],
    kinds: {
      get: "read",
      insert: "projected-write",
      update: "projected-write",
      forSession: "read",
      withStatus: "read",
      forWorktree: "read",
      sessionsWithStatus: "read",
      sessionHasStatus: "read",
      summariesForSession: "read",
      summariesForWorktree: "read",
      allSummaries: "read",
      links: "read",
      withBusyAction: "read",
      foreignWriteStamp: "read",
      clear: "projected-write",
    },
  },
  permanentAssistantStore: {
    exports: permanentAssistantStore,
    funnel: ["touchSessionRows"],
    kinds: {
      sessionId: "read",
      setSessionId: "projected-write",
      clearSessionId: "projected-write",
      // The PA's own prompt queue: no list row reads it.
      find: "read",
      enqueue: "non-projected-write",
      next: "read",
      mark: "non-projected-write",
      returnToQueue: "non-projected-write",
      recover: "non-projected-write",
    },
  },
  worktreeStore: {
    exports: worktreeStore,
    funnel: [
      "touchWorktreeSessions",
      "addLink",
      "setOutgoing",
      "updateWorktree",
    ],
    kinds: {
      getWorktree: "read",
      activeWorktreePaths: "read",
      listWorktrees: "read",
      insertWorktree: "projected-write",
      updateWorktree: "projected-write",
      // Base branch and commit: no row reads them.
      updateWorktreeBase: "non-projected-write",
      markWorktreeRemovedForTests: "projected-write",
      linkSessionToWorktree: "projected-write",
      recordWorktreeCreator: "non-projected-write",
      creatorSessionIdForWorktree: "read",
      worktreeCreatorBackfillDone: "read",
      recordWorktreeCreatorBackfill: "non-projected-write",
      creatorSessionIdByWorktree: "read",
      linkTaskToWorktree: "non-projected-write",
      worktreeIdForSession: "read",
      worktreeIdBySession: "read",
      sessionIdsForWorktree: "read",
      liveSessionIdsForWorktree: "read",
      worktreeIdsForTask: "read",
      taskIdsForWorktree: "read",
      insertComment: "non-projected-write",
      reassignCommentWorktreeForTests: "non-projected-write",
      reparentCommentForTests: "non-projected-write",
      setCommentRetentionFieldsForTests: "non-projected-write",
      getComment: "read",
      listComments: "read",
      insertReviewSet: "non-projected-write",
      getReviewSet: "read",
      listReviewSets: "read",
      closeReviewSet: "non-projected-write",
      listMainWorktreeIdsWithComments: "read",
      updateCommentAnchor: "non-projected-write",
      setCommentResolved: "non-projected-write",
      setCommentAttachedSession: "non-projected-write",
      deleteComment: "non-projected-write",
      deleteMainCommentsForBranchSubject: "non-projected-write",
      deleteExpiredResolvedOrphanedMainComments: "non-projected-write",
      deleteWorktreeComments: "non-projected-write",
      assertWorktreeCommentsDeletable: "read",
      finalizeWorktreeRemoval: "projected-write",
      clearWorktreeBranchCleanup: "non-projected-write",
      listOrphanedWorktreeComments: "read",
      deleteOrphanedWorktreeComments: "non-projected-write",
    },
  },
  sessionRetitlePending: {
    exports: sessionRetitlePending,
    funnel: ["touchSessionRows"],
    kinds: {
      beginSessionRetitle: "projected-write",
      ownsSessionRetitle: "read",
      endSessionRetitle: "projected-write",
      isRetitlingSession: "read",
      cancelSessionRetitle: "projected-write",
    },
  },
};

describe("every export is classified, and every projected write reaches the seam", () => {
  for (const [module, { exports, funnel, kinds }] of Object.entries(CLASSIFIED))
    test(module, () => {
      assert.deepEqual(
        Object.keys(exports).sort(),
        Object.keys(kinds).sort(),
        `${module}: classify every export as read, projected-write or non-projected-write`,
      );
      for (const [name, kind] of Object.entries(kinds)) {
        if (kind !== "projected-write") continue;
        const fn = exports[name];
        assert.equal(typeof fn, "function", `${module}.${name}`);
        assert.match(
          String(fn),
          // Vitest rewrites an imported call to `(0, __import__.name)(`.
          new RegExp(`\\b(${funnel.join("|")})\\)?\\(`),
          `${module}.${name} can change a session row and must touch it`,
        );
      }
    });
});

/* ----------------------------- V2: fan-out fixtures ----------------------------- */

function request(
  sender: string,
  recipient: string,
  extra: { expiresAt?: number; responseRequested?: boolean } = {},
) {
  const chainId = peerPromptStore.createChain(`rep-${++serial}`);
  return peerPromptStore.enqueue({
    conversationId: `rep-conv-${serial}`,
    chainId,
    hop: peerPromptStore.reserveHop(chainId),
    senderSessionId: sender,
    recipientSessionId: recipient,
    prompt: "q",
    responseRequested: extra.responseRequested ?? true,
    ...(extra.expiresAt !== undefined ? { expiresAt: extra.expiresAt } : {}),
  });
}

/** `sender` waits on `recipient`: the delivered turn ended without a reply. */
function owed(sender: string, recipient: string, expiresAt?: number) {
  const r = request(
    sender,
    recipient,
    expiresAt !== undefined ? { expiresAt } : {},
  );
  peerPromptStore.claimNext(recipient, "d", 1000);
  peerPromptStore.markAdmitted(r.id);
  peerPromptStore.markCompleted(r.id);
  return r;
}

function held(coordinator: string, child: string) {
  const chainId = peerPromptStore.createChain(`rep-held-${++serial}`);
  return peerPromptStore.enqueueRouted({
    conversationId: `rep-held-conv-${serial}`,
    chainId,
    fallbackChainId: `rep-held-fb-${serial}`,
    senderSessionId: coordinator,
    recipientSessionId: child,
    prompt: "start",
    responseRequested: false,
    participants: [coordinator, child],
    maxHops: 100,
    held: { queueSeq: peerPromptStore.allocateQueueSeq() },
  });
}

describe("fan-out", () => {
  test("a coordinator with three held children: withdrawing the oldest moves the others", async () => {
    const coordinator = seed("coord");
    const [a, b, c] = [seed("a"), seed("b"), seed("c")];
    const first = held(coordinator, a);
    held(coordinator, b);
    held(coordinator, c);
    await assertReported(
      "cancel a held child",
      () => peerPromptStore.cancelOne(first.id, "test"),
      [a, b, c],
    );
  });

  test("a sender owed by two recipients: archiving it moves both recipients' rows", async () => {
    const original = getSettings().sessionPeerPromptReminderLimit;
    updateSettings({ sessionPeerPromptReminderLimit: 1 });
    try {
      const sender = seed("sender");
      const [x, y] = [seed("x"), seed("y")];
      peerPromptStore.markReminded([owed(sender, x).id, owed(sender, y).id]);
      await assertReported(
        "archive the sender",
        () => sessionStore.setArchived(sender, true),
        [sender, x, y],
      );
    } finally {
      updateSettings({ sessionPeerPromptReminderLimit: original });
    }
  });

  test("a handoff: the recipient's own request being accepted settles what its sender waits for", async () => {
    // A waits on B; B hands the work to C, and C's request back to A is the
    // answer A was waiting for (the second NOT EXISTS of the owed query).
    const [a, b, c] = [seed("ha"), seed("hb"), seed("hc")];
    const waited = owed(a, b);
    const handed = request(b, c);
    peerPromptStore.addParticipant(waited.chainId, c);
    const back = peerPromptStore.enqueueRouted({
      conversationId: `rep-back-${++serial}`,
      chainId: handed.chainId,
      fallbackChainId: `rep-back-fb-${serial}`,
      senderSessionId: c,
      recipientSessionId: a,
      prompt: "answer",
      responseRequested: false,
      participants: [c, a],
      maxHops: 100,
    });
    peerPromptStore.claimNext(a, "d", 1000);
    peerPromptStore.markAdmitted(back.id);
    peerPromptStore.claimNext(c, "d", 1000);
    await assertReported(
      "B's handoff accepted",
      () => peerPromptStore.markAdmitted(handed.id),
      [],
    );
  });

  test("a lost reply about to be pruned: the requester's owed state goes with it", async () => {
    const [c, p] = [seed("lost-c"), seed("lost-p")];
    const r = owed(c, p);
    const reply = peerPromptStore.enqueueRouted({
      conversationId: `rep-lost-${++serial}`,
      chainId: r.chainId,
      fallbackChainId: `rep-lost-fb-${serial}`,
      senderSessionId: p,
      recipientSessionId: c,
      prompt: "report",
      responseRequested: false,
      markRepliedIds: [r.id],
      participants: [p, c],
      maxHops: 100,
    });
    peerPromptStore.cancelPending(c, "test", p);
    assert.equal(peerPromptStore.getById(reply.id)?.status, "cancelled");
    assert.deepEqual(peerPromptStore.outstandingRepliesBySender().get(c), [p]);
    await assertReported(
      "prune the cancelled reply",
      () => peerPromptStore.pruneTerminal(Date.now() + 60_000),
      [c],
    );
  });

  test("a Task linked to two sessions: its status moves both rows", async () => {
    const [s1, s2] = [seed("task-1"), seed("task-2")];
    const task = createTask({
      title: `Reporter ${++serial}`,
      source: { createdBy: "user" },
    });
    linkSessionToTask(String(task.id), { sessionId: s1 });
    linkSessionToTask(String(task.id), { sessionId: s2 });
    await assertReported(
      "Task status",
      () => updateTask(task.id, { status: "doing" }),
      [s1, s2],
    );
    await assertReported("Task deleted", () => deleteTask(task.id), [s1, s2]);
  });

  test("a worktree with two sessions: its row going away moves both", async () => {
    const [w1, w2] = [seed("wt-1"), seed("wt-2")];
    const id = `wt-rep-${++serial}`;
    const now = Date.now();
    worktreeStore.insertWorktree({
      id,
      projectId: "rep",
      mainRepoRoot: "/nonexistent/rep",
      path: `/nonexistent/rep-${serial}`,
      branch: `rep-${serial}`,
      baseBranch: "main",
      baseCommit: "0".repeat(40),
      status: "active",
      mergeStateJson: null,
      createdAt: now,
      updatedAt: now,
      removedAt: null,
    } as Parameters<typeof worktreeStore.insertWorktree>[0]);
    worktreeStore.linkSessionToWorktree(w1, id);
    worktreeStore.linkSessionToWorktree(w2, id);
    const touched = await assertReported(
      "worktree removed",
      () => worktreeStore.finalizeWorktreeRemoval(id, null),
      [],
    );
    assert.ok(touched.has(w1) && touched.has(w2), "both sessions touched");
  });

  test("a handoff enqueue, a credential switch and a spawn edge each report their rows", async () => {
    const s = seed("handoff");
    await assertReported(
      "handoff",
      () =>
        agentHandoffStore.enqueue({
          sessionId: s,
          origin: { kind: "system", source: "test" },
          prompt: "review this",
          hidden: false,
        }),
      [s],
    );
    const switched = seed("switch");
    sessionStore.upsert({
      id: switched,
      harness: "pi",
      agentType: "assistant",
      credentialProfileId: "profile-a",
    });
    await assertReported(
      "credential switch",
      () =>
        sessionStore.switchCredentialProfile(
          switched,
          "profile-a",
          "profile-b",
        ),
      [switched],
    );
    const [parent, child] = [seed("parent"), seed("child")];
    await assertReported(
      "spawn edge",
      () => sessionStore.linkSpawned(parent, child),
      [child],
    );
  });

  test("a pending retitle touches its session as it begins and ends", async () => {
    const s = seed("pending");
    let token: ReturnType<typeof sessionRetitlePending.beginSessionRetitle>;
    await assertReported(
      "retitle begins",
      () => {
        token = sessionRetitlePending.beginSessionRetitle(s);
      },
      [s],
    );
    await assertReported(
      "retitle ends",
      () => sessionRetitlePending.endSessionRetitle(s, token!),
      [s],
    );
  });
});

/* -------------------------- the status graph (T1297-P7) -------------------------- */

describe("the deadline timer's scheduled set", () => {
  test("splits every status into scheduled and closed", () => {
    const all = [
      ...peerDeadlineClock.DEADLINE_SCHEDULED_STATUSES,
      ...peerDeadlineClock.CLOSED_PEER_PROMPT_STATUSES,
    ].sort();
    assert.equal(new Set(all).size, all.length, "no status is both");
    assert.deepEqual(
      [...peerDeadlineClock.CLOSED_PEER_PROMPT_STATUSES].sort(),
      ["cancelled", "expired", "failed", "interrupted", "settled"],
    );
  });

  test("nothing leaves a closed status, through transition() or transitionInTxn", () => {
    const [s, r] = [seed("graph-s"), seed("graph-r")];
    const row = request(s, r);
    peerPromptStore.cancelOne(row.id, "test");
    for (const from of peerDeadlineClock.CLOSED_PEER_PROMPT_STATUSES)
      assert.throws(
        () => peerPromptStore.transition(row.id, [from], "queued"),
        /closed/,
        `${from} → queued is refused`,
      );
    // The in-transaction callers share the guard: a recovery decision that
    // names a closed status as its source is refused the same way.
    assert.throws(
      () =>
        peerPromptStore.transition(row.id, ["queued", "cancelled"], "queued"),
      /closed/,
    );
    assert.equal(peerPromptStore.getById(row.id)?.status, "cancelled");
  });

  test("every deadline-writing export notes its deadline", () => {
    for (const name of ["enqueue", "enqueueRouted", "promoteHeld"] as const)
      assert.match(
        String(peerPromptStore[name]),
        /\b(noteDeadline|transitionInTxn|transition)\)?\(/,
        name,
      );
  });
});

/* ------------------------------- V3: the audit ------------------------------- */

describe("the test-mode audit", () => {
  test("a write with no touch fails the next flush, before a full list could hide it", async () => {
    const viewer = { send: (_message: ServerMessage) => undefined };
    hub.register(viewer);
    try {
      const [quiet, loud] = [seed("audit-quiet"), seed("audit-loud")];
      await hub.flushPendingBroadcastsForTests();
      // Behind the store's back: archives the row, which moves membership,
      // so the flush would otherwise fall back to a full list.
      getDb()
        .prepare("UPDATE session_index SET archived_at_ms = ? WHERE id = ?")
        .run(Date.now(), quiet);
      sessionStore.markRead(loud, Date.now() + 1_000);
      await assert.rejects(
        hub.flushPendingBroadcastsForTests(),
        new RegExp(
          `unreported session row change: ${quiet} [a-z,A-Z]*archived`,
        ),
      );
    } finally {
      hub.unregister(viewer);
      hub.resetSessionListBaselineForTests();
    }
  });
});

/* -------------------------- V4: the production sweep -------------------------- */

describe("the production sweep", () => {
  test("logs an unreported change once, with its fields, and the viewer gets the row", async () => {
    const sent: ServerMessage[] = [];
    const viewer = { send: (message: ServerMessage) => sent.push(message) };
    hub.register(viewer);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    hub.setSessionListAuditForTests(false);
    let stop: (() => void) | undefined;
    try {
      const id = seed("sweep");
      await hub.flushPendingBroadcastsForTests();
      getDb()
        .prepare("UPDATE session_index SET title = ? WHERE id = ?")
        .run("Renamed behind its back", id);
      sent.length = 0;
      vi.useFakeTimers();
      stop = hub.startSessionListSweep();
      await vi.advanceTimersByTimeAsync(60_000 + 100);
      const logged = warn.mock.calls.filter((call) =>
        String(call[0]).includes(`unreported row change: ${id}`),
      );
      assert.equal(logged.length, 1);
      assert.match(String(logged[0]![0]), /title/);
      const row = sent.find(
        (
          message,
        ): message is Extract<ServerMessage, { type: "sessionUpdated" }> =>
          message.type === "sessionUpdated" && message.session.id === id,
      );
      assert.equal(row?.session.title, "Renamed behind its back");
      await vi.advanceTimersByTimeAsync(60_000 + 100);
      assert.equal(
        warn.mock.calls.filter((call) =>
          String(call[0]).includes(`unreported row change: ${id}`),
        ).length,
        1,
        "repaired, so not logged again",
      );
    } finally {
      stop?.();
      vi.useRealTimers();
      hub.setSessionListAuditForTests(true);
      hub.unregister(viewer);
    }
  });

  test("advances a crossed deadline the stopped timer missed", async () => {
    const sent: ServerMessage[] = [];
    const viewer = { send: (message: ServerMessage) => sent.push(message) };
    hub.register(viewer);
    let stop: (() => void) | undefined;
    try {
      const [a, b] = [seed("sweep-a"), seed("sweep-b")];
      vi.useFakeTimers({
        toFake: [
          "Date",
          "setTimeout",
          "setInterval",
          "clearTimeout",
          "clearInterval",
        ],
      });
      // Stopped: no deadline timer, as if it were lost.
      peerDeadlineClock.resetPeerDeadlineClockForTests(Date.now());
      owed(a, b, Date.now() + 1_000);
      await vi.advanceTimersByTimeAsync(100);
      await hub.flushPendingBroadcastsForTests();
      const owedBefore = (await fullPublicProjection()).get(a);
      assert.match(owedBefore!, /awaitingRepliesFrom/);
      sent.length = 0;
      stop = hub.startSessionListSweep();
      await vi.advanceTimersByTimeAsync(60_000 + 100);
      const row = sent.find(
        (
          message,
        ): message is Extract<ServerMessage, { type: "sessionUpdated" }> =>
          message.type === "sessionUpdated" && message.session.id === a,
      );
      assert.ok(row, "the requester's row went out");
      assert.equal(
        (row.session as SessionListItem).awaitingRepliesFrom,
        undefined,
        "owing nothing once its deadline passed",
      );
    } finally {
      stop?.();
      vi.useRealTimers();
      peerDeadlineClock.resetPeerDeadlineClockForTests(Date.now());
      peerDeadlineClock.startPeerDeadlineClock();
      hub.unregister(viewer);
    }
  });
});

/* ------------------------------ V5: wire parity ------------------------------ */

describe("wire parity", () => {
  function listener() {
    const messages: ServerMessage[] = [];
    const viewer = { send: (message: ServerMessage) => messages.push(message) };
    hub.register(viewer);
    return { messages, stop: () => hub.unregister(viewer) };
  }

  test("more changed rows than a delta carries send the whole list", async () => {
    const ids = Array.from({ length: 7 }, (_, i) => seed(`bulk-${i}`));
    await hub.flushPendingBroadcastsForTests();
    const { messages, stop } = listener();
    try {
      for (const id of ids) sessionStore.markRead(id, Date.now() + 5_000);
      await hub.flushPendingBroadcastsForTests();
      assert.equal(
        messages.filter((message) => message.type === "sessions").length,
        1,
      );
      assert.equal(
        messages.filter((message) => message.type === "sessionUpdated").length,
        0,
      );
    } finally {
      stop();
    }
  });

  test("a touched row equal to what was published sends nothing", async () => {
    const id = seed("equal");
    await hub.flushPendingBroadcastsForTests();
    const { messages, stop } = listener();
    try {
      sessionStore.setPeerTurnCap(id, null);
      await hub.flushPendingBroadcastsForTests();
      assert.deepEqual(messages, []);
    } finally {
      stop();
    }
  });

  test("a flush with one touched row builds only that row", async () => {
    const id = seed("cost");
    await hub.flushPendingBroadcastsForTests();
    hub.setSessionListAuditForTests(false);
    sessionStore.markRead(id, Date.now() + 9_000);
    const reads = vi.spyOn(sessionStore, "list");
    try {
      await hub.flushPendingBroadcastsForTests();
      assert.ok(reads.mock.calls.length > 0, "the row was built");
      for (const [opts] of reads.mock.calls)
        assert.deepEqual(opts?.ids, [id], "every store read is the one row");
    } finally {
      hub.setSessionListAuditForTests(true);
    }
  });
});

/* -------------------------------- inbox placement -------------------------------- */

test("an inbox placement reports the sessions it places", async () => {
  const [p1, p2] = [seed("inbox-1"), seed("inbox-2")];
  await assertReported(
    "placement",
    () =>
      inboxPositionStore.setInboxPositions({
        sessions: [
          { id: p1, position: 1 },
          { id: p2, position: 2 },
        ],
        runs: [],
      }),
    [],
  );
});
