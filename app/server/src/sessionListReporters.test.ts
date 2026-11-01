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
import { hub } from "./hub.ts";
import { agentHandoffStore } from "./db/agentHandoffStore.ts";
import { backgroundDeliveryOutboxStore } from "./db/backgroundDeliveryOutboxStore.ts";
import { directPeerChildStore } from "./db/directPeerChildStore.ts";
import { setStateChangeSink, withChangeSet } from "./db/changeSet.ts";
import { getDb, withDbTransaction } from "./db/index.ts";
import { sessionListRevisions } from "./db/sessionListChanges.ts";

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
import { sessionListHiddenProbe } from "./permanentAssistantVisibility.ts";
import * as sessionRetitlePending from "./sessionRetitlePending.ts";
import * as pendingApprovals from "./pendingApprovals.ts";
import * as pullRequestCards from "./pullRequestCards.ts";
import * as peerSpawnRuntimes from "./peerSpawnRuntimes.ts";
import * as checkoutPresence from "./worktrees/checkoutPresence.ts";
import * as questionTool from "./tools/core/questionTool.ts";
import * as piStoreModule from "./piSdk/piStore.ts";
import * as piLiveModule from "./piSdk/PiLiveSession.ts";
import * as claudeStoreModule from "./claudeSdk/claudeSdkStore.ts";
import * as claudeLiveModule from "./claudeSdk/ClaudeSdkSession.ts";
import * as runtimeModule from "./session/runtimeInstance.ts";
import {
  createTask,
  deleteTask,
  linkSessionToTask,
  updateTask,
} from "./tasks.ts";
import { recordSessionRowTouches } from "./test/sessionRowTouches.ts";
import { sessionListClient } from "./test/sessionListClient.ts";
import {
  captureSessionListBaseline,
  resetSessionListAuditBaselineForTests,
  setSessionListAuditForTests,
  startSessionListSweep,
} from "./sessionsTopic.ts";
import { takeStateTopicInvariantsForTests } from "./stateTopicKernel.ts";

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
function fullPublicProjection(): Map<string, string> {
  const hidden = sessionListHiddenProbe();
  const rows = hub.listSessions({ includeArchived: true });
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
 * says changed, which the write touched BEFORE it returned, and which ids'
 * `session_list_revisions` row moved (V1: a touch also stamps).
 */
async function reported(write: () => unknown): Promise<{
  changed: Set<string>;
  touched: Set<string>;
  stamped: Set<string>;
}> {
  const before = fullPublicProjection();
  const revisionsBefore = allRevisions();
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
  const after = fullPublicProjection();
  const changed = new Set<string>();
  for (const id of new Set([...before.keys(), ...after.keys()]))
    if (before.get(id) !== after.get(id)) changed.add(id);
  const stamped = new Set<string>();
  for (const [id, revision] of allRevisions())
    if (revision !== revisionsBefore.get(id)) stamped.add(id);
  return { changed, touched, stamped };
}

/** Every stamped `{id → revision}`. */
function allRevisions(): Map<string, number> {
  const rows = getDb()
    .prepare("SELECT session_id, revision FROM session_list_revisions")
    .all() as { session_id: string; revision: number }[];
  return new Map(rows.map((row) => [row.session_id, row.revision]));
}

/** The write changed at least `expected` and touched every row it changed. */
async function assertReported(
  label: string,
  write: () => unknown,
  expected: readonly string[],
): Promise<Set<string>> {
  const { changed, touched, stamped } = await reported(write);
  for (const id of expected)
    assert.ok(changed.has(id), `${label}: the fixture changes ${id}'s row`);
  for (const id of changed) {
    assert.ok(touched.has(id), `${label}: ${id} changed but was not touched`);
    assert.ok(stamped.has(id), `${label}: ${id} was touched but not stamped`);
  }
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
      dismissInterrupted: "projected-write",
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
      clearForTests: "projected-write",
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
    funnel: ["touchSessionRows", "touchAllSessionRows"],
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
      resetPeerDeadlineClockForTests: "projected-write",
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
  piStoreModule: {
    exports: piStoreModule,
    funnel: ["sessionRowsChanged"],
    kinds: { PiSessionDeletedError: "read", piStore: "projected-write" },
  },
  piLiveModule: {
    exports: piLiveModule,
    funnel: ["sessionRowsChanged", "syncRegistry"],
    kinds: { PiLiveSession: "projected-write" },
  },
  claudeStoreModule: {
    exports: claudeStoreModule,
    funnel: ["onChange", "touchSessionRows"],
    kinds: { claudeSdkStore: "projected-write" },
  },
  claudeLiveModule: {
    exports: claudeLiveModule,
    funnel: ["onChange", "onPersist"],
    kinds: { ClaudeSdkSession: "projected-write" },
  },
  runtimeModule: {
    exports: runtimeModule,
    funnel: ["emitSessionEvent"],
    kinds: { sessionRuntime: "projected-write" },
  },
  pendingApprovals: {
    exports: pendingApprovals,
    funnel: ["touchSessionRows", "resolveApprovalExclusive", "autoApprove"],
    kinds: {
      registerApprovalExecutor: "non-projected-write",
      reconcileLegacyAgentDefinitionCard: "read",
      reconcileLegacyPartialApprovalCard: "read",
      approvalForId: "read",
      subscribePendingApprovalChanges: "read",
      hasPendingApproval: "read",
      pendingApprovalSessionIds: "read",
      approvalsForSession: "read",
      withApprovalBlocks: "read",
      approvalCardReference: "read",
      proposalSnapshot: "read",
      createApproval: "projected-write",
      resolveApproval: "projected-write",
      approvalGrantsForSession: "read",
      approvalGrantsPayload: "read",
      // Grants affect future auto-approval admission, not existing list rows.
      grantRequestedOperations: "non-projected-write",
      effectiveGrantScope: "read",
      grantApprovalForSession: "non-projected-write",
      setApprovalGrantScope: "non-projected-write",
      revokeApprovalGrant: "non-projected-write",
      runAutoApprovals: "projected-write",
      // Schedules the same autoApprove path, without itself changing a card.
      recoverAutoApprovalsOnBoot: "non-projected-write",
      setAutoApprovalDrainForTests: "non-projected-write",
      setApprovalBroadcastForTests: "non-projected-write",
    },
  },
  pullRequestCards: {
    exports: pullRequestCards,
    funnel: ["insert", "persist", "clear"],
    kinds: {
      pullRequestCardRecord: "read",
      pullRequestCardById: "read",
      cardsForSession: "read",
      pullRequestCardsForWorktree: "read",
      pullRequestActivityRecords: "read",
      pullRequestCardsWithBusyAction: "read",
      pullRequestCardLinksByPullRequest: "read",
      openPullRequestCards: "read",
      pullRequestSummariesBySession: "read",
      choosingTaskSessionIds: "read",
      hasChoosingTaskCard: "read",
      pullRequestSummaryForWorktree: "read",
      subscribeChoosingTaskCardChanges: "read",
      withPullRequestCardBlocks: "read",
      createPullRequestCard: "projected-write",
      patchPullRequestCard: "projected-write",
      patchPullRequestCardObservation: "projected-write",
      resetPullRequestCardsStoreForTests: "projected-write",
      // Provider observation tokens live only in server-side context.
      beginPullRequestCardObservation: "non-projected-write",
      setPullRequestCardBroadcastForTests: "non-projected-write",
    },
  },
  peerSpawnRuntimes: {
    exports: peerSpawnRuntimes,
    funnel: ["setPeerTurnCap", "record", "clearForTests", "touchSessionRows"],
    kinds: {
      directPeerTurnCapOf: "read",
      setSessionPeerTurnCap: "projected-write",
      setPeerTurnCapChangedHook: "non-projected-write",
      modelsForProfile: "read",
      accountModelOptions: "read",
      peerRuntimeRoster: "read",
      PeerRuntimeRefusedError: "read",
      resolveApprovedPeerRuntime: "read",
      directPeerCostClass: "read",
      withDirectAdmission: "non-projected-write",
      recordDirectPeerChild: "projected-write",
      resetDirectPeerChildrenForTests: "projected-write",
      directSlotCounter: "read",
      oldestInFlightHold: "read",
      inFlightHoldsBefore: "read",
      // Allocated tickets are younger than every existing row. The returned
      // settleHold method is a writer, exercised against a younger held child.
      admitDirectPeerTurns: "non-projected-write",
      directSpawnReportingSuffix: "read",
      withReportingRoute: "read",
    },
  },
  checkoutPresence: {
    exports: checkoutPresence,
    funnel: ["apply", "notifyPresenceChange", "listener"],
    kinds: {
      presenceKey: "read",
      notifyPresenceChange: "projected-write",
      onPresenceChange: "read",
      // Queues a probe; its callback writes through apply, not on this read.
      presenceNow: "read",
      checkPresence: "projected-write",
      notePresent: "projected-write",
      forgetPresence: "projected-write",
      trackPresenceWork: "non-projected-write",
      presenceCountsForTests: "read",
      presenceQueuedForTests: "read",
      resetPresenceForTests: "projected-write",
      flushPresenceForTests: "read",
    },
  },
  questionTool: {
    exports: {
      ...questionTool,
      askQuestionsTool: questionTool.askQuestionsTool.execute,
    },
    funnel: ["registerPendingQuestion", "emitQuestionChange"],
    kinds: {
      getAnsweredAgentQuestions: "read",
      QUESTION_ANSWERS_MARKER: "read",
      subscribeAgentQuestionChanges: "read",
      getPendingAgentQuestions: "read",
      hasPendingAgentQuestion: "read",
      questionRequestIdFromToolResult: "read",
      // Transcript tool-call association is not a list field.
      relinkAgentQuestionToolCallId: "non-projected-write",
      submitAgentQuestionResponse: "projected-write",
      clearPendingQuestion: "projected-write",
      askQuestionsTool: "projected-write",
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
        const value = exports[name];
        const fn = typeof value === "function" ? value : value?.constructor;
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
      markRepliedIds: [],
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
      [a],
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
  test("a write with no touch fails the next flush and is recorded", async () => {
    const client = sessionListClient();
    try {
      const [quiet, loud] = [seed("audit-quiet"), seed("audit-loud")];
      await hub.flushPendingBroadcastsForTests();
      // Behind the store's back: archives the row, which no stamp covers.
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
      assert.equal(takeStateTopicInvariantsForTests().length, 1);
    } finally {
      client.close();
      resetSessionListAuditBaselineForTests();
    }
  });
});

/* -------------------------- V4: the production sweep -------------------------- */

describe("the production sweep", () => {
  test("logs an unreported change once, with its fields, and the viewer gets the row", async () => {
    const client = sessionListClient();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    setSessionListAuditForTests(false);
    let stop: (() => void) | undefined;
    try {
      const id = seed("sweep");
      await hub.flushPendingBroadcastsForTests();
      captureSessionListBaseline();
      getDb()
        .prepare("UPDATE session_index SET title = ? WHERE id = ?")
        .run("Renamed behind its back", id);
      client.clear();
      vi.useFakeTimers();
      stop = startSessionListSweep();
      await vi.advanceTimersByTimeAsync(60_000 + 100);
      const logged = warn.mock.calls.filter((call) =>
        String(call[0]).includes(`unreported row change: ${id}`),
      );
      assert.equal(logged.length, 1);
      assert.match(String(logged[0]![0]), /title/);
      assert.ok(client.upserted().includes(id));
      assert.equal(client.row(id)?.title, "Renamed behind its back");
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
      setSessionListAuditForTests(true);
      resetSessionListAuditBaselineForTests();
      client.close();
    }
  });

  test("advances a crossed deadline the stopped timer missed", async () => {
    const client = sessionListClient();
    setSessionListAuditForTests(false);
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
      captureSessionListBaseline();
      const owedBefore = fullPublicProjection().get(a);
      assert.match(owedBefore!, /awaitingRepliesFrom/);
      client.clear();
      stop = startSessionListSweep();
      await vi.advanceTimersByTimeAsync(60_000 + 100);
      assert.ok(client.upserted().includes(a), "the requester's row went out");
      assert.equal(
        client.row(a)?.awaitingRepliesFrom,
        undefined,
        "owing nothing once its deadline passed",
      );
    } finally {
      stop?.();
      vi.useRealTimers();
      setSessionListAuditForTests(true);
      resetSessionListAuditBaselineForTests();
      peerDeadlineClock.resetPeerDeadlineClockForTests(Date.now());
      peerDeadlineClock.startPeerDeadlineClock();
      client.close();
    }
  });
});

/* ------------------------------ V5: wire shape ------------------------------ */

describe("wire shape", () => {
  test("a bulk change publishes one batch of row upserts, never a list", async () => {
    const ids = Array.from({ length: 7 }, (_, i) => seed(`bulk-${i}`));
    await hub.flushPendingBroadcastsForTests();
    const client = sessionListClient();
    try {
      client.clear();
      for (const id of ids) sessionStore.markRead(id, Date.now() + 5_000);
      await hub.flushPendingBroadcastsForTests();
      assert.equal(client.events().length, 1);
      assert.deepEqual(new Set(client.upserted()), new Set(ids));
      assert.equal(
        client.sent.filter((message) => message.type === "sessionList").length,
        0,
      );
    } finally {
      client.close();
    }
  });

  test("a touched row equal to what was published goes out at a new revision", async () => {
    const id = seed("equal");
    const client = sessionListClient();
    try {
      await hub.flushPendingBroadcastsForTests();
      const before = client.row(id);
      client.clear();
      sessionStore.setPeerTurnCap(id, null);
      await hub.flushPendingBroadcastsForTests();
      const [event] = client.events().flatMap((batch) => batch.events);
      assert.equal(event?.id, id);
      assert.deepEqual(client.row(id), before);
    } finally {
      client.close();
    }
  });

  test("a flush with one touched row builds only that row", async () => {
    const id = seed("cost");
    await hub.flushPendingBroadcastsForTests();
    setSessionListAuditForTests(false);
    sessionStore.markRead(id, Date.now() + 9_000);
    const reads = vi.spyOn(sessionStore, "list");
    try {
      await hub.flushPendingBroadcastsForTests();
      assert.ok(reads.mock.calls.length > 0, "the row was built");
      for (const [opts] of reads.mock.calls)
        assert.deepEqual(opts?.ids, [id], "every store read is the one row");
    } finally {
      setSessionListAuditForTests(true);
      resetSessionListAuditBaselineForTests();
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
    [p1, p2],
  );
});

/* ------------------------------- V1: the stamp ------------------------------- */

describe("a touch stamps through the change set", () => {
  /** Records every committed hand-off, forwarding to the hub's sink. */
  function handOffs() {
    const seen: [string, string[]][] = [];
    const previous = setStateChangeSink((topic, ids) => {
      seen.push([topic, [...ids]]);
      previous?.(topic, ids);
    });
    return {
      sessions: () =>
        seen.filter(([topic]) => topic === "sessions").map(([, ids]) => ids),
      stop: () => setStateChangeSink(previous),
    };
  }
  const revisionOf = (id: string) => sessionListRevisions([id]).get(id) ?? 0;

  test("a rolled-back change set stamps nothing and reports nothing", () => {
    const id = seed("rollback");
    const before = revisionOf(id);
    const sink = handOffs();
    try {
      assert.throws(() =>
        withChangeSet(() => {
          sessionStore.markRead(id, Date.now() + 7_000);
          throw new Error("roll back");
        }),
      );
    } finally {
      sink.stop();
    }
    assert.equal(revisionOf(id), before);
    assert.deepEqual(sink.sessions(), []);
  });

  test("inside a plain transaction the stamp is visible and the report immediate", () => {
    const id = seed("plain-txn");
    const before = revisionOf(id);
    const sink = handOffs();
    try {
      withDbTransaction(() => {
        sessionStore.markRead(id, Date.now() + 7_000);
        assert.ok(revisionOf(id) > before, "stamped in the transaction");
        assert.deepEqual(sink.sessions(), [[id]], "reported before commit");
      });
    } finally {
      sink.stop();
    }
    assert.ok(revisionOf(id) > before);
  });
});
