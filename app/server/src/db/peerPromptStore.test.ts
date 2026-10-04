import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { getDb } from "./index.ts";
import {
  OUTSTANDING_REPLIES_SQL,
  peerPromptStore as store,
  PeerPromptHopLimitError,
} from "./peerPromptStore.ts";

let seq = 0;
function conv(): { conversationId: string; chainId: string } {
  const id = `c${seq++}`;
  return { conversationId: id, chainId: store.createChain(`chain-${id}`) };
}

function enqueue(
  recipient: string,
  over: Partial<{
    sender: string;
    responseRequested: boolean;
    expiresAt: number;
  }> = {},
) {
  const { conversationId, chainId } = conv();
  return store.enqueue({
    conversationId,
    chainId,
    hop: store.reserveHop(chainId),
    senderSessionId: over.sender ?? "sender-A",
    recipientSessionId: recipient,
    prompt: "hi",
    responseRequested: over.responseRequested ?? false,
    ...(over.expiresAt ? { expiresAt: over.expiresAt } : {}),
  });
}

describe("peerPromptStore", () => {
  it("enqueues in FIFO order per recipient and preserves rows under concurrency", async () => {
    const recipient = `r-${seq++}`;
    const created = await Promise.all(
      Array.from({ length: 20 }, () =>
        Promise.resolve().then(() => enqueue(recipient)),
      ),
    );
    const pending = store.listPendingForRecipient(recipient);
    assert.equal(pending.length, 20);
    // queue_seq strictly increasing => stable FIFO.
    const seqs = pending.map((p) => p.queueSeq);
    assert.deepEqual(
      seqs,
      [...seqs].sort((a, b) => a - b),
    );
    assert.equal(new Set(created.map((c) => c.id)).size, 20);
  });

  it("claims the oldest queued row atomically and leases it", () => {
    const recipient = `r-${seq++}`;
    const first = enqueue(recipient);
    enqueue(recipient);
    const claimed = store.claimNext(recipient, "drainer-1", 60_000);
    assert.equal(claimed?.id, first.id);
    assert.equal(claimed?.status, "dispatching");
    assert.equal(claimed?.leaseOwner, "drainer-1");
    assert.equal(store.listPendingForRecipient(recipient).length, 1);
  });

  it("cancels only waiting rows from the selected sender", () => {
    const recipient = `r-${seq++}`;
    const queued = enqueue(recipient, { sender: "sender-A" });
    const retrying = enqueue(recipient, { sender: "sender-A" });
    const other = enqueue(recipient, { sender: "sender-B" });
    store.claimNext(recipient, "d", 1000);
    store.markRetryable(queued.id, "transient", 60_000);

    const cancelled = store.cancelPending(
      recipient,
      "sender retracted it",
      "sender-A",
    );

    assert.deepEqual(
      cancelled.map((row) => row.id),
      [queued.id, retrying.id],
    );
    assert.equal(store.getById(queued.id)?.status, "cancelled");
    assert.equal(store.getById(retrying.id)?.status, "cancelled");
    assert.equal(
      store.getById(retrying.id)?.failureReason,
      "sender retracted it",
    );
    assert.equal(store.getById(other.id)?.status, "queued");
    assert.deepEqual(
      store.getById(queued.id)?.transitions.map((entry) => entry.to),
      ["queued", "dispatching", "retryable_failed", "cancelled"],
    );
  });

  it("clears a recipient queue without cancelling a row already dispatching", () => {
    const recipient = `r-${seq++}`;
    const dispatching = enqueue(recipient, { sender: "sender-A" });
    const queued = enqueue(recipient, { sender: "sender-B" });
    store.claimNext(recipient, "d", 60_000);

    const cancelled = store.cancelPending(recipient, "coordinator stopped it");

    assert.deepEqual(
      cancelled.map((row) => row.id),
      [queued.id],
    );
    assert.equal(store.getById(dispatching.id)?.status, "dispatching");
    assert.equal(store.getById(queued.id)?.status, "cancelled");
  });

  it("rejects illegal/stale compare-and-set transitions", () => {
    const m = enqueue(`r-${seq++}`);
    // Cannot admit a queued row (must be dispatching first).
    assert.equal(store.markAdmitted(m.id), undefined);
    const claimed = store.claimNext(m.recipientSessionId, "d", 1000)!;
    const admitted = store.markAdmitted(claimed.id);
    assert.equal(admitted?.status, "admitted");
    // A second admit is now a no-op (stale).
    assert.equal(store.markAdmitted(claimed.id), undefined);
  });

  it("drives the full lifecycle including awaiting_response and replied", () => {
    const m = enqueue(`r-${seq++}`, { responseRequested: true });
    store.claimNext(m.recipientSessionId, "d", 1000);
    store.markAdmitted(m.id);
    store.markAcknowledged(m.id);
    const completed = store.markCompleted(m.id);
    assert.equal(completed?.status, "awaiting_response");
    const replied = store.markReplied(m.id, "reply-msg-id");
    assert.equal(replied?.status, "replied");
    assert.equal(replied?.repliedByMessageId, "reply-msg-id");
  });

  describe("who still owes a sender a reply", () => {
    /** A delivered request whose turn ended without the answer. */
    const unanswered = (
      sender: string,
      recipient: string,
      chainId?: string,
    ) => {
      const chain = chainId ?? store.createChain(`owed-${seq++}`);
      const m = store.enqueue({
        conversationId: `owed-conv-${seq++}`,
        chainId: chain,
        hop: store.reserveHop(chain),
        senderSessionId: sender,
        recipientSessionId: recipient,
        prompt: "please report back",
        responseRequested: true,
      });
      store.claimNext(recipient, "d", 1000);
      store.markAdmitted(m.id);
      store.markCompleted(m.id);
      return { ...m, chainId: chain };
    };
    /** A later prompt from `sender` to `recipient` on `chainId`, queued. */
    const enqueueLater = (
      sender: string,
      recipient: string,
      chainId?: string,
    ) => {
      const chain = chainId ?? store.createChain(`later-${seq++}`);
      return store.enqueue({
        conversationId: `later-conv-${seq++}`,
        chainId: chain,
        hop: store.reserveHop(chain),
        senderSessionId: sender,
        recipientSessionId: recipient,
        prompt: "report",
        responseRequested: false,
      });
    };
    /** …and delivered: it REACHED the recipient. */
    const send = (sender: string, recipient: string, chainId?: string) => {
      const m = enqueueLater(sender, recipient, chainId);
      store.claimNext(recipient, "d", 1000);
      store.markAdmitted(m.id);
      return m;
    };
    const owedTo = (sender: string) =>
      store.outstandingRepliesBySender().get(sender);

    it("counts a turn that ended without the answer, until it is answered", () => {
      const c = `owed-c-${seq++}`;
      const r = `owed-r-${seq++}`;
      const m = unanswered(c, r);
      assert.deepEqual(owedTo(c), [r]);
      store.markReplied(m.id, "reply");
      assert.equal(owedTo(c), undefined);
    });

    it("does not count a request still being delivered", () => {
      const c = `owed-c-${seq++}`;
      const r = `owed-r-${seq++}`;
      enqueue(r, { sender: c, responseRequested: true });
      assert.equal(owedTo(c), undefined, "queued: delivery is in progress");
    });

    it("takes a report forwarded through a third peer as the answer", () => {
      // C asks I; I hands the work to R; R reports to C on the same chain.
      const c = `owed-c-${seq++}`;
      const i = `owed-i-${seq++}`;
      const r = `owed-rev-${seq++}`;
      const request = unanswered(c, i);
      assert.deepEqual(owedTo(c), [i]);
      send(i, r, request.chainId); // I hands the work on, on the same chain
      assert.deepEqual(owedTo(c), [i], "handing on is not yet the answer");
      send(r, c, request.chainId);
      assert.equal(owedTo(c), undefined);
    });

    it("does not let one peer's reply answer for a peer beside it on the chain", () => {
      // C spawns two reviewers in one turn: both requests share a chain.
      const c = `owed-c-${seq++}`;
      const sol = `owed-sol-${seq++}`;
      const opus = `owed-opus-${seq++}`;
      const first = unanswered(c, sol);
      unanswered(c, opus, first.chainId);
      send(sol, c, first.chainId);
      assert.deepEqual(owedTo(c), [opus], "Opus never answered");
    });

    it("takes any later word from the owed peer as the answer", () => {
      // After a poke (which closes the peer's chains) or a re-ask, the peer's
      // report arrives on a different chain and marks nothing.
      const c = `owed-c-${seq++}`;
      const i = `owed-i-${seq++}`;
      unanswered(c, i);
      send(i, c);
      assert.equal(owedTo(c), undefined);
    });

    it("takes no report that never reached the sender as the answer", () => {
      const c = `owed-c-${seq++}`;
      const i = `owed-i-${seq++}`;
      unanswered(c, i);
      // Cancelled before delivery...
      enqueueLater(i, c);
      store.cancelPending(c, "test", i);
      assert.deepEqual(owedTo(c), [i]);
      // ...or given up on after its retries: neither reached C.
      const lost = enqueueLater(i, c);
      store.markFailed(lost.id, "gave up");
      assert.deepEqual(owedTo(c), [i]);
    });

    it("keeps owing a request whose correlated reply never landed", () => {
      // A correlated reply marks the request `replied` when it is QUEUED.
      for (const lose of ["cancel", "fail"] as const) {
        const c = `owed-c-${seq++}`;
        const p = `owed-p-${seq++}`;
        const request = unanswered(c, p);
        const reply = store.enqueueRouted({
          conversationId: `reply-${seq++}`,
          chainId: request.chainId,
          fallbackChainId: `reply-fallback-${seq++}`,
          senderSessionId: p,
          recipientSessionId: c,
          prompt: "my report",
          responseRequested: false,
          markRepliedId: request.id,
          participants: [p, c],
          maxHops: 100,
        });
        assert.equal(store.getById(request.id)?.status, "replied");
        // Still on its way: the sender has queued work, so nothing stalls.
        assert.equal(owedTo(c), undefined);
        if (lose === "cancel") store.cancelPending(c, "test", p);
        else store.markFailed(reply.id, "gave up");
        assert.deepEqual(owedTo(c), [p], `${lose}: the answer never arrived`);
      }
    });

    it("seeks an index for both answer checks, never scanning the inbox", () => {
      const plan = getDb()
        .prepare(`EXPLAIN QUERY PLAN ${OUTSTANDING_REPLIES_SQL}`)
        .all() as { detail: string }[];
      const details = plan.map((step) => step.detail).join("\n");
      assert.match(details, /peer_prompts_recipient_sender_seq_idx/);
      assert.match(details, /peer_prompts_recipient_chain_seq_idx/);
      assert.match(details, /peer_prompts_replied_by_idx/);
    });

    it("still counts a request when later traffic came from someone else", () => {
      const c = `owed-c-${seq++}`;
      const i = `owed-i-${seq++}`;
      unanswered(c, i);
      send(`owed-other-${seq++}`, c);
      assert.deepEqual(owedTo(c), [i]);
    });
  });

  it("completes terminally when no response is requested", () => {
    const m = enqueue(`r-${seq++}`, { responseRequested: false });
    store.claimNext(m.recipientSessionId, "d", 1000);
    store.markAdmitted(m.id);
    assert.equal(store.markCompleted(m.id)?.status, "completed");
  });

  it("lists dispatching rows read-only, and applyRecoveryDecisions moves them atomically to their decided status", () => {
    const m = enqueue(`r-${seq++}`);
    store.claimNext(m.recipientSessionId, "d", 60_000);
    const dispatching = store.listDispatching();
    assert.equal(
      dispatching.some((r) => r.id === m.id),
      true,
    );
    assert.equal(
      store.getById(m.id)?.status,
      "dispatching",
      "listDispatching must not mutate status",
    );

    const applied = store.applyRecoveryDecisions(
      [{ id: m.id, toStatus: "queued" }],
      "reason",
      "restart",
    );
    assert.equal(
      applied.some((r) => r.id === m.id),
      true,
    );
    assert.equal(store.getById(m.id)?.status, "queued");
  });

  it("applyRecoveryDecisions moves a dispatching row DIRECTLY to interrupted (never through an intermediate queued commit) and restores batch_head_id atomically", () => {
    const m = enqueue(`r-${seq++}`);
    store.claimNext(m.recipientSessionId, "d", 60_000);
    const applied = store.applyRecoveryDecisions(
      [{ id: m.id, toStatus: "interrupted", batchHeadId: m.id }],
      "already delivered",
      "restart",
    );
    assert.equal(applied[0]?.status, "interrupted");
    assert.equal(store.getById(m.id)?.batchHeadId, m.id);
    // The transition history must go straight dispatching -> interrupted, with no intermediate "queued" entry.
    assert.deepEqual(
      store.getById(m.id)?.transitions.map((t) => t.to),
      ["queued", "dispatching", "interrupted"],
    );
  });

  it("requeues only expired leases", () => {
    const m = enqueue(`r-${seq++}`);
    store.claimNext(m.recipientSessionId, "d", -1); // already expired
    const requeued = store.requeueExpiredLeases();
    assert.equal(
      requeued.some((r) => r.id === m.id),
      true,
    );
  });

  it("enqueueRouted reserves the hop, adds participants, and inserts in one transaction", () => {
    const chainId = `rt-${seq++}`;
    const m = store.enqueueRouted({
      conversationId: "c",
      chainId,
      senderSessionId: "A",
      recipientSessionId: "B",
      participants: ["A", "B"],
      maxHops: 8,
      prompt: "hi",
      responseRequested: false,
    });
    assert.equal(m.hop, 1);
    assert.equal(store.getChain(chainId)?.nextHop, 2);
    assert.deepEqual(store.participantsOf(chainId).sort(), ["A", "B"]);
  });

  it("enqueueRouted rejects over-limit without consuming a hop or persisting a message", () => {
    const chainId = `lim-${seq++}`;
    store.createChain(chainId);
    for (let i = 0; i < 3; i++) store.reserveHop(chainId); // next_hop -> 4
    const before = store.getChain(chainId)!.nextHop;
    assert.throws(
      () =>
        store.enqueueRouted({
          conversationId: "c",
          chainId,
          senderSessionId: "A",
          recipientSessionId: "B",
          participants: ["A", "B"],
          maxHops: 3,
          prompt: "hi",
          responseRequested: false,
        }),
      PeerPromptHopLimitError,
    );
    assert.equal(
      store.getChain(chainId)!.nextHop,
      before,
      "rejected send must not consume a hop",
    );
    assert.equal(
      store.listByChain(chainId).length,
      0,
      "rejected send must not persist a message",
    );
  });

  it("allows retryable/interrupted transitions from acknowledged (busy-race / crash)", () => {
    const m = enqueue(`r-${seq++}`);
    store.claimNext(m.recipientSessionId, "d", 1000);
    store.markAdmitted(m.id);
    store.markAcknowledged(m.id);
    assert.equal(
      store.markRetryable(m.id, "provider failed", 5000)?.status,
      "retryable_failed",
    );
    const m2 = enqueue(`r-${seq++}`);
    store.claimNext(m2.recipientSessionId, "d", 1000);
    store.markAdmitted(m2.id);
    store.markAcknowledged(m2.id);
    assert.equal(
      store.markInterrupted(m2.id, "crash", "restart")?.status,
      "interrupted",
    );
  });

  it("requeues due retries and leaves not-yet-due rows alone", () => {
    const m1 = enqueue(`r-${seq++}`);
    store.claimNext(m1.recipientSessionId, "d", 1000);
    store.markAdmitted(m1.id);
    store.markAcknowledged(m1.id);
    store.markRetryable(m1.id, "boom", -1); // already due (backoff in the past)
    const m2 = enqueue(`r-${seq++}`);
    store.claimNext(m2.recipientSessionId, "d", 1000);
    store.markAdmitted(m2.id);
    store.markAcknowledged(m2.id);
    store.markRetryable(m2.id, "boom", 60_000); // not due yet

    // The store is shared across this file: a retry an earlier test scheduled
    // a few seconds out may have come due by now, so judge only this test's rows.
    const requeued = store
      .requeueDueRetries(Date.now())
      .map((r) => r.id)
      .filter((id) => id === m1.id || id === m2.id);
    assert.deepEqual(requeued, [m1.id]);
    assert.equal(store.getById(m1.id)?.status, "queued");
    assert.equal(store.getById(m1.id)?.nextAttemptAt, undefined);
    assert.equal(
      store.getById(m2.id)?.status,
      "retryable_failed",
      "not-due row is untouched",
    );
  });

  it("keeps failureReason while queued/retrying but clears it on successful admission", () => {
    const m = enqueue(`r-${seq++}`);
    store.claimNext(m.recipientSessionId, "d", 1000);
    store.markRetryable(m.id, "transient failure", -1); // already due
    assert.equal(store.getById(m.id)?.failureReason, "transient failure");

    const requeued = store.requeueDueRetries(Date.now());
    assert.equal(requeued[0]?.id, m.id);
    assert.equal(store.getById(m.id)?.status, "queued");
    assert.equal(
      store.getById(m.id)?.failureReason,
      "transient failure",
      "kept while queued/retrying",
    );

    store.claimNext(m.recipientSessionId, "d2", 1000);
    assert.equal(
      store.getById(m.id)?.failureReason,
      "transient failure",
      "kept through re-claim",
    );
    const admitted = store.markAdmitted(m.id);
    assert.equal(
      admitted?.failureReason,
      undefined,
      "cleared the moment admission succeeds",
    );
    assert.equal(store.getById(m.id)?.failureReason, undefined);
  });

  it("records a bounded transition audit trail", () => {
    const m = enqueue(`r-${seq++}`);
    store.claimNext(m.recipientSessionId, "d", 1000);
    store.markAdmitted(m.id);
    store.markAcknowledged(m.id);
    store.markCompleted(m.id);
    const after = store.getById(m.id)!;
    assert.deepEqual(
      after.transitions.map((t) => t.to),
      ["queued", "dispatching", "admitted", "acknowledged", "completed"],
    );
    assert.ok(after.transitions.every((t) => typeof t.at === "number"));
  });

  it("enqueueRouted reroutes to the fallback chain atomically when the preferred chain is closed, and marks a reply atomically", () => {
    const closedChain = `closed-${seq++}`;
    store.createChain(closedChain);
    store.closeChainsForSession("nobody"); // no-op, just exercise the API shape
    // Manually close via participant + closeChainsForSession.
    store.addParticipant(closedChain, "P");
    store.closeChainsForSession("P");
    assert.equal(store.getChain(closedChain)?.closed, true);

    const original = store.enqueueRouted({
      conversationId: "orig-conv",
      chainId: `open-${seq++}`,
      senderSessionId: "other",
      recipientSessionId: "me",
      participants: ["other", "me"],
      maxHops: 8,
      prompt: "need input",
      responseRequested: true,
    });
    store.claimNext("me", "d", 1000);
    store.markAdmitted(original.id);

    const fallback = `fallback-${seq++}`;
    const reply = store.enqueueRouted({
      conversationId: "orig-conv",
      chainId: closedChain,
      fallbackChainId: fallback,
      senderSessionId: "me",
      recipientSessionId: "other",
      participants: ["me", "other"],
      maxHops: 8,
      prompt: "here you go",
      responseRequested: false,
      markRepliedId: original.id,
    });
    assert.equal(
      reply.chainId,
      fallback,
      "rerouted to the fallback chain atomically",
    );
    assert.equal(reply.hop, 1, "fallback chain starts fresh");
    assert.equal(
      store.getById(original.id)?.status,
      "replied",
      "reply marked atomically with the enqueue",
    );
  });

  it("reserves distinct hops atomically and closes chains for a participant", () => {
    const chainId = store.createChain();
    const hops = [
      store.reserveHop(chainId),
      store.reserveHop(chainId),
      store.reserveHop(chainId),
    ];
    assert.deepEqual(hops, [1, 2, 3]);
    store.addParticipant(chainId, "p1");
    store.addParticipant(chainId, "p2");
    const closed = store.closeChainsForSession("p1");
    assert.deepEqual(closed, [chainId]);
    assert.equal(store.getChain(chainId)?.closed, true);
    // Idempotent: already closed => nothing to close.
    assert.deepEqual(store.closeChainsForSession("p2"), []);
  });

  it("finds unreplied response-requested messages between two sessions", () => {
    const recipient = `r-${seq++}`;
    const sender = `s-${seq++}`;
    const m = enqueue(recipient, { sender, responseRequested: true });
    store.claimNext(recipient, "d", 1000);
    store.markAdmitted(m.id);
    const found = store.unrepliedRequestsBetween(sender, recipient);
    assert.equal(
      found.some((f) => f.id === m.id),
      true,
    );
    store.markReplied(m.id, "x");
    assert.equal(
      store
        .unrepliedRequestsBetween(sender, recipient)
        .some((f) => f.id === m.id),
      false,
    );
  });

  it("expires unresolved rows past their expiry and prunes only terminal rows", () => {
    const recipient = `r-${seq++}`;
    const m = enqueue(recipient, {
      responseRequested: true,
      expiresAt: Date.now() - 1000,
    });
    store.claimNext(recipient, "d", 1000);
    store.markAdmitted(m.id);
    store.markCompleted(m.id); // -> awaiting_response
    assert.equal(store.getById(m.id)?.status, "awaiting_response");
    const expired = store.expireUnresolved(Date.now());
    assert.equal(expired.length, 1);
    assert.equal(expired[0]?.id, m.id);
    assert.equal(store.getById(m.id)?.status, "expired");
    assert.deepEqual(
      store
        .getById(m.id)
        ?.transitions.map((t) => t.to)
        .slice(-1),
      ["expired"],
    );
    // Prune terminal rows older than now+1; the expired row qualifies, an unresolved one never does.
    const unresolved = enqueue(`r-${seq++}`);
    const pruned = store.pruneTerminal(Date.now() + 10_000);
    assert.ok(pruned >= 1);
    assert.equal(store.getById(unresolved.id)?.status, "queued");
  });

  it("markDeliveryBatch records the batch's head id on every member without an audited transition, and listByBatchHead finds them all", () => {
    const recipient = `r-${seq++}`;
    const m1 = enqueue(recipient);
    const m2 = enqueue(recipient);
    const m3 = enqueue(recipient);
    assert.equal(
      store.getById(m1.id)?.batchHeadId,
      undefined,
      "unset until markDeliveryBatch runs",
    );

    store.markDeliveryBatch([m1.id, m2.id], m1.id);
    assert.equal(store.getById(m1.id)?.batchHeadId, m1.id);
    assert.equal(store.getById(m2.id)?.batchHeadId, m1.id);
    assert.equal(
      store.getById(m3.id)?.batchHeadId,
      undefined,
      "an unrelated row must not be swept in",
    );
    // Not a status transition: no audit entry is appended.
    assert.deepEqual(
      store.getById(m1.id)?.transitions.map((t) => t.to),
      ["queued"],
    );

    const members = store.listByBatchHead(recipient, m1.id);
    assert.deepEqual(members.map((m) => m.id).sort(), [m1.id, m2.id].sort());
  });
});
