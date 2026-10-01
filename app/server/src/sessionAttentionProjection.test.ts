/**
 * What a session ROW says about settlement once attention is event-based
 * (Task-674). The list projection is the only place the two durable halves —
 * the settlement mark and the attention revision — are combined, so this is
 * where "settled" is actually decided for every consumer.
 *   pnpm --filter @assistant/server test src/sessionAttentionProjection.test.ts
 */
import assert from "node:assert/strict";
import { afterEach, test } from "vitest";
import { sessionStore } from "./db/sessionStore.ts";
import { listSessions } from "./sessions.ts";

let n = 0;
const created: string[] = [];

function seed(): string {
  const id = `attention-${Date.now()}-${n++}`;
  sessionStore.upsert({
    id,
    harness: "pi",
    agentType: "assistant",
    title: "A direct session",
    messageCount: 4,
  });
  created.push(id);
  return id;
}

async function projected(id: string) {
  const rows = await listSessions([], () => 0);
  const row = rows.find((item) => item.id === id);
  assert.ok(row, "the session is listed");
  return row;
}

afterEach(() => {
  for (const id of created.splice(0)) sessionStore.remove(id);
});

test("an acknowledged session stays settled; an unacknowledged outcome takes it back", async () => {
  const id = seed();
  sessionStore.recordSessionOutcome(id, "completed", Date.now());
  sessionStore.setSettled(id, true, Date.now(), 1);

  const settled = await projected(id);
  assert.ok(settled.settledAt, "the row is settled");
  assert.equal(settled.unread, false, "and settling read it through");
  assert.deepEqual(
    {
      revision: settled.outcomeAttention?.revision,
      settledRevision: settled.outcomeAttention?.settledRevision,
      kind: settled.outcomeAttention?.kind,
    },
    { revision: 1, settledRevision: 1, kind: "completed" },
    "the acknowledged revision travels with the row, so the next Settle has an anchor",
  );

  sessionStore.recordSessionOutcome(id, "failed", Date.now());
  const woken = await projected(id);
  assert.equal(
    woken.settledAt,
    undefined,
    "a new outcome withholds settledAt rather than needing a second flag",
  );
  assert.equal(woken.outcomeAttention?.revision, 2);
  assert.equal(woken.outcomeAttention?.settledRevision, 1);
});

test("reading a session acknowledges nothing", async () => {
  const id = seed();
  sessionStore.recordSessionOutcome(id, "completed", Date.now());
  sessionStore.markRead(id, Date.now() + 1_000);

  const row = await projected(id);
  assert.equal(row.unread, false, "the transcript is read");
  assert.equal(
    row.outcomeAttention?.settledRevision,
    0,
    "but the completion is still waiting to be settled",
  );
  assert.equal(row.settledAt, undefined, "so the row is in the working set");
});

test("a stale settle acknowledges only what it saw", async () => {
  const id = seed();
  sessionStore.recordSessionOutcome(id, "completed", Date.now());
  sessionStore.recordSessionOutcome(id, "completed", Date.now());

  // A click on a card rendered when the session had one completion.
  assert.equal(sessionStore.setSettled(id, true, Date.now(), 1), true);
  const row = await projected(id);
  assert.equal(
    row.settledAt,
    undefined,
    "the newer completion is not hidden by a settle that never saw it",
  );
  assert.equal(row.outcomeAttention?.settledRevision, 1);

  assert.equal(sessionStore.setSettled(id, true, Date.now(), 2), true);
  assert.ok(
    (await projected(id)).settledAt,
    "settling what the refreshed card shows works",
  );
});
