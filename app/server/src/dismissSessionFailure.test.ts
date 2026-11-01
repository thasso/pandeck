/**
 * `dismissSessionFailure`, through the real command: the wire shape, the
 * failure leaving every subscribed tab's row, and everything a Settle would
 * have touched staying exactly where it was. The store's identity rules are
 * pinned in `db/sessionStore.test.ts`; the browser's half lives in
 * `app/web/src/sessionSettleScenario.test.tsx`.
 *   pnpm --filter @assistant/server test src/dismissSessionFailure.test.ts
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
import { sessionRowIn, sessionTopicViewer } from "./test/sessionListClient.ts";
import { peerPromptStore } from "./db/peerPromptStore.ts";
import { sessionStore } from "./db/sessionStore.ts";
import {
  SESSION_AUTO_ARCHIVE_AFTER_MS,
  selectSettledArchiveCandidates,
} from "./sessionRetention.ts";
import { validateClientMessage } from "./validateClientMessage.ts";

/** Minimal open socket: `Connection` only reads `readyState`/`OPEN` and sends. */
function fakeSocket(sent: ServerMessage[]) {
  return {
    OPEN: 1,
    readyState: 1,
    send: (raw: string) => sent.push(JSON.parse(raw) as ServerMessage),
  } as unknown as ConstructorParameters<typeof Connection>[0];
}

/** Topic publications are debounced (`stateTopicKernel.ts`). */
const settled = () => hub.flushPendingBroadcastsForTests();

/** The newest row this listener saw for the session, from a list or a delta. */
function rowFor(
  messages: ServerMessage[],
  id: string,
): SessionListItem | undefined {
  return sessionRowIn(messages, id) ?? undefined;
}

function seed(id: string, title: string): void {
  sessionStore.upsert({
    id,
    harness: "pi",
    agentType: "assistant",
    title,
    messageCount: 2,
  });
}

test("dismissSessionFailure requires the observed revision; the error time is optional", () => {
  const valid = (msg: Record<string, unknown>) =>
    validateClientMessage({ type: "dismissSessionFailure", ...msg }).ok;
  assert.equal(valid({ id: "s-1", errorAt: 5_000, outcomeRevision: 0 }), true);
  assert.equal(
    valid({ id: "s-1", outcomeRevision: 3 }),
    true,
    "a row showing an open failed outcome without an error record",
  );
  assert.equal(
    valid({ id: "s-1", errorAt: 5_000 }),
    false,
    "omitting the revision is refused, as on settleSession",
  );
  for (const bad of [-1, 1.5, "2", null, Number.NaN])
    assert.equal(
      valid({ id: "s-1", errorAt: bad, outcomeRevision: 0 }),
      false,
      `${String(bad)} is not an error time`,
    );
  assert.equal(valid({ errorAt: 5_000, outcomeRevision: 0 }), false);
});

test("dismissing a queued peer's failure settles nothing and reaches every tab", async () => {
  const stamp = Date.now();
  const coordinator = `dismiss-root-${stamp}`;
  const peer = `dismiss-peer-${stamp}`;
  seed(coordinator, "Coordinator");
  seed(peer, "Peer");
  sessionStore.linkSpawned(coordinator, peer);
  sessionStore.recordSessionOutcome(coordinator, "completed");
  sessionStore.recordRunFailure(peer, "boom", 5_000);
  // Queued work blocks the peer's Settle; it must not block the dismissal,
  // and the dismissal must not touch it.
  const chainId = peerPromptStore.createChain(`dismiss-chain-${stamp}`);
  peerPromptStore.enqueue({
    conversationId: `dismiss-conv-${stamp}`,
    chainId,
    hop: peerPromptStore.reserveHop(chainId),
    senderSessionId: coordinator,
    recipientSessionId: peer,
    prompt: "keep going",
    responseRequested: false,
  });

  const clicked: ServerMessage[] = [];
  const connection = new Connection(fakeSocket(clicked));
  const otherTab: ServerMessage[] = [];
  hub.register(sessionTopicViewer(otherTab));
  try {
    const before = hub.listSessions().find((row) => row.id === peer);
    assert.equal(before?.queuedWork, true);
    assert.equal(before?.lastError?.at, 5_000);

    await connection.handle({
      type: "dismissSessionFailure",
      id: peer,
      errorAt: 5_000,
      outcomeRevision: 0,
      requestId: "req-dismiss",
    } as ClientMessage);
    await settled();

    assert.equal(
      clicked.some((message) => message.type === "error"),
      false,
      "the dismissal was accepted",
    );
    const seen = rowFor(otherTab, peer);
    assert.ok(seen, "the other tab was told about the peer");
    assert.equal(seen.lastError, undefined, "without its failure");
    assert.equal(seen.queuedWork, true, "its queued work untouched");
    assert.equal(seen.settledAt, undefined, "and not settled");
    assert.equal(sessionStore.isSettled(peer), false);
    assert.equal(sessionStore.isSettled(coordinator), false);
    assert.equal(
      sessionStore.get(coordinator)?.outcomeAttention?.settledRevision,
      0,
      "the coordinator's own outcome is still the user's to acknowledge",
    );
    assert.equal(peerPromptStore.listPendingForRecipient(peer).length, 1);
  } finally {
    peerPromptStore.cancelPending(peer, "test cleanup");
    connection.dispose();
    for (const id of [coordinator, peer]) sessionStore.remove(id);
  }
});

test("a stale click is refused, and the newer failure re-sent to it", async () => {
  const id = `dismiss-stale-${Date.now()}`;
  seed(id, "Direct");
  sessionStore.recordRunFailure(id, "boom", 5_000);
  sessionStore.recordSessionOutcome(id, "failed", 5_001);
  // A second failure the click never rendered.
  sessionStore.recordRunFailure(id, "again", 6_000);
  sessionStore.recordSessionOutcome(id, "failed", 6_001);

  const clicked: ServerMessage[] = [];
  const connection = new Connection(fakeSocket(clicked));
  // Every registered tab, the clicking one included, is re-sent the row.
  const tabs: ServerMessage[] = [];
  hub.register(sessionTopicViewer(tabs));
  try {
    await connection.handle({
      type: "dismissSessionFailure",
      id,
      errorAt: 5_000,
      outcomeRevision: 1,
    } as ClientMessage);
    await settled();

    const error = clicked.find((message) => message.type === "error");
    assert.ok(error, "the click is told");
    assert.match(error.message, /changed since it was shown/);
    const row = rowFor(tabs, id);
    assert.equal(row?.lastError?.message, "again", "with the newer failure");
    assert.equal(row?.outcomeAttention?.revision, 2);
    assert.equal(row?.outcomeAttention?.settledRevision, 0);
  } finally {
    connection.dispose();
    sessionStore.remove(id);
  }
});

test("dismissing a failure from an old shelf keeps the session active and out of retention", async () => {
  const id = `dismiss-shelf-${Date.now()}`;
  const now = Date.now();
  seed(id, "Old shelf");
  // Settled long ago, then run from the shelf and failed.
  sessionStore.setSettled(id, true, now - 30 * 24 * 60 * 60 * 1000);
  sessionStore.recordRunFailure(id, "boom", 5_000);
  sessionStore.recordSessionOutcome(id, "failed", 5_001);

  const clicked: ServerMessage[] = [];
  const connection = new Connection(fakeSocket(clicked));
  try {
    await connection.handle({
      type: "dismissSessionFailure",
      id,
      errorAt: 5_000,
      outcomeRevision: 1,
    } as ClientMessage);
    await settled();
    assert.equal(
      clicked.some((message) => message.type === "error"),
      false,
    );

    const rows = hub.listSessions();
    const row = rows.find((candidate) => candidate.id === id);
    assert.ok(row);
    assert.equal(row.lastError, undefined);
    assert.equal(row.outcomeAttention?.settledRevision, 1);
    assert.equal(row.settledAt, undefined, "not back on the old shelf");
    assert.equal(
      selectSettledArchiveCandidates(rows, {
        now: now + SESSION_AUTO_ARCHIVE_AFTER_MS,
        viewed: new Set(),
        runOwned: new Set(),
      }).includes(id),
      false,
      "and not retention-eligible",
    );
  } finally {
    connection.dispose();
    sessionStore.remove(id);
  }
});
