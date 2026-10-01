/**
 * Decision concurrency for the approval subsystem.
 *
 * `prepare` and `execute` are both async, so the card's `pending` status cannot
 * double as a claim: between reading it and writing `executing` the event loop
 * yields, and the store is a plain file with no compare-and-set. Two browsers
 * on the same card — or one user pressing Reject while an Approve is still
 * resolving models — must not be able to run an action twice, and must never be
 * able to run one the user explicitly refused.
 *
 * The commit kind is borrowed as a stand-in: this file registers the only
 * executor it has, so the tests own the timing completely.
 */
import { afterEach, beforeEach, expect, test } from "vitest";
import type { ApprovalCard, ApprovalBody } from "@assistant/shared";
import {
  approvalsForSession,
  createApproval,
  hasPendingApproval,
  registerApprovalExecutor,
  resolveApproval,
  setApprovalBroadcastForTests,
} from "./pendingApprovals.ts";

const SESSION = "approval-race";

/** Gate an async step open by hand, so a decision can be held mid-flight. */
function gate() {
  let open!: () => void;
  const passed = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { open, passed };
}

let prepareGate: ReturnType<typeof gate> | null;
let executions: string[];

function pendingCommitCard(): ApprovalCard {
  return createApproval({
    sessionId: SESSION,
    kind: "commit",
    title: "Commit",
    body: { kind: "commit", message: "wip", files: ["a.ts"] },
  });
}

beforeEach(() => {
  setApprovalBroadcastForTests(() => {});
  prepareGate = null;
  executions = [];
  registerApprovalExecutor("commit", {
    async prepare(card: ApprovalCard): Promise<ApprovalBody> {
      if (prepareGate) await prepareGate.passed;
      return card.body;
    },
    async execute(card) {
      executions.push(card.id);
      return { resultSummary: "done" };
    },
  });
});

afterEach(() => setApprovalBroadcastForTests(null));

test("two concurrent approvals execute the action exactly once", async () => {
  const card = pendingCommitCard();
  prepareGate = gate();

  const first = resolveApproval(card.id, "approved");
  const second = resolveApproval(card.id, "approved");
  prepareGate.open();

  const [a, b] = await Promise.allSettled([first, second]);
  expect(executions).toEqual([card.id]);
  expect(a.status).toBe("fulfilled");
  // The loser reads the card the winner left behind and is told so.
  expect(b.status).toBe("rejected");
  expect(String((b as PromiseRejectedResult).reason)).toMatch(
    /already executed/,
  );
  expect(approvalsForSession(SESSION).at(-1)?.status).toBe("executed");
});

test("a reject landing during an approve's prepare is not overridden", async () => {
  const card = pendingCommitCard();
  prepareGate = gate();

  // The approve enters first and parks inside `prepare`; the reject queues
  // behind it rather than racing it.
  const approve = resolveApproval(card.id, "approved");
  const reject = resolveApproval(card.id, "rejected");
  prepareGate.open();
  const [, second] = await Promise.allSettled([approve, reject]);

  // Decisions are FIFO, so the approve finishes and the reject is told the card
  // is settled. The failure this guards is the reverse: the reject completing
  // mid-prepare and the approve then executing what the user had refused.
  expect(approvalsForSession(SESSION).at(-1)?.status).toBe("executed");
  expect(executions).toEqual([card.id]);
  expect(second.status).toBe("rejected");
  expect(String((second as PromiseRejectedResult).reason)).toMatch(
    /already executed/,
  );
});

test("a rejected card can never be executed by a later approval", async () => {
  const card = pendingCommitCard();

  await resolveApproval(card.id, "rejected");
  await expect(resolveApproval(card.id, "approved")).rejects.toThrow(
    /already rejected/,
  );

  expect(executions).toEqual([]);
  expect(approvalsForSession(SESSION).at(-1)?.status).toBe("rejected");
});

test("a prepare that throws leaves the card pending for a real second attempt", async () => {
  const card = pendingCommitCard();
  let fail = true;
  registerApprovalExecutor("commit", {
    async prepare(current: ApprovalCard): Promise<ApprovalBody> {
      if (fail) throw new Error("not runnable right now");
      return current.body;
    },
    async execute(current) {
      executions.push(current.id);
      return { resultSummary: "done" };
    },
  });

  await expect(resolveApproval(card.id, "approved")).rejects.toThrow(
    /not runnable/,
  );
  expect(approvalsForSession(SESSION).at(-1)?.status).toBe("pending");
  expect(executions).toEqual([]);

  fail = false;
  await resolveApproval(card.id, "approved");
  expect(executions).toEqual([card.id]);
});

function commitCard(
  sessionId: string,
  message: string,
  supersedes?: (earlier: ApprovalCard) => boolean,
): ApprovalCard {
  return createApproval({
    sessionId,
    kind: "commit",
    title: "Commit",
    body: { kind: "commit", message, files: ["a.ts"] },
    ...(supersedes ? { supersedes } : {}),
  });
}

const sameMessage =
  (message: string) =>
  (earlier: ApprovalCard): boolean =>
    earlier.body.kind === "commit" && earlier.body.message === message;

test("a new card supersedes only the matching pending cards of its own session", async () => {
  const session = "approval-supersede";
  const stale = commitCard(session, "merge #1");
  const unrelated = commitCard(session, "merge #2");
  const settledCard = commitCard(session, "merge #1");
  await resolveApproval(settledCard.id, "rejected");
  const elsewhere = commitCard("approval-supersede-other", "merge #1");

  const fresh = commitCard(session, "merge #1", sameMessage("merge #1"));

  const byId = new Map(
    approvalsForSession(session).map((card) => [card.id, card]),
  );
  expect(byId.get(stale.id)).toMatchObject({
    status: "superseded",
    supersededBy: fresh.id,
  });
  expect(byId.get(unrelated.id)?.status).toBe("pending");
  expect(byId.get(settledCard.id)?.status).toBe("rejected");
  expect(byId.get(fresh.id)?.status).toBe("pending");
  expect(approvalsForSession("approval-supersede-other")).toEqual([
    expect.objectContaining({ id: elsewhere.id, status: "pending" }),
  ]);

  await expect(resolveApproval(stale.id, "approved")).rejects.toThrow(
    /already superseded/,
  );
  expect(executions).toEqual([]);

  await resolveApproval(unrelated.id, "rejected");
  await resolveApproval(fresh.id, "rejected");
  expect(hasPendingApproval(session)).toBe(false);
});

test("a card whose decision is in flight is not superseded", async () => {
  const session = "approval-supersede-inflight";
  const card = commitCard(session, "merge #3");
  prepareGate = gate();
  const approve = resolveApproval(card.id, "approved");

  const fresh = commitCard(session, "merge #3", sameMessage("merge #3"));
  prepareGate.open();
  await approve;

  const byId = new Map(
    approvalsForSession(session).map((current) => [current.id, current]),
  );
  expect(byId.get(card.id)?.status).toBe("executed");
  expect(byId.get(fresh.id)?.status).toBe("pending");
  expect(executions).toEqual([card.id]);
});
