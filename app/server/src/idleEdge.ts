/**
 * The order in which an idle session is offered what it is owed. Each step
 * treats a session that has started running as "not now", so the steps are
 * sequenced rather than raced: a step that won an unordered race would make
 * the ones ahead of it wait a whole turn they could have gone first in. Both
 * harness adapters publish the idle edge only after their provider primitive
 * has settled, so each step can start a turn at once, without steering or
 * being claimed by the turn that just ended.
 *
 * 1. Cards a session grant approves run first: each queues its outcome as a
 *    handoff, so the next step carries it to the agent in order.
 * 2. Handoffs — a card outcome the user decided while the session was
 *    mid-turn. It is the one thing waiting that the agent may be BLOCKED on,
 *    and the user is watching for it.
 * 3. The user's own queued messages (`promptQueue.ts`): what the user asked to
 *    happen after this turn, ahead of anything an agent queued.
 * 4. Background delivery, whose drain runs the peer FIFO and its owed notices
 *    first (`drainPeers`) and then offers completions that wake the session.
 * 5. A reminder of the peer requests the session has not answered
 *    (`peerPrompt.ts`), last: it gives way to anything above that is still
 *    owed when its turn is admitted, and offers the edge again afterwards.
 *
 * A Stop holds every automatic step (`automaticTurnHold.ts`); approvals still
 * EXECUTE under their grants, and only the turns that would tell the agent
 * wait. Resume offers the same chain again.
 */
export interface IdleEdgeSteps {
  runAutoApprovals(sessionId: string): Promise<unknown>;
  drainAgentHandoffs(sessionId: string): Promise<void>;
  drainPromptQueue(sessionId: string): Promise<void>;
  /**
   * The background step. `rerun` asks it to run again after a drain already
   * in flight rather than coalesce onto one that may have read an older state
   * (a Stop since lifted, a queue since emptied).
   */
  drainBackground(sessionId: string, rerun: boolean): Promise<void>;
  offerReplyReminders(sessionId: string): Promise<void>;
}

export interface IdleEdge {
  /** The whole chain. `resumed` after a Resume, whose hold the drain in flight may have read. */
  offer(sessionId: string, resumed?: boolean): void;
  /**
   * The chain behind the user's queue, for a queue that stopped holding the
   * edge without a turn of its own (it emptied, or paused on a failure).
   */
  offerAfterQueue(sessionId: string): void;
}

export function createIdleEdge(steps: IdleEdgeSteps): IdleEdge {
  const afterQueue = (sessionId: string, rerun: boolean): Promise<void> =>
    steps
      .drainBackground(sessionId, rerun)
      .catch(() => {})
      .then(() => steps.offerReplyReminders(sessionId))
      .catch(() => {});
  return {
    offer: (sessionId, resumed = false) => {
      void steps
        .runAutoApprovals(sessionId)
        .catch(() => {})
        .then(() => steps.drainAgentHandoffs(sessionId))
        .catch(() => {})
        .then(() => steps.drainPromptQueue(sessionId))
        .catch(() => {})
        .then(() => afterQueue(sessionId, resumed));
    },
    offerAfterQueue: (sessionId) => {
      void afterQueue(sessionId, true);
    },
  };
}
