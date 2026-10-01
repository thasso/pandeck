/**
 * "Approve for session" grants.
 *
 * A grant is recorded per OPERATION when the user approves for the session; a
 * later card those grants fully cover is created without blocking the session
 * and runs only on the session's idle edge (`runAutoApprovals`), because the
 * proposing turn may still hold what the executor needs. A revoke that lands
 * first turns it back into an ordinary pending card. Outcomes go to the REAL
 * durable handoff queue; only the drain that delivers them is stubbed.
 */
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { agentHandoffStore } from "./db/agentHandoffStore.ts";
import type {
  ApprovalBody,
  ApprovalCard,
  ApprovalGrant,
  JiraIssueMutationOperation,
} from "@assistant/shared";
import {
  approvalForId,
  approvalGrantsForSession,
  createApproval,
  hasPendingApproval,
  registerApprovalExecutor,
  resolveApproval,
  revokeApprovalGrant,
  runAutoApprovals,
  setApprovalBroadcastForTests,
  setAutoApprovalDrainForTests,
} from "./pendingApprovals.ts";

let executions: string[];
/** Runs inside `prepare`, so a test can act while a decision is mid-flight. */
let duringPrepare: (() => void) | null;
/** Awaited inside `execute`, so a test can hold a card mid-execution. */
let duringExecute: ((card: ApprovalCard) => Promise<void>) | null;
/** Sessions whose handoff drain was started, in order. */
let drained: string[];

/** The outcome prompts durably queued for a session, oldest first. */
function queuedOutcomes(sessionId: string): string[] {
  return agentHandoffStore
    .listForSession(sessionId)
    .map((record) => record.prompt);
}
let grantBroadcasts: Array<{ sessionId: string; grants: ApprovalGrant[] }>;

function commitCard(sessionId: string): ApprovalCard {
  return createApproval({
    sessionId,
    kind: "commit",
    title: "Commit",
    body: { kind: "commit", message: "wip", files: ["a.ts"] },
  });
}

function jiraCard(
  sessionId: string,
  operations: JiraIssueMutationOperation[],
): ApprovalCard {
  return createApproval({
    sessionId,
    kind: "jiraIssue",
    title: "Jira",
    body: {
      kind: "jiraIssue",
      items: operations.map((operation, index) => ({
        clientId: `c${index}`,
        issueKey: "PA-1",
        operation,
        fieldChanges: [],
      })),
    },
  });
}

beforeEach(() => {
  executions = [];
  duringPrepare = null;
  duringExecute = null;
  drained = [];
  grantBroadcasts = [];
  setApprovalBroadcastForTests(
    () => {},
    (sessionId, grants) => grantBroadcasts.push({ sessionId, grants }),
  );
  setAutoApprovalDrainForTests(async (sessionId) => {
    drained.push(sessionId);
  });
  const executor = {
    async prepare(card: ApprovalCard): Promise<ApprovalBody> {
      duringPrepare?.();
      return card.body;
    },
    async execute(card: ApprovalCard) {
      await duringExecute?.(card);
      executions.push(card.id);
      return { resultSummary: "done" };
    },
  };
  registerApprovalExecutor("commit", executor);
  registerApprovalExecutor("jiraIssue", executor);
});

afterEach(() => {
  setApprovalBroadcastForTests(null);
  setAutoApprovalDrainForTests(null);
});

test("approving for the session grants the card's operations", async () => {
  const session = `grant-${randomUUID()}`;
  const first = commitCard(session);

  const { card } = await resolveApproval(first.id, "approved", undefined, {
    forSession: true,
  });

  expect(card.status).toBe("executed");
  expect(card.grantedForSession).toBe(true);
  expect(approvalGrantsForSession(session)).toEqual([
    {
      key: "commit",
      grantedAt: expect.any(Number),
      sourceApprovalId: first.id,
    },
  ]);
  expect(grantBroadcasts.at(-1)?.sessionId).toBe(session);
});

test("a covered card blocks nobody and runs on the idle edge", async () => {
  const session = `grant-${randomUUID()}`;
  await resolveApproval(commitCard(session).id, "approved", undefined, {
    forSession: true,
  });
  executions = [];

  const next = commitCard(session);
  expect(next.autoApproved).toBe(true);
  expect(hasPendingApproval(session)).toBe(false);
  // Nothing runs while the proposing turn is still going.
  await Promise.resolve();
  expect(executions).toEqual([]);

  await runAutoApprovals(session);

  expect(executions).toEqual([next.id]);
  expect(approvalForId(next.id)?.status).toBe("executed");
  const outcomes = queuedOutcomes(session);
  expect(outcomes).toHaveLength(1);
  expect(outcomes[0]).toMatch(/APPROVED automatically/);
  expect(drained).toEqual([session]);
});

test("a grant never reaches another session", async () => {
  const session = `grant-${randomUUID()}`;
  await resolveApproval(commitCard(session).id, "approved", undefined, {
    forSession: true,
  });

  const other = `grant-${randomUUID()}`;
  const card = commitCard(other);

  expect(card.autoApproved).toBeUndefined();
  expect(hasPendingApproval(other)).toBe(true);
});

test("a mixed batch waits unless every operation in it is granted", async () => {
  const session = `grant-${randomUUID()}`;
  await resolveApproval(
    jiraCard(session, ["comment"]).id,
    "approved",
    undefined,
    { forSession: true },
  );

  const mixed = jiraCard(session, ["comment", "edit"]);
  expect(mixed.autoApproved).toBeUndefined();

  const covered = jiraCard(session, ["comment", "comment"]);
  expect(covered.autoApproved).toBe(true);
});

test("a grant revoked before the idle edge hands the card back", async () => {
  const session = `grant-${randomUUID()}`;
  await resolveApproval(commitCard(session).id, "approved", undefined, {
    forSession: true,
  });
  executions = [];
  const next = commitCard(session);

  revokeApprovalGrant(session, "commit");
  await runAutoApprovals(session);

  expect(executions).toEqual([]);
  expect(approvalForId(next.id)?.status).toBe("pending");
  expect(approvalForId(next.id)?.autoApproved).toBeUndefined();
  expect(hasPendingApproval(session)).toBe(true);
  expect(approvalGrantsForSession(session)).toEqual([]);
});

test("a plain approval grants nothing", async () => {
  const session = `grant-${randomUUID()}`;
  const { card } = await resolveApproval(commitCard(session).id, "approved");

  expect(card.grantedForSession).toBeUndefined();
  expect(approvalGrantsForSession(session)).toEqual([]);
  expect(commitCard(session).autoApproved).toBeUndefined();
});

test("a revoke that lands during prepare still stops the card", async () => {
  const session = `grant-${randomUUID()}`;
  await resolveApproval(commitCard(session).id, "approved", undefined, {
    forSession: true,
  });
  executions = [];
  const next = commitCard(session);

  duringPrepare = () => revokeApprovalGrant(session, "commit");
  await runAutoApprovals(session);

  expect(executions).toEqual([]);
  expect(approvalForId(next.id)?.status).toBe("pending");
  expect(approvalForId(next.id)?.autoApproved).toBeUndefined();
  expect(approvalForId(next.id)?.error).toBeUndefined();
  expect(queuedOutcomes(session)).toEqual([]);
  expect(drained).toEqual([]);
});

test("every covered card runs before delivery starts", async () => {
  const session = `grant-${randomUUID()}`;
  await resolveApproval(commitCard(session).id, "approved", undefined, {
    forSession: true,
  });
  executions = [];
  const first = commitCard(session);
  const second = commitCard(session);
  // Delivering an outcome starts the agent's next turn, which must not run
  // beside a card still to go.
  const executedAtDrain: string[][] = [];
  setAutoApprovalDrainForTests(async () => {
    executedAtDrain.push([...executions]);
  });

  await runAutoApprovals(session);

  expect(executions).toEqual([first.id, second.id]);
  expect(executedAtDrain).toEqual([[first.id, second.id]]);
  expect(queuedOutcomes(session)).toHaveLength(2);
});

/**
 * A card that executed is terminal, so boot recovery never finds it again: if
 * its outcome waited in memory for the rest of the batch, a later card that
 * hangs — or a restart while it runs — would lose the decision for good.
 */
test("an executed card's outcome is durable before a later card finishes", async () => {
  const session = `grant-${randomUUID()}`;
  await resolveApproval(commitCard(session).id, "approved", undefined, {
    forSession: true,
  });
  const first = commitCard(session);
  const second = commitCard(session);
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let secondStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    secondStarted = resolve;
  });
  duringExecute = async (card) => {
    if (card.id !== second.id) return;
    secondStarted();
    await held;
  };

  const batch = runAutoApprovals(session);
  await started;

  expect(approvalForId(first.id)?.status).toBe("executed");
  expect(approvalForId(second.id)?.status).toBe("executing");
  expect(queuedOutcomes(session)).toHaveLength(1);
  expect(drained).toEqual([]);

  release();
  await batch;
  expect(queuedOutcomes(session)).toHaveLength(2);
  expect(drained).toEqual([session]);
});

/**
 * The outcome is queued in the same synchronous step that records the card as
 * terminal: by the time anything else can happen — here, the terminal card's
 * broadcast — the agent's handoff row already exists.
 */
test("an auto-approval's outcome is queued before its terminal card is broadcast", async () => {
  const session = `grant-${randomUUID()}`;
  await resolveApproval(commitCard(session).id, "approved", undefined, {
    forSession: true,
  });
  const next = commitCard(session);
  const queuedAtBroadcast: number[] = [];
  setApprovalBroadcastForTests((_sessionId, card) => {
    if (card.id === next.id && card.status === "executed")
      queuedAtBroadcast.push(queuedOutcomes(session).length);
  });

  await runAutoApprovals(session);

  expect(queuedAtBroadcast).toEqual([1]);
});

/**
 * No browser asked for an auto-approval, so a handoff queue that refuses the
 * outcome must show on the card — without turning an action that happened
 * into a failure.
 */
test("an outcome the queue refuses is reported on the card, which stays executed", async () => {
  const session = `grant-${randomUUID()}`;
  await resolveApproval(commitCard(session).id, "approved", undefined, {
    forSession: true,
  });
  executions = [];
  const next = commitCard(session);
  const broadcasts: ApprovalCard[] = [];
  setApprovalBroadcastForTests((_sessionId, card) => {
    if (card.id === next.id) broadcasts.push(card);
  });
  const enqueue = vi
    .spyOn(agentHandoffStore, "enqueue")
    .mockImplementation(() => {
      throw new Error("SQLITE_FULL: database or disk is full");
    });
  try {
    await runAutoApprovals(session);
  } finally {
    enqueue.mockRestore();
  }

  expect(executions).toEqual([next.id]);
  const card = approvalForId(next.id);
  expect(card?.status).toBe("executed");
  expect(card?.error).toMatch(/could not be told the outcome: SQLITE_FULL/);
  expect(broadcasts.at(-1)?.error).toBe(card?.error);
  expect(drained).toEqual([]);
});
