/**
 * The settle ROUND TRIP, through the real command: one tab settles, and the
 * authoritative row reaches every subscribed tab (Task-674). Cross-tab
 * convergence is the acceptance criterion here — the client-side half (the
 * browser applying that row) lives in `app/web/src/sessionSettleScenario.test.tsx`.
 *   pnpm --filter @assistant/server test src/settleSessionBroadcast.test.ts
 */
import assert from "node:assert/strict";
import { test } from "vitest";
import type {
  ClientMessage,
  ServerMessage,
  SessionListItem,
} from "@assistant/shared";
import { Connection } from "./connection.ts";
import { hub } from "./hub.ts";
import { peerPromptStore } from "./db/peerPromptStore.ts";
import { sessionStore } from "./db/sessionStore.ts";

/** Minimal open socket: `Connection` only reads `readyState`/`OPEN` and sends. */
function fakeSocket(sent: ServerMessage[]) {
  return {
    OPEN: 1,
    readyState: 1,
    send: (raw: string) => sent.push(JSON.parse(raw) as ServerMessage),
  } as unknown as ConstructorParameters<typeof Connection>[0];
}

/** The session broadcast is debounced (`hub.flushSessionsBroadcast`). */
const settled = () => hub.flushPendingBroadcastsForTests();

/** The newest row this listener saw for the session, from a list or a delta. */
function rowFor(
  messages: ServerMessage[],
  id: string,
): SessionListItem | undefined {
  for (const message of [...messages].reverse()) {
    if (message.type === "sessionUpdated" && message.session.id === id)
      return message.session;
    if (message.type === "sessions") {
      const row = message.sessions.find((session) => session.id === id);
      if (row) return row;
    }
  }
  return undefined;
}

test("settling in one tab reaches every other subscribed tab", async () => {
  const id = `settle-broadcast-${Date.now()}`;
  sessionStore.upsert({
    id,
    harness: "pi",
    agentType: "assistant",
    title: "A direct session",
    messageCount: 4,
  });
  const revision = sessionStore.recordSessionOutcome(id, "completed");
  assert.equal(revision, 1, "the session has one unacknowledged outcome");

  const clicked: ServerMessage[] = [];
  const connection = new Connection(fakeSocket(clicked));
  // The OTHER tab: an ordinary registered listener, exactly as `hub.register`
  // holds every open connection.
  const otherTab: ServerMessage[] = [];
  hub.register({ send: (message: ServerMessage) => otherTab.push(message) });

  try {
    await connection.handle({
      type: "settleSession",
      id,
      settled: true,
      throughRevision: 1,
      requestId: "req-settle",
    } as ClientMessage);
    await settled();

    assert.equal(
      clicked.some((message) => message.type === "error"),
      false,
      "the settle was accepted",
    );
    assert.equal(sessionStore.isSettled(id), true, "and it is durable");

    const seen = rowFor(otherTab, id);
    assert.ok(seen, "the other tab was told about the session");
    assert.ok(seen.settledAt, "it sees the row as settled");
    assert.equal(
      seen.outcomeAttention?.settledRevision,
      1,
      "carrying the revision that was acknowledged, so its own Settle has an anchor",
    );

    // The other direction: a new outcome wakes the session for BOTH tabs
    // without either of them doing anything.
    otherTab.length = 0;
    sessionStore.recordSessionOutcome(id, "failed");
    await hub.broadcastSessions();
    await settled();

    const woken = rowFor(otherTab, id);
    assert.ok(woken, "the other tab was told again");
    assert.equal(
      woken.settledAt,
      undefined,
      "the unacknowledged failure takes the row back into the working set",
    );
    assert.equal(woken.outcomeAttention?.kind, "failed");
    assert.equal(woken.outcomeAttention?.revision, 2);
  } finally {
    connection.dispose();
    sessionStore.remove(id);
  }
});

/**
 * The cascade: settling a coordinator settles the peers it still owns over
 * `coordinator` spawn edges, through their current revisions, in the same
 * command — and a peer the shared predicate blocks refuses the whole thing
 * before anything is written.
 */
test("settling a coordinator settles the peers it still coordinates", async () => {
  const stamp = Date.now();
  const coordinator = `settle-cluster-root-${stamp}`;
  const peer = `settle-cluster-peer-${stamp}`;
  const grandchild = `settle-cluster-deep-${stamp}`;
  const takenOver = `settle-cluster-own-${stamp}`;
  for (const [id, title] of [
    [coordinator, "Coordinator"],
    [peer, "Peer"],
    [grandchild, "Grandchild"],
    [takenOver, "Taken over"],
  ] as const)
    sessionStore.upsert({
      id,
      harness: "pi",
      agentType: "assistant",
      title,
      messageCount: 2,
    });
  sessionStore.linkSpawned(coordinator, peer);
  sessionStore.linkSpawned(peer, grandchild);
  sessionStore.linkSpawned(coordinator, takenOver);
  sessionStore.markSpawnedTakenOver(takenOver);
  assert.equal(sessionStore.recordSessionOutcome(coordinator, "completed"), 1);
  assert.equal(sessionStore.recordSessionOutcome(takenOver, "completed"), 1);

  const clicked: ServerMessage[] = [];
  const connection = new Connection(fakeSocket(clicked));
  const otherTab: ServerMessage[] = [];
  hub.register({ send: (message: ServerMessage) => otherTab.push(message) });

  try {
    await connection.handle({
      type: "settleSession",
      id: coordinator,
      settled: true,
      throughRevision: 1,
      requestId: "req-settle-cluster",
    } as ClientMessage);
    await settled();

    assert.equal(
      clicked.some((message) => message.type === "error"),
      false,
      "the settle was accepted",
    );
    assert.equal(sessionStore.isSettled(coordinator), true);
    assert.equal(
      sessionStore.isSettled(peer),
      true,
      "the coordinated peer left with it",
    );
    assert.equal(
      sessionStore.isSettled(grandchild),
      true,
      "at every depth the inbox folds",
    );
    assert.equal(
      sessionStore.isSettled(takenOver),
      false,
      "a peer the user took over is their own and stays",
    );
    assert.ok(
      rowFor(otherTab, peer)?.settledAt,
      "the other tab sees the peer shelved",
    );
  } finally {
    connection.dispose();
    for (const id of [coordinator, peer, grandchild, takenOver])
      sessionStore.remove(id);
  }
});

test("a coordinated peer that still needs the user refuses the coordinator's settle", async () => {
  const stamp = Date.now();
  const coordinator = `settle-cluster-blocked-root-${stamp}`;
  const peer = `settle-cluster-blocked-peer-${stamp}`;
  for (const [id, title] of [
    [coordinator, "Coordinator"],
    [peer, "Peer"],
  ] as const)
    sessionStore.upsert({
      id,
      harness: "pi",
      agentType: "assistant",
      title,
      messageCount: 2,
    });
  sessionStore.linkSpawned(coordinator, peer);
  sessionStore.recordSessionOutcome(coordinator, "completed");
  // A peer prompt queued behind the peer's next turn: the one blocker that is
  // durable state alone, projected onto the row as `queuedWork` — the same row
  // the browser disables the cluster's Settle from.
  const chainId = peerPromptStore.createChain(`settle-cluster-chain-${stamp}`);
  peerPromptStore.enqueue({
    conversationId: `settle-cluster-conv-${stamp}`,
    chainId,
    hop: peerPromptStore.reserveHop(chainId),
    senderSessionId: coordinator,
    recipientSessionId: peer,
    prompt: "keep going",
    responseRequested: false,
  });

  const clicked: ServerMessage[] = [];
  const connection = new Connection(fakeSocket(clicked));
  try {
    await connection.handle({
      type: "settleSession",
      id: coordinator,
      settled: true,
      throughRevision: 1,
      requestId: "req-settle-cluster-blocked",
    } as ClientMessage);
    await settled();

    const error = clicked.find((message) => message.type === "error");
    assert.ok(error, "the settle was refused");
    assert.equal(
      error.message,
      "Failed to settle session: work is queued behind it.",
      "in the peer's own wording",
    );
    assert.equal(
      sessionStore.isSettled(coordinator),
      false,
      "and nothing was written, the coordinator included",
    );
    assert.equal(sessionStore.isSettled(peer), false);
  } finally {
    peerPromptStore.cancelPending(peer, "test cleanup");
    connection.dispose();
    for (const id of [coordinator, peer]) sessionStore.remove(id);
  }
});

test("the cascade is one transaction: a peer that cannot be written settles nothing", async () => {
  const stamp = Date.now();
  const coordinator = `settle-cluster-atomic-${stamp}`;
  sessionStore.upsert({
    id: coordinator,
    harness: "pi",
    agentType: "assistant",
    title: "Coordinator",
    messageCount: 2,
  });
  sessionStore.recordSessionOutcome(coordinator, "completed");
  try {
    assert.equal(
      sessionStore.settleWithPeers(coordinator, 1, [`${coordinator}-missing`]),
      false,
      "a peer row that does not exist refuses the batch",
    );
    assert.equal(
      sessionStore.isSettled(coordinator),
      false,
      "and the coordinator's own write was rolled back with it",
    );
    assert.equal(sessionStore.settleWithPeers(coordinator, 1, []), true);
    assert.equal(sessionStore.isSettled(coordinator), true);
  } finally {
    sessionStore.remove(coordinator);
  }
});
