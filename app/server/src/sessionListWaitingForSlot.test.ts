/**
 * The session list says which directly spawned children wait for a slot, and
 * where in their coordinator's queue, and it keeps every recorded child listed
 * from creation on, even without a message ([Task-967](pa://task/967)).
 *   pnpm --filter @assistant/server test src/sessionListWaitingForSlot.test.ts
 */
import assert from "node:assert/strict";
import { afterEach, test } from "vitest";
import { directPeerChildStore } from "./db/directPeerChildStore.ts";
import { peerPromptStore } from "./db/peerPromptStore.ts";
import { sessionStore } from "./db/sessionStore.ts";
import { waitingPositionOf } from "./heldDirectPeers.ts";
import { admitDirectPeerTurns } from "./peerSpawnRuntimes.ts";
import { listSessions } from "./sessions.ts";

let n = 0;
const created: string[] = [];

function session(
  label: string,
  fields: { messageCount?: number; purpose?: string } = {},
): string {
  const id = `waiting-list-${label}-${Date.now()}-${n++}`;
  sessionStore.upsert({
    id,
    harness: "pi",
    agentType: "developer",
    title: label,
    scope: "user",
    messageCount: fields.messageCount ?? 0,
    ...(fields.purpose ? { purpose: fields.purpose } : {}),
  });
  created.push(id);
  return id;
}

function record(spawner: string, child: string): void {
  sessionStore.linkSpawned(spawner, child);
  directPeerChildStore.record({
    childSessionId: child,
    spawnerSessionId: spawner,
    costClass: "counted",
    source: { kind: "profile", profileId: "pr_test" },
    provider: "fake",
    modelId: "fake-model",
    thinkingLevel: "medium",
    credentialProfileId: "fake-acct",
    createdAt: Date.now(),
  });
}

/** A recorded child of `spawner` whose opening prompt waits at `queueSeq`. */
function waitingChild(
  spawner: string,
  label: string,
  queueSeq = peerPromptStore.allocateQueueSeq(),
): { child: string; rowId: string } {
  const child = session(label);
  record(spawner, child);
  const row = peerPromptStore.enqueueRouted({
    conversationId: `conv-${child}`,
    chainId: peerPromptStore.createChain(),
    senderSessionId: spawner,
    recipientSessionId: child,
    participants: [spawner, child],
    maxHops: 10,
    prompt: `start ${label}`,
    responseRequested: false,
    held: { queueSeq },
  });
  return { child, rowId: row.id };
}

async function rows(onlyIds?: Set<string>) {
  const list = await listSessions(
    [],
    () => Date.now(),
    onlyIds ? { onlyIds } : {},
  );
  return new Map(list.map((row) => [row.id, row]));
}

const positions = async (ids: string[]) => {
  const list = await rows();
  return ids.map((id) => list.get(id)?.waitingForSlot?.position);
};

afterEach(() => {
  for (const id of created.splice(0)) sessionStore.remove(id);
});

test("waiting children are listed with their position, and stay listed once started, refused or cancelled", async () => {
  const spawner = session("spawner", { messageCount: 3 });
  const a = waitingChild(spawner, "a");
  const b = waitingChild(spawner, "b");
  const c = waitingChild(spawner, "c");

  let list = await rows();
  assert.equal(list.get(spawner)?.waitingForSlot, undefined);
  for (const [child, position] of [
    [a.child, 1],
    [b.child, 2],
    [c.child, 3],
  ] as const) {
    assert.deepEqual(list.get(child)?.waitingForSlot, { position }, child);
    assert.equal(list.get(child)?.queuedWork, true);
    assert.equal(list.get(child)?.messageCount, 0);
    assert.equal(list.get(child)?.spawnedBySessionId, spawner);
  }

  assert.ok(peerPromptStore.promoteHeld(a.rowId, null));
  assert.deepEqual(await positions([a.child, b.child, c.child]), [
    undefined,
    1,
    2,
  ]);

  assert.ok(peerPromptStore.refuseHeld(b.rowId, "Not started.", () => {}));
  assert.ok(peerPromptStore.cancelOne(c.rowId, "Withdrawn."));
  list = await rows();
  for (const child of [a.child, b.child, c.child]) {
    assert.ok(list.has(child), `${child} stays listed`);
    assert.equal(list.get(child)?.waitingForSlot, undefined);
  }

  // A one-row refresh derives the same field as the full list.
  const d = waitingChild(spawner, "d");
  const only = await rows(new Set([d.child]));
  assert.deepEqual(only.get(d.child)?.waitingForSlot, { position: 1 });
  assert.deepEqual((await rows()).get(d.child)?.waitingForSlot, {
    position: 1,
  });
});

test("only drafts and recorded children are listed without a message", async () => {
  const spawner = session("spawner", { messageCount: 1 });
  const bootstrap = session("bootstrap");
  const unrecorded = session("unrecorded child");
  sessionStore.linkSpawned(spawner, unrecorded);
  const draft = session("draft", { purpose: "draft" });
  const recorded = session("recorded child");
  record(spawner, recorded);

  const list = await rows();
  assert.equal(list.has(bootstrap), false);
  assert.equal(list.has(unrecorded), false);
  assert.equal(list.has(draft), true);
  assert.equal(list.has(recorded), true);
  assert.equal(list.get(recorded)?.waitingForSlot, undefined);
});

test("positions count per coordinator, older in-flight rows included, the same as the spawn result", async () => {
  const s = session("s", { messageCount: 1 });
  const t = session("t", { messageCount: 1 });
  const s1 = waitingChild(s, "s1");
  const t1 = waitingChild(t, "t1");
  const s2 = waitingChild(s, "s2");
  const t2 = waitingChild(t, "t2");
  const expectBoth = async (
    expected: [string, string, number | undefined][],
  ) => {
    const list = await rows();
    for (const [spawner, child, position] of expected) {
      assert.equal(
        list.get(child)?.waitingForSlot?.position,
        position,
        `${child} in the list`,
      );
      assert.equal(
        waitingPositionOf(spawner, child),
        position,
        `${child} in the spawn result`,
      );
    }
  };
  await expectBoth([
    [s, s1.child, 1],
    [s, s2.child, 2],
    [t, t1.child, 1],
    [t, t2.child, 2],
  ]);

  // S already waits, so a new batch for it is admitted to wait: its ticket is
  // older than the row inserted after it, which counts the row being created.
  const claim = await admitDirectPeerTurns(s, ["counted"]);
  const ticket = claim.rows[0];
  assert.ok(ticket && "holdSeq" in ticket);
  try {
    const younger = waitingChild(s, "younger");
    assert.ok(peerPromptStore.cancelOne(s1.rowId, "Withdrawn."));
    assert.ok(peerPromptStore.cancelOne(s2.rowId, "Withdrawn."));
    await expectBoth([
      [s, s1.child, undefined],
      [s, younger.child, 2],
      [t, t1.child, 1],
    ]);
    claim.settleHold(ticket.holdSeq);
    await expectBoth([[s, younger.child, 1]]);
  } finally {
    claim.settleHold(ticket.holdSeq);
    claim.release();
  }
});
